import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openDatabase } from '../db/database.js'
import { createRepository } from '../db/repository.js'
import { TimelineStore } from './timelineStore.js'

function setup() {
  const db = openDatabase(':memory:')
  const repository = createRepository(db)
  const project = repository.createProject({ repositoryRoot: process.cwd() })
  const environment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
  const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '分页测试' })
  repository.createAgent(task.id, { providerId: 'codex' })
  const store = new TimelineStore(repository)
  for (let index = 1; index <= 8; index += 1) {
    store.append(task.id, null, { type: 'system_notice', code: `row-${index}`, text: String(index) })
  }
  return { db, repository, task, store }
}

test('Timeline tail、before 和 after 通过数据库窗口返回正确顺序', () => {
  const { db, task, store } = setup()
  try {
    const tail = store.fetch(task.id, { direction: 'tail', limit: 3 })
    assert.deepEqual(tail.rows.map((row) => row.seq), [6, 7, 8])
    assert.equal(tail.hasOlder, true)
    assert.equal(tail.hasNewer, false)

    const before = store.fetch(task.id, { direction: 'before', cursor: { epoch: tail.epoch, seq: 6 }, limit: 2 })
    assert.deepEqual(before.rows.map((row) => row.seq), [4, 5])
    assert.equal(before.hasOlder, true)
    assert.equal(before.hasNewer, true)

    const after = store.fetch(task.id, { direction: 'after', cursor: { epoch: tail.epoch, seq: 5 }, limit: 2 })
    assert.deepEqual(after.rows.map((row) => row.seq), [6, 7])
    assert.equal(after.hasNewer, true)
  } finally {
    db.close()
  }
})

test('Timeline 游标 epoch 失效时重置到最新窗口', () => {
  const { db, task, store } = setup()
  try {
    const result = store.fetch(task.id, { direction: 'after', cursor: { epoch: 'old', seq: 2 }, limit: 2 })
    assert.equal(result.reset, true)
    assert.equal(result.staleCursor, true)
    assert.deepEqual(result.rows.map((row) => row.seq), [7, 8])
  } finally {
    db.close()
  }
})

test('Timeline 展示模式裁剪工具输出但保留原始存储', () => {
  const { db, task, store } = setup()
  try {
    store.append(task.id, null, {
      type: 'tool_call',
      callId: 'large-tool',
      name: '终端命令',
      status: 'completed',
      detail: {
        type: 'shell',
        command: 'git diff',
        aggregatedOutput: 'x'.repeat(100_000),
        rawInput: JSON.stringify({ path: '/workspace/README.md' }),
      },
    })
    const presented = store.fetch(task.id, { mode: 'presented', limit: 10 })
    const raw = store.fetch(task.id, { limit: 10 })
    const presentedTool = presented.rows.find((row) => row.item.type === 'tool_call')
    const rawTool = raw.rows.find((row) => row.item.type === 'tool_call')
    assert.equal(presentedTool.item.detail.aggregatedOutput, undefined)
    assert.deepEqual(presentedTool.item.detail.paths, [{ path: '/workspace/README.md' }])
    assert.equal(rawTool.item.detail.aggregatedOutput.length, 100_000)
  } finally {
    db.close()
  }
})

test('Timeline 展示分页按完整 Turn 和字节预算返回', () => {
  const { db, repository, task, store } = setup()
  try {
    const turnA = repository.createTurn(task.id, 'client-a')
    repository.updateTurn(turnA.id, { status: 'completed', historyState: 'confirmed' })
    const turnB = repository.createTurn(task.id, 'client-b')
    repository.updateTurn(turnB.id, { status: 'completed', historyState: 'confirmed' })
    store.append(task.id, turnA.id, { type: 'assistant_message', phase: 'final_answer', text: 'A'.repeat(400) })
    store.append(task.id, turnA.id, { type: 'system_notice', code: 'done-a', text: 'A 完成' })
    store.append(task.id, turnB.id, { type: 'assistant_message', phase: 'final_answer', text: 'B'.repeat(400) })
    store.append(task.id, turnB.id, { type: 'system_notice', code: 'done-b', text: 'B 完成' })

    const tail = store.fetch(task.id, { mode: 'presented', limit: 10, maxBytes: 700 })
    assert.deepEqual(new Set(tail.rows.map((row) => row.turnId)), new Set([turnB.id]))
    assert.equal(tail.hasOlder, true)

    const before = store.fetch(task.id, {
      direction: 'before',
      cursor: { epoch: tail.epoch, seq: tail.rows[0].seq },
      mode: 'presented',
      limit: 10,
      maxBytes: 700,
    })
    assert.deepEqual(new Set(before.rows.map((row) => row.turnId)), new Set([turnA.id]))
  } finally {
    db.close()
  }
})
