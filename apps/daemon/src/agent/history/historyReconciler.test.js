import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHistoryManifest } from './historySnapshot.js'
import { reconcileHistory } from './historyReconciler.js'

function providerTurn(id, text, answer = `答复 ${text}`) {
  return {
    sourceTurnId: id,
    status: 'completed',
    startedAt: '2026-09-04T10:00:00.000Z',
    finishedAt: '2026-09-04T10:00:01.000Z',
    items: [
      { providerMessageId: `${id}:user`, item: { type: 'user_message', clientMessageId: `${id}:client`, content: [{ type: 'text', text }] } },
      { providerMessageId: `${id}:answer`, item: { type: 'assistant_message', messageId: `${id}:answer`, phase: 'final_answer', text: answer } },
    ],
  }
}

function localTurn(id, nativeTurnId, clientMessageId, createdAt) {
  return { id, nativeTurnId, clientMessageId, status: 'completed', createdAt }
}

function localRows(turn, text, answer, extra = []) {
  return [
    { seq: 1, turnId: turn.id, timestamp: turn.createdAt, item: { type: 'user_message', clientMessageId: turn.clientMessageId, content: [{ type: 'text', text }] } },
    ...extra,
    { seq: 2 + extra.length, turnId: turn.id, timestamp: turn.createdAt, item: { type: 'assistant_message', phase: 'final_answer', text: answer } },
  ]
}

test('对账无变化时不写 Timeline', () => {
  const snapshot = { sourceId: 'thread-1', turns: [providerTurn('t1', '一')] }
  const result = reconcileHistory({
    snapshot,
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest(snapshot) },
  })
  assert.equal(result.mode, 'noop')
  assert.equal(result.changed, false)
})

test('Provider revision 变化时即使可见 Turn 不变也会更新同步状态', () => {
  const snapshot = { sourceId: 'thread-1', revision: '2', turns: [providerTurn('t1', '一')] }
  const previous = { ...snapshot, revision: '1' }
  const result = reconcileHistory({
    snapshot,
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest(previous) },
  })
  assert.notEqual(result.mode, 'noop')
  assert.equal(result.manifest.revision, '2')
})

test('只追加 Provider 尾部新增 Turn', () => {
  const first = providerTurn('t1', '一')
  const second = providerTurn('t2', '二')
  const local = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [first, second] },
    localTurns: [local],
    localRows: localRows(local, '一', '本地详细答复'),
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [first] }) },
  })
  assert.equal(result.mode, 'append')
  assert.deepEqual(result.rows.map((row) => row.sourceTurnId).filter((id, index, values) => values.indexOf(id) === index), ['t2'])
  assert.deepEqual(result.rows.map((row) => row.item.type), ['user_message', 'assistant_message'])
})

test('本地已有用户占位但 Provider Turn 后续完成时补齐回复', () => {
  const first = providerTurn('t1', '一')
  const completed = providerTurn('t2', '二', '完整答复 二')
  const localFirst = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const localPlaceholder = {
    id: 'local-2',
    nativeTurnId: 't2',
    clientMessageId: 't2:client',
    status: 'canceled',
    createdAt: '2026-09-04T10:01:00.000Z',
  }
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [first, completed] },
    localTurns: [localPlaceholder, localFirst],
    localRows: [
      ...localRows(localFirst, '一', '答复 一'),
      {
        seq: 10,
        turnId: localPlaceholder.id,
        timestamp: localPlaceholder.createdAt,
        providerMessageId: 't2:user',
        item: { type: 'user_message', clientMessageId: 't2:client', content: [{ type: 'text', text: '二' }] },
      },
    ],
    // t2 不在上一次 Manifest 中，因为本地客户端创建它时 Provider 仍在运行。
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [first] }) },
  })
  assert.equal(result.mode, 'replace')
  assert.equal(result.rows.find((row) => row.sourceTurnId === 't2')?.item.type, 'user_message')
  assert.equal(result.rows.find((row) => row.sourceTurnId === 't2' && row.item.type === 'assistant_message')?.item.text, '完整答复 二')
})

test('Provider 中间插入 Turn 时重建顺序并保留未变化 Turn 的详细本地过程', () => {
  const first = providerTurn('t1', '一')
  const middle = providerTurn('t2', '二')
  const third = providerTurn('t3', '三')
  const localFirst = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const localThird = localTurn('local-3', 't3', 't3:client', '2026-09-04T10:02:00.000Z')
  const richTool = {
    seq: 2,
    turnId: localFirst.id,
    timestamp: localFirst.createdAt,
    item: { type: 'tool_call', callId: 'rich', name: '本地详细工具', status: 'completed', detail: { type: 'test' } },
  }
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [first, middle, third] },
    localTurns: [localThird, localFirst],
    localRows: [
      ...localRows(localFirst, '一', '答复 一', [richTool]),
      ...localRows(localThird, '三', '答复 三').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [first, third] }) },
  })
  assert.equal(result.mode, 'replace')
  assert.deepEqual(result.rows.filter((row) => row.item.type === 'user_message').map((row) => row.item.content[0].text), ['一', '二', '三'])
  assert.ok(result.rows.some((row) => row.item.type === 'tool_call' && row.item.callId === 'rich'))
})

test('首次同步可按唯一用户文本绑定没有原生 Turn ID 的旧数据', () => {
  const remote = providerTurn('kimi-turn:1', '同一问题')
  remote.items[0].item.clientMessageId = 'kimi-turn:1:user'
  const local = localTurn('local-1', '', 'browser-id', '2026-09-04T10:00:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'kimi-session', turns: [remote] },
    localTurns: [local],
    localRows: localRows(local, '同一问题', '更丰富的本地答复'),
  })
  assert.equal(result.mode, 'append')
  assert.equal(result.rows.length, 0)
})

test('Provider rewind 后替换历史，不保留已移除的旧 Provider Turn', () => {
  const first = providerTurn('t1', '一')
  const removed = providerTurn('t2', '二')
  const localFirst = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const localRemoved = localTurn('local-2', 't2', 't2:client', '2026-09-04T10:01:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [first] },
    localTurns: [localRemoved, localFirst],
    localRows: [
      ...localRows(localFirst, '一', '答复 一'),
      ...localRows(localRemoved, '二', '答复 二').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [first, removed] }) },
  })
  assert.equal(result.mode, 'replace')
  assert.deepEqual(result.rows.filter((row) => row.item.type === 'user_message').map((row) => row.item.content[0].text), ['一'])
})
