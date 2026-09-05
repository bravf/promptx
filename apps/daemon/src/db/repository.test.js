import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from './database.js'
import { createRepository } from './repository.js'

function setup() {
  const db = openDatabase(':memory:')
  const repository = createRepository(db)
  const project = repository.createProject({ repositoryRoot: process.cwd(), displayName: '测试工作区' })
  const environment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
  const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '测试 Agent' })
  const agent = repository.createAgent(task.id, { providerId: 'codex' })
  return { db, repository, task, agent }
}

function providerTurn(sourceTurnId, localTurnId = '') {
  return { sourceTurnId, localTurnId, clientMessageId: `${sourceTurnId}:client`, status: 'completed' }
}

function row(sourceTurnId, providerMessageId, text = '完成') {
  return {
    sourceTurnId,
    providerMessageId,
    timestamp: '2026-09-04T00:00:00.000Z',
    item: { type: 'assistant_message', messageId: providerMessageId, phase: 'final_answer', text },
  }
}

test('导入 Agent 会保留原生句柄并支持按 Provider 去重', () => {
  const db = openDatabase(':memory:')
  const repository = createRepository(db)
  try {
    const project = repository.createProject({ repositoryRoot: process.cwd(), displayName: '导入测试' })
    const environment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
    const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '已有线程' })
    const agent = repository.createAgent(task.id, {
      providerId: 'codex',
      nativeHandle: { threadId: 'thread-imported' },
    })
    assert.deepEqual(repository.getAgent(agent.id).nativeHandle, { threadId: 'thread-imported' })
    assert.equal(repository.findAgentByProviderHandle('codex', { threadId: 'thread-imported' }).id, agent.id)
    assert.equal(repository.findAgentByProviderHandle('codex', { threadId: 'other' }), null)
  } finally {
    db.close()
  }
})

test('同步会把已有本地 Turn 回填原生 ID，不创建重复 Turn', () => {
  const { db, repository, task, agent } = setup()
  try {
    const local = repository.createTurn(task.id, 'browser-client-1')
    const before = repository.getTimelineState(task.id)
    const result = repository.applyTimelineSync(task.id, {
      mode: 'append',
      providerId: 'codex',
      sourceId: 'thread-1',
      manifest: { sourceId: 'thread-1', revision: '1', turns: [{ sourceTurnId: 'turn-1' }] },
      turns: [providerTurn('turn-1', local.id)],
      rows: [row('turn-1', 'message-1')],
      expectedNextSeq: before.nextSeq,
    })
    assert.equal(result.rows.length, 1)
    assert.equal(repository.listTurns(task.id).length, 1)
    assert.equal(repository.getTurn(local.id).nativeTurnId, 'turn-1')
    assert.equal(repository.listTimelineRows(task.id).length, 1)
  } finally {
    db.close()
  }
})

test('重复应用同一追加计划不会重复 Timeline 行', () => {
  const { db, repository, task } = setup()
  try {
    const input = {
      mode: 'append', providerId: 'claude', sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '1', turns: [] },
      turns: [], rows: [row('turn-1', 'message-1')],
    }
    const first = repository.applyTimelineSync(task.id, { ...input, expectedNextSeq: 1 })
    const second = repository.applyTimelineSync(task.id, { ...input, expectedNextSeq: 2 })
    assert.equal(first.rows.length, 1)
    assert.equal(second.rows.length, 0)
    assert.equal(repository.listTimelineRows(task.id).length, 1)
    assert.equal(repository.getTimelineState(task.id).nextSeq, 2)
  } finally {
    db.close()
  }
})

test('重建会切换 epoch 并清理被 Provider rewind 移除的 Turn', () => {
  const { db, repository, task } = setup()
  try {
    const old = repository.createTurn(task.id, 'old-client')
    repository.updateTurn(old.id, { status: 'completed', nativeTurnId: 'turn-old' })
    repository.applyTimelineSync(task.id, {
      mode: 'append', providerId: 'kimi', sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '1', turns: [{ sourceTurnId: 'turn-old' }] },
      turns: [providerTurn('turn-old', old.id)], rows: [row('turn-old', 'old-message')], expectedNextSeq: 1,
    })
    const before = repository.getTimelineState(task.id)
    const result = repository.applyTimelineSync(task.id, {
      mode: 'replace', providerId: 'kimi', sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '2', turns: [{ sourceTurnId: 'turn-new' }] },
      turns: [providerTurn('turn-new')], rows: [row('turn-new', 'new-message')], expectedNextSeq: before.nextSeq,
    })
    assert.notEqual(result.epoch, before.epoch)
    assert.equal(repository.listTimelineRows(task.id).length, 1)
    assert.equal(repository.listTurns(task.id).some((turn) => turn.nativeTurnId === 'turn-old'), false)
    assert.equal(repository.listTurns(task.id).some((turn) => turn.nativeTurnId === 'turn-new'), true)
  } finally {
    db.close()
  }
})

test('Timeline 发生并发写入时同步事务回滚并抛出 stale', () => {
  const { db, repository, task } = setup()
  try {
    assert.throws(() => repository.applyTimelineSync(task.id, {
      mode: 'append', providerId: 'codex', sourceId: 'thread-1', manifest: {}, turns: [], rows: [], expectedNextSeq: 99,
    }), (error) => error.code === 'TIMELINE_SYNC_STALE')
    assert.equal(repository.listTimelineRows(task.id).length, 0)
    assert.equal(repository.getTimelineState(task.id).nextSeq, 1)
  } finally {
    db.close()
  }
})
