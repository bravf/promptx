import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHistoryManifest } from './historySnapshot.js'
import { TimelineSyncCoordinator } from './timelineSyncCoordinator.js'

function deferred() {
  let resolve
  const promise = new Promise((done) => { resolve = done })
  return { promise, resolve }
}

function snapshot() {
  return {
    sourceId: 'thread-1',
    turns: [{
      sourceTurnId: 'turn-1', status: 'completed',
      items: [{ providerMessageId: 'answer-1', item: { type: 'assistant_message', messageId: 'answer-1', phase: 'final_answer', text: '完成' } }],
    }],
  }
}

test('多个页面同时同步同一 Agent 时合并读取并最多补跑一次', async () => {
  const firstRead = deferred()
  let reads = 0
  let applies = 0
  let nextSeq = 1
  const runtime = {
    threadId: 'thread-1',
    async readHistorySnapshot() {
      reads += 1
      if (reads === 1) await firstRead.promise
      return snapshot()
    },
  }
  const coordinator = new TimelineSyncCoordinator({
    repository: {
      getTimelineState: () => ({ epoch: 'epoch-1', nextSeq }),
      listTimelineRows: () => [],
      listTurns: () => [],
      getTimelineSyncState: () => null,
      applyTimelineSync: (_agentId, input) => {
        applies += 1
        nextSeq += input.rows.length
        return { mode: input.mode, epoch: 'epoch-1', rows: [], syncedAt: 'now' }
      },
    },
    timelineStore: { fetch: () => ({ epoch: 'epoch-1', rows: [] }) },
    eventHub: { publish: () => {} },
    getRuntime: () => runtime,
    getActiveTurnId: () => '',
  })
  const agent = { id: 'agent-1', taskId: 'task-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } }
  const calls = Array.from({ length: 10 }, () => coordinator.sync(agent))
  firstRead.resolve()
  await Promise.all(calls)
  assert.equal(reads, 2)
  assert.equal(applies, 2)
})
test('同步读取期间 Timeline 变化时丢弃旧计划并重新读取', async () => {
  let reads = 0
  let nextSeq = 1
  const expectedSeqs = []
  const coordinator = new TimelineSyncCoordinator({
    repository: {
      getTimelineState: () => ({ epoch: 'epoch-1', nextSeq }),
      listTimelineRows: () => [],
      listTurns: () => [],
      getTimelineSyncState: () => null,
      applyTimelineSync: (_agentId, input) => {
        expectedSeqs.push(input.expectedNextSeq)
        if (expectedSeqs.length === 1) {
          nextSeq = 2
          const error = new Error('stale')
          error.code = 'TIMELINE_SYNC_STALE'
          throw error
        }
        return { mode: input.mode, epoch: 'epoch-1', rows: [], syncedAt: 'now' }
      },
    },
    timelineStore: { fetch: () => ({ epoch: 'epoch-1', rows: [] }) },
    eventHub: { publish: () => {} },
    getRuntime: () => ({ threadId: 'thread-1', readHistorySnapshot: async () => { reads += 1; return snapshot() } }),
    getActiveTurnId: () => '',
  })
  await coordinator.sync({ id: 'agent-1', taskId: 'task-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } })
  assert.equal(reads, 2)
  assert.deepEqual(expectedSeqs, [1, 2])
})

test('并发同步会把刚完成 Turn 的保护边界带入补跑', async () => {
  const firstRead = deferred()
  const first = snapshot().turns[0]
  const previousFirst = structuredClone(first)
  previousFirst.items[0].item.text = '旧答复'
  const pending = {
    sourceTurnId: 'turn-2',
    status: 'running',
    startedAt: '2026-09-04T10:01:00.000Z',
    items: [{
      providerMessageId: 'turn-2:user',
      item: { type: 'user_message', clientMessageId: 'turn-2:client', content: [{ type: 'text', text: '继续' }] },
    }],
  }
  const localTurns = [
    { id: 'local-2', nativeTurnId: 'turn-2', clientMessageId: 'browser-2', status: 'completed', createdAt: '2026-09-04T10:01:00.000Z' },
    { id: 'local-1', nativeTurnId: 'turn-1', clientMessageId: 'turn-1:client', status: 'completed', createdAt: '2026-09-04T10:00:00.000Z' },
  ]
  const localRows = [
    { seq: 1, turnId: 'local-1', timestamp: '2026-09-04T10:00:00.000Z', item: { type: 'user_message', clientMessageId: 'turn-1:client', content: [{ type: 'text', text: '一' }] } },
    { seq: 2, turnId: 'local-1', timestamp: '2026-09-04T10:00:01.000Z', item: { type: 'assistant_message', phase: 'final_answer', text: '旧答复' } },
    { seq: 3, turnId: 'local-2', timestamp: '2026-09-04T10:01:00.000Z', item: { type: 'user_message', clientMessageId: 'browser-2', content: [{ type: 'text', text: '继续' }] } },
    { seq: 4, turnId: 'local-2', timestamp: '2026-09-04T10:01:01.000Z', item: { type: 'assistant_message', phase: 'final_answer', text: '刚刚流式完成的答复' } },
  ]
  const appliedPlans = []
  let reads = 0
  let now = 1_000
  const coordinator = new TimelineSyncCoordinator({
    repository: {
      getTimelineState: () => ({ epoch: 'epoch-1', nextSeq: 5 }),
      getTimelineSyncState: () => ({
        sourceId: 'thread-1',
        manifest: createHistoryManifest({ sourceId: 'thread-1', revision: 'old', turns: [previousFirst, pending] }),
      }),
      listTimelineRows: () => localRows,
      listTurns: () => localTurns,
      applyTimelineSync: (_taskId, input) => {
        appliedPlans.push(input)
        return { mode: input.mode, epoch: 'epoch-2', rows: [], syncedAt: 'now' }
      },
    },
    timelineStore: { fetch: () => ({ epoch: 'epoch-2', rows: [] }) },
    eventHub: { publish: () => {} },
    getRuntime: () => ({
      threadId: 'thread-1',
      readHistorySnapshot: async () => {
        reads += 1
        if (reads === 1) await firstRead.promise
        return { sourceId: 'thread-1', revision: 'new', turns: [first] }
      },
    }),
    getActiveTurnId: () => '',
    now: () => now,
    preserveTurnMs: 5_000,
  })
  const agent = { id: 'agent-1', taskId: 'task-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } }

  const initial = coordinator.sync(agent)
  const completed = coordinator.sync(agent, { preserveTurnId: 'local-2' })
  firstRead.resolve()
  await Promise.all([initial, completed])

  assert.equal(reads, 2)
  assert.equal(appliedPlans.length, 2)
  for (const plan of appliedPlans) {
    assert.ok(plan.rows.some((row) => row.localTurnId === 'local-2' && row.item.text === '刚刚流式完成的答复'))
  }

  await coordinator.sync(agent)
  assert.ok(appliedPlans.at(-1).rows.some((row) => row.localTurnId === 'local-2'))

  now = 6_000
  await coordinator.sync(agent)
  assert.equal(appliedPlans.at(-1).rows.some((row) => row.localTurnId === 'local-2'), false)
})

test('历史没有变化时仍广播同步成功以清理前端旧错误', async () => {
  const events = []
  const turns = [{ id: 'turn-1', status: 'completed' }]
  const coordinator = new TimelineSyncCoordinator({
    repository: {
      getTimelineState: () => ({ epoch: 'epoch-1', nextSeq: 2 }),
      getTimelineSyncState: () => ({ syncedAt: '2026-09-04T12:00:00.000Z', manifest: { revision: 'revision-1' } }),
      listTurns: () => turns,
    },
    timelineStore: { fetch: () => ({ epoch: 'epoch-1', rows: [] }) },
    eventHub: { publish: (agentId, event) => events.push({ agentId, event }) },
    getRuntime: () => ({
      threadId: 'thread-1',
      readHistorySnapshot: async () => ({ status: 'unchanged' }),
    }),
    getActiveTurnId: () => '',
  })

  const result = await coordinator.sync({ id: 'agent-1', taskId: 'task-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } })

  assert.deepEqual(result, {
    status: 'synced',
    changed: false,
    syncedAt: '2026-09-04T12:00:00.000Z',
    turns,
  })
  assert.deepEqual(events, [{
    agentId: 'agent-1',
    event: { type: 'timeline-synced', sync: result },
  }])
})

test('旧版对账状态忽略已知 revision 并强制重建 canonical Timeline', async () => {
  let requestedRevision = null
  let appliedMode = null
  const oldManifest = {
    sourceId: 'thread-1',
    revision: 'unchanged-revision',
    turns: [],
  }
  const coordinator = new TimelineSyncCoordinator({
    repository: {
      getTimelineState: () => ({ epoch: 'epoch-old', nextSeq: 1 }),
      getTimelineSyncState: () => ({ sourceId: 'thread-1', manifest: oldManifest }),
      listTimelineRows: () => [],
      listTurns: () => [],
      applyTimelineSync: (_taskId, input) => {
        appliedMode = input.mode
        return { mode: input.mode, epoch: 'epoch-new', rows: [], syncedAt: 'now' }
      },
    },
    timelineStore: { fetch: () => ({ epoch: 'epoch-new', rows: [] }) },
    eventHub: { publish: () => {} },
    getRuntime: () => ({
      threadId: 'thread-1',
      readHistorySnapshot: async ({ knownRevision }) => {
        requestedRevision = knownRevision
        return snapshot()
      },
    }),
    getActiveTurnId: () => '',
  })

  await coordinator.sync({ id: 'agent-1', taskId: 'task-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } })

  assert.equal(requestedRevision, '')
  assert.equal(appliedMode, 'replace')
})
