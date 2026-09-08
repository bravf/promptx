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
  assert.equal(result.mode, 'merge')
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
  assert.equal(result.mode, 'merge')
  assert.equal(result.rows.some((row) => row.sourceTurnId === 't2' && row.item.type === 'user_message'), false)
  assert.equal(result.rows.find((row) => row.sourceTurnId === 't2' && row.item.type === 'assistant_message')?.item.text, '完整答复 二')
})

test('已有过程消息时仍补齐 Provider 后续落盘的最终回复', () => {
  const completed = providerTurn('t1', '继续', '最终答复')
  completed.items.splice(1, 0, {
    providerMessageId: 't1:commentary',
    item: { type: 'assistant_message', messageId: 't1:commentary', phase: 'commentary', text: '我继续检查。' },
  }, {
    providerMessageId: 't1:commentary-later',
    item: { type: 'assistant_message', messageId: 't1:commentary-later', phase: 'commentary', text: '检查完成。' },
  })
  const partial = {
    ...completed,
    items: completed.items.filter((entry) => !['t1:commentary-later', 't1:answer'].includes(entry.providerMessageId)),
  }
  const local = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [completed] },
    localTurns: [local],
    localRows: [
      {
        seq: 1,
        turnId: local.id,
        timestamp: local.createdAt,
        source: 'provider',
        providerMessageId: 't1:user',
        item: completed.items[0].item,
      },
      {
        seq: 2,
        turnId: local.id,
        timestamp: local.createdAt,
        source: 'provider',
        providerMessageId: 't1:commentary',
        item: completed.items[1].item,
      },
    ],
    syncState: { sourceId: 'thread-1', manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [partial] }) },
  })

  assert.equal(result.mode, 'merge')
  assert.deepEqual(result.rows.map((row) => [row.item.type, row.item.phase, row.item.text]), [
    ['assistant_message', 'commentary', '检查完成。'],
    ['assistant_message', 'final_answer', '最终答复'],
  ])
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
  assert.equal(result.mode, 'rebuild')
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
  assert.equal(result.mode, 'merge')
  assert.equal(result.rows.length, 0)
})

test('相同文本按提交时间分别绑定，不会把本地 Turn 倒序追加', () => {
  const first = providerTurn('kimi-prompt-1', '你好', '第一次回复')
  first.startedAt = '2026-09-04T10:00:01.000Z'
  first.finishedAt = '2026-09-04T10:00:02.000Z'
  first.items[0].item.clientMessageId = 'kimi-prompt-1'
  const second = providerTurn('kimi-prompt-2', '你好', '第二次回复')
  second.startedAt = '2026-09-04T10:01:01.000Z'
  second.finishedAt = '2026-09-04T10:01:02.000Z'
  second.items[0].item.clientMessageId = 'kimi-prompt-2'
  const localFirst = localTurn('local-1', 'browser-1', 'browser-1', '2026-09-04T10:00:00.000Z')
  const localSecond = localTurn('local-2', 'browser-2', 'browser-2', '2026-09-04T10:01:00.000Z')

  const result = reconcileHistory({
    snapshot: { sourceId: 'kimi-session', turns: [first, second] },
    localTurns: [localSecond, localFirst],
    localRows: [
      ...localRows(localFirst, '你好', '第一次回复'),
      ...localRows(localSecond, '你好', '第二次回复').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
  })

  assert.equal(result.mode, 'merge')
  assert.equal(result.rows.length, 0)
  assert.deepEqual(result.turns.map((turn) => turn.localTurnId), ['local-1', 'local-2'])
})

test('旧版对账产生的本地副本不会被 Provider 快照推断删除', () => {
  const remote = providerTurn('kimi-prompt-1', '你好', 'Provider 回复')
  remote.startedAt = '2026-09-04T10:00:01.000Z'
  remote.finishedAt = '2026-09-04T10:00:02.000Z'
  remote.items[0].item.clientMessageId = 'kimi-prompt-1'
  const canonical = localTurn('provider-turn', 'kimi-prompt-1', 'kimi-prompt-1', '2026-09-04T10:00:01.000Z')
  const staleLocal = localTurn('local-turn', 'browser-id', 'browser-id', '2026-09-04T10:00:00.000Z')
  const previousManifest = createHistoryManifest({ sourceId: 'kimi-session', turns: [remote] })
  delete previousManifest.reconcilerVersion

  const result = reconcileHistory({
    snapshot: { sourceId: 'kimi-session', turns: [remote] },
    localTurns: [canonical, staleLocal],
    localRows: [
      ...localRows(staleLocal, '你好', '本地流式回复'),
      ...localRows(canonical, '你好', 'Provider 回复').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
    syncState: { sourceId: 'kimi-session', manifest: previousManifest },
  })

  assert.equal(result.mode, 'merge')
  assert.equal('dropLocalTurnIds' in result, false)
})

test('Provider 尾部暂时缩短时不删除或重建本地 Turn', () => {
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
  assert.equal(result.mode, 'merge')
  assert.equal(result.rows.length, 0)
  assert.equal('dropLocalTurnIds' in result, false)
})

test('结束同步期间 Provider 快照暂缺当前 Turn 时保留本地完整输出', () => {
  const first = providerTurn('t1', '一')
  const pendingProviderEcho = providerTurn('t2', '继续', '稍后写入 Provider 历史的答复')
  const localFirst = localTurn('local-1', 't1', 't1:client', '2026-09-04T10:00:00.000Z')
  const justCompleted = localTurn('local-2', 't2', 'browser-client-id', '2026-09-04T10:01:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [first] },
    localTurns: [justCompleted, localFirst],
    localRows: [
      ...localRows(localFirst, '一', '答复 一'),
      ...localRows(justCompleted, '继续', '本地流式答复').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
    syncState: {
      sourceId: 'thread-1',
      manifest: createHistoryManifest({ sourceId: 'thread-1', turns: [first, pendingProviderEcho] }),
    },
    checkedTurnIds: [justCompleted.id],
  })

  assert.equal(result.mode, 'merge')
  assert.equal(result.rows.length, 0)
  assert.equal(result.confirmedTurnIds.includes(justCompleted.id), false)
  assert.equal('dropLocalTurnIds' in result, false)
})

test('快速连续发送相同内容时按时间一一绑定且不产生删除计划', () => {
  const first = providerTurn('provider-1', '继续', '第一条回复')
  const second = providerTurn('provider-2', '继续', '第二条回复')
  first.startedAt = '2026-09-04T10:00:01.000Z'
  second.startedAt = '2026-09-04T10:00:04.000Z'
  const localFirst = localTurn('local-1', '', 'browser-1', '2026-09-04T10:00:00.000Z')
  const localSecond = localTurn('local-2', '', 'browser-2', '2026-09-04T10:00:03.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'kimi-session', turns: [first, second] },
    localTurns: [localSecond, localFirst],
    localRows: [
      ...localRows(localFirst, '继续', '第一条回复'),
      ...localRows(localSecond, '继续', '第二条回复').map((row, index) => ({ ...row, seq: index + 10 })),
    ],
  })
  assert.deepEqual(result.turns.map((turn) => turn.localTurnId), ['local-1', 'local-2'])
  assert.equal(result.rows.length, 0)
  assert.equal('dropLocalTurnIds' in result, false)
})

test('匹配本地 Turn 时保留含附件的用户消息，只补 Provider 输出', () => {
  const remote = providerTurn('turn-1', '看图', '图片说明')
  const local = localTurn('local-1', 'turn-1', 'browser-1', '2026-09-04T10:00:00.000Z')
  const result = reconcileHistory({
    snapshot: { sourceId: 'thread-1', turns: [remote] },
    localTurns: [local],
    localRows: [{
      seq: 1,
      turnId: local.id,
      timestamp: local.createdAt,
      item: { type: 'user_message', clientMessageId: 'browser-1', content: [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'asset-1', mimeType: 'image/png', name: 'a.png', size: 10 },
      ] },
    }],
  })
  assert.deepEqual(result.rows.map((row) => row.item.type), ['assistant_message'])
})
