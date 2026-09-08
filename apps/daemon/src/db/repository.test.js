import assert from 'node:assert/strict'
import path from 'node:path'
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
  return {
    sourceTurnId,
    providerPromptId: sourceTurnId,
    localTurnId,
    clientMessageId: `${sourceTurnId}:client`,
    status: 'completed',
    historyState: 'confirmed',
  }
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

test('同步会把已有本地 Turn 回填 Provider Prompt ID，不创建重复 Turn', () => {
  const { db, repository, task, agent } = setup()
  try {
    const local = repository.createTurn(task.id, 'browser-client-1')
    const before = repository.getTimelineState(task.id)
    const result = repository.applyTimelineSync(task.id, {
      mode: 'merge',
      providerId: 'codex',
      sourceId: 'thread-1',
      manifest: { sourceId: 'thread-1', revision: '1', turns: [{ sourceTurnId: 'turn-1' }] },
      turns: [providerTurn('turn-1', local.id)],
      rows: [row('turn-1', 'message-1')],
      expectedNextSeq: before.nextSeq,
    })
    assert.equal(result.rows.length, 1)
    assert.equal(repository.listTurns(task.id).length, 1)
    assert.equal(repository.getTurn(local.id).providerPromptId, 'turn-1')
    assert.equal(repository.getTurn(local.id).historyState, 'confirmed')
    assert.equal(repository.listTimelineRows(task.id).length, 1)
  } finally {
    db.close()
  }
})

test('重复应用同一追加计划不会重复 Timeline 行', () => {
  const { db, repository, task } = setup()
  try {
    const input = {
      mode: 'merge', providerId: 'claude', sourceId: 'session-1',
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

test('重建会切换 epoch，但 Provider rewind 不删除本地 Turn', () => {
  const { db, repository, task } = setup()
  try {
    const old = repository.createTurn(task.id, 'old-client')
    repository.updateTurn(old.id, { status: 'completed', nativeTurnId: 'turn-old' })
    repository.applyTimelineSync(task.id, {
      mode: 'merge', providerId: 'kimi', sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '1', turns: [{ sourceTurnId: 'turn-old' }] },
      turns: [providerTurn('turn-old', old.id)], rows: [row('turn-old', 'old-message')], expectedNextSeq: 1,
    })
    const before = repository.getTimelineState(task.id)
    const result = repository.applyTimelineSync(task.id, {
      mode: 'rebuild', providerId: 'kimi', sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '2', turns: [{ sourceTurnId: 'turn-new' }] },
      turns: [providerTurn('turn-new')], rows: [row('turn-new', 'new-message')], expectedNextSeq: before.nextSeq,
    })
    assert.notEqual(result.epoch, before.epoch)
    assert.equal(repository.listTimelineRows(task.id).length, 1)
    assert.equal(repository.listTurns(task.id).some((turn) => turn.providerPromptId === 'turn-old'), true)
    assert.equal(repository.listTurns(task.id).some((turn) => turn.providerPromptId === 'turn-new'), true)
  } finally {
    db.close()
  }
})

test('重建忽略删除提示并保留旧本地 Turn', () => {
  const { db, repository, task } = setup()
  try {
    const canonical = repository.createTurn(task.id, 'provider-client')
    repository.updateTurn(canonical.id, { status: 'completed', nativeTurnId: 'provider-turn' })
    const duplicate = repository.createTurn(task.id, 'browser-client')
    repository.updateTurn(duplicate.id, { status: 'completed', nativeTurnId: 'browser-client' })
    repository.appendTimeline(task.id, duplicate.id, {
      type: 'user_message',
      clientMessageId: 'browser-client',
      content: [{ type: 'text', text: '你好' }],
    })
    const before = repository.getTimelineState(task.id)

    repository.applyTimelineSync(task.id, {
      mode: 'rebuild',
      providerId: 'kimi',
      sourceId: 'session-1',
      manifest: { sourceId: 'session-1', revision: '2', turns: [{ sourceTurnId: 'provider-turn' }] },
      turns: [providerTurn('provider-turn', canonical.id)],
      rows: [row('provider-turn', 'answer-1')],
      dropLocalTurnIds: [duplicate.id],
      expectedNextSeq: before.nextSeq,
    })

    assert.equal(repository.getTurn(duplicate.id).id, duplicate.id)
    assert.deepEqual(new Set(repository.listTurns(task.id).map((turn) => turn.id)), new Set([canonical.id, duplicate.id]))
  } finally {
    db.close()
  }
})

test('Timeline 发生并发写入时同步事务回滚并抛出 stale', () => {
  const { db, repository, task } = setup()
  try {
    assert.throws(() => repository.applyTimelineSync(task.id, {
      mode: 'merge', providerId: 'codex', sourceId: 'thread-1', manifest: {}, turns: [], rows: [], expectedNextSeq: 99,
    }), (error) => error.code === 'TIMELINE_SYNC_STALE')
    assert.equal(repository.listTimelineRows(task.id).length, 0)
    assert.equal(repository.getTimelineState(task.id).nextSeq, 1)
  } finally {
    db.close()
  }
})

test('Provider 消息 ID 只在同一 Turn 内去重', () => {
  const { db, repository, task } = setup()
  try {
    const result = repository.applyTimelineSync(task.id, {
      mode: 'merge', providerId: 'codex', sourceId: 'thread-1', manifest: {},
      turns: [providerTurn('turn-1'), providerTurn('turn-2')],
      rows: [row('turn-1', 'agent_message:1', '第一轮'), row('turn-2', 'agent_message:1', '第二轮')],
      expectedNextSeq: 1,
    })
    assert.equal(result.rows.length, 2)
    assert.deepEqual(repository.listTimelineRows(task.id).map((entry) => entry.item.text), ['第一轮', '第二轮'])
  } finally {
    db.close()
  }
})

test('工作区归档不改会话状态，会话归档和恢复保留 Timeline、Agent 与执行环境', () => {
  const { db, repository, task, agent } = setup()
  try {
    repository.appendTimeline(task.id, null, { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: '完成' })
    const environment = repository.getEnvironment(task.environmentId)
    repository.archiveProject(task.projectId)
    assert.equal(repository.listProjects().length, 0)
    assert.equal(repository.listTasks(task.projectId).length, 1)
    assert.equal(repository.listArchivedTasks().length, 0)
    assert.equal(repository.getAgent(agent.id).taskId, task.id)
    assert.equal(repository.getEnvironment(environment.id).id, environment.id)
    assert.equal(repository.listTimelineRows(task.id).length, 1)

    repository.archiveTask(task.id)
    assert.equal(repository.listArchivedTasks()[0].id, task.id)
    repository.restoreProject(task.projectId)
    const restored = repository.restoreTask(task.id)
    assert.equal(restored.lifecycle, 'active')
    assert.equal(repository.getProject(task.projectId).lifecycle, 'active')
    assert.equal(repository.listProjects()[0].id, task.projectId)
  } finally {
    db.close()
  }
})

test('工作区和会话按最近置顶时间优先排序，取消置顶后恢复活跃时间排序', () => {
  const db = openDatabase(':memory:')
  const repository = createRepository(db)
  try {
    const firstProject = repository.createProject({ repositoryRoot: process.cwd(), displayName: '较早工作区' })
    const secondProject = repository.createProject({ repositoryRoot: path.join(process.cwd(), 'second-project'), displayName: '较新工作区' })
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run('2026-09-08T09:00:00.000Z', firstProject.id)
    db.prepare('UPDATE projects SET last_opened_at = ? WHERE id = ?').run('2026-09-08T10:00:00.000Z', secondProject.id)
    db.prepare('UPDATE projects SET pinned_at = ? WHERE id = ?').run('2026-09-08T11:00:00.000Z', firstProject.id)
    db.prepare('UPDATE projects SET pinned_at = ? WHERE id = ?').run('2026-09-08T12:00:00.000Z', secondProject.id)
    assert.deepEqual(repository.listProjects().map((project) => project.id), [secondProject.id, firstProject.id])

    repository.setProjectPinned(secondProject.id, false)
    assert.deepEqual(repository.listProjects().map((project) => project.id), [firstProject.id, secondProject.id])
    repository.setProjectPinned(firstProject.id, false)
    assert.deepEqual(repository.listProjects().map((project) => project.id), [secondProject.id, firstProject.id])

    const firstEnvironment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
    const secondEnvironment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
    const firstTask = repository.createTask({ projectId: firstProject.id, environmentId: firstEnvironment.id, title: '较早会话' })
    const secondTask = repository.createTask({ projectId: firstProject.id, environmentId: secondEnvironment.id, title: '较新会话' })
    db.prepare('UPDATE tasks SET last_active_at = ? WHERE id = ?').run('2026-09-08T09:00:00.000Z', firstTask.id)
    db.prepare('UPDATE tasks SET last_active_at = ? WHERE id = ?').run('2026-09-08T10:00:00.000Z', secondTask.id)
    db.prepare('UPDATE tasks SET pinned_at = ? WHERE id = ?').run('2026-09-08T11:00:00.000Z', firstTask.id)
    db.prepare('UPDATE tasks SET pinned_at = ? WHERE id = ?').run('2026-09-08T12:00:00.000Z', secondTask.id)
    assert.deepEqual(repository.listTasks(firstProject.id).map((task) => task.id), [secondTask.id, firstTask.id])

    repository.setTaskPinned(secondTask.id, false)
    assert.deepEqual(repository.listTasks(firstProject.id).map((task) => task.id), [firstTask.id, secondTask.id])
    repository.setTaskPinned(firstTask.id, false)
    assert.deepEqual(repository.listTasks(firstProject.id).map((task) => task.id), [secondTask.id, firstTask.id])
  } finally {
    db.close()
  }
})

test('归档会话清除会话置顶，归档工作区只清除工作区置顶', () => {
  const { db, repository, task } = setup()
  try {
    repository.setProjectPinned(task.projectId, true)
    repository.setTaskPinned(task.id, true)
    assert.ok(repository.getProject(task.projectId).pinnedAt)
    assert.ok(repository.getTask(task.id).pinnedAt)

    repository.archiveTask(task.id)
    assert.equal(repository.getTask(task.id).pinnedAt, null)
    repository.restoreTask(task.id)
    repository.setTaskPinned(task.id, true)
    repository.archiveProject(task.projectId)
    assert.equal(repository.getProject(task.projectId).pinnedAt, null)
    assert.ok(repository.getTask(task.id).pinnedAt)
  } finally {
    db.close()
  }
})
