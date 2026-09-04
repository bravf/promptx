import assert from 'node:assert/strict'
import { test } from 'node:test'
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
  const agent = { id: 'agent-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } }
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
  await coordinator.sync({ id: 'agent-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } })
  assert.equal(reads, 2)
  assert.deepEqual(expectedSeqs, [1, 2])
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

  const result = await coordinator.sync({ id: 'agent-1', providerId: 'codex', nativeHandle: { threadId: 'thread-1' } })

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
