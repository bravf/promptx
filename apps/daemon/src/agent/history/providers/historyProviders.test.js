import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mapCodexHistorySnapshot, readCodexHistorySnapshot } from './codexHistory.js'
import { mapClaudeHistorySnapshot } from './claudeHistory.js'
import { mapKimiHistorySnapshot } from './kimiHistory.js'

test('Codex thread/read 映射为统一历史快照', () => {
  const snapshot = mapCodexHistorySnapshot({
    id: 'codex-thread', recencyAt: 1_788_500_002, updatedAt: 1_788_500_000,
    turns: [{
      id: 'turn-1', status: 'completed', startedAt: 1_788_500_000, completedAt: 1_788_500_001,
      items: [
        { type: 'userMessage', id: 'user-1', clientId: 'client-1', content: [{ type: 'text', text: '你好' }] },
        { type: 'reasoning', id: 'reason-1', summary: ['分析'] },
        { type: 'agentMessage', id: 'answer-1', phase: 'final_answer', text: '你好。' },
      ],
    }],
  })
  assert.equal(snapshot.sourceId, 'codex-thread')
  assert.equal(snapshot.revision, '1788500002')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'reasoning', 'assistant_message'])
  assert.equal(snapshot.turns[0].items[0].item.clientMessageId, 'client-1')
})

test('Codex 同步版本使用 recencyAt，避免 updatedAt 固定为创建时间导致漏同步', async () => {
  const requests = []
  const runtime = {
    threadId: 'codex-thread',
    async connect() {},
    rpc: {
      async request(method, params) {
        requests.push({ method, params })
        if (!params.includeTurns) return { thread: { id: 'codex-thread', updatedAt: 10, recencyAt: 20 } }
        return { thread: { id: 'codex-thread', updatedAt: 10, recencyAt: 20, turns: [] } }
      },
    },
  }
  const snapshot = await readCodexHistorySnapshot(runtime, { knownRevision: '10' })
  assert.equal(snapshot.revision, '20')
  assert.equal(snapshot.turns.length, 0)
  assert.equal(requests.length, 2)

  requests.length = 0
  const unchanged = await readCodexHistorySnapshot(runtime, { knownRevision: '20' })
  assert.equal(unchanged.status, 'unchanged')
  assert.equal(requests.length, 1)
})

test('Claude JSONL 映射用户、思考、工具和最终回复', () => {
  const lines = [
    { type: 'user', uuid: 'user-1', timestamp: '2026-09-04T10:00:00Z', message: { content: [{ type: 'text', text: '检查' }] } },
    { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-09-04T10:00:01Z', message: { id: 'message-1', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '先看文件' }, { type: 'tool_use', id: 'tool-1', name: 'Read', input: { path: 'a.js' } }] } },
    { type: 'user', uuid: 'result-1', timestamp: '2026-09-04T10:00:02Z', message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: '文件内容' }] } },
    { type: 'assistant', uuid: 'assistant-2', timestamp: '2026-09-04T10:00:03Z', message: { id: 'message-2', stop_reason: 'end_turn', content: [{ type: 'text', text: '检查完成' }] } },
  ]
  const snapshot = mapClaudeHistorySnapshot('claude-session', lines.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns[0].status, 'completed')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'reasoning', 'tool_call', 'assistant_message'])
  assert.equal(snapshot.turns[0].items.find((entry) => entry.item.type === 'tool_call').item.status, 'completed')
})

test('Kimi wire JSONL 映射完整 Turn', () => {
  const lines = [
    { timestamp: 1_788_500_000, message: { type: 'TurnBegin', payload: { user_input: '你好' } } },
    { timestamp: 1_788_500_001, message: { type: 'ContentPart', payload: { type: 'think', think: '思考' } } },
    { timestamp: 1_788_500_002, message: { type: 'ToolCall', payload: { id: 'tool-1', function: { name: 'ReadFile', arguments: '{}' } } } },
    { timestamp: 1_788_500_003, message: { type: 'ToolResult', payload: { tool_call_id: 'tool-1', return_value: { is_error: false, output: 'ok' } } } },
    { timestamp: 1_788_500_004, message: { type: 'ContentPart', payload: { type: 'text', text: '你好。' } } },
    { timestamp: 1_788_500_005, message: { type: 'TurnEnd', payload: {} } },
  ]
  const snapshot = mapKimiHistorySnapshot('kimi-session', lines.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns[0].status, 'completed')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'reasoning', 'tool_call', 'assistant_message'])
  assert.equal(snapshot.turns[0].items[2].item.status, 'completed')
})
