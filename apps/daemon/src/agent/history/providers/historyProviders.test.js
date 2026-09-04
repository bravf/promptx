import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mapCodexHistorySnapshot, mapCodexRolloutSnapshot, readCodexHistorySnapshot } from './codexHistory.js'
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
  assert.equal(snapshot.revision, '1788500002:1788500000')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'reasoning', 'assistant_message'])
  assert.equal(snapshot.turns[0].items[0].item.clientMessageId, 'client-1')
})

test('Codex 即使 recencyAt 未变化也读取完整 Turn，避免漏掉稍后完成的回复', async () => {
  const requests = []
  let completed = false
  const runtime = {
    threadId: 'codex-thread',
    async connect() {},
    rpc: {
      async request(method, params) {
        requests.push({ method, params })
        if (!params.includeTurns) return { thread: { id: 'codex-thread', updatedAt: 10, recencyAt: 20 } }
        return {
          thread: {
            id: 'codex-thread', updatedAt: completed ? 30 : 10, recencyAt: 20,
            turns: completed ? [{
              id: 'turn-1', status: 'completed', startedAt: 20, completedAt: 30,
              items: [
                { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: '问题' }] },
                { type: 'agentMessage', id: 'answer-1', phase: 'final_answer', text: '回复' },
              ],
            }] : [],
          },
        }
      },
    },
  }
  const snapshot = await readCodexHistorySnapshot(runtime, { knownRevision: '10' })
  assert.equal(snapshot.revision, '20:10')
  assert.equal(snapshot.turns.length, 0)
  assert.equal(requests.length, 2)

  requests.length = 0
  completed = true
  const updated = await readCodexHistorySnapshot(runtime, { knownRevision: '20:10' })
  assert.equal(updated.revision, '20:30')
  assert.equal(updated.turns[0].items.at(-1).item.text, '回复')
  assert.equal(requests.length, 2)
})

test('Codex paginated rollout JSONL 映射 item_completed 历史', () => {
  const content = [
    { timestamp: '2026-09-04T05:45:30.919Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-09-04T05:45:30.953Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'user-1', client_id: 'client-1', content: [{ type: 'text', text: '你好' }] } } },
    { timestamp: '2026-09-04T05:45:34.711Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'AgentMessage', id: 'answer-1', phase: 'final_answer', content: [{ type: 'Text', text: '你好。' }] } } },
    { timestamp: '2026-09-04T05:45:34.828Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ].map(JSON.stringify).join('\n')
  const snapshot = mapCodexRolloutSnapshot({ id: 'thread-1' }, content, '12:34')
  assert.equal(snapshot.sourceId, 'thread-1')
  assert.equal(snapshot.revision, '12:34')
  assert.equal(snapshot.turns[0].sourceTurnId, 'turn-1')
  assert.equal(snapshot.turns[0].status, 'completed')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'assistant_message'])
  assert.equal(snapshot.turns[0].items[0].item.clientMessageId, 'client-1')
  assert.equal(snapshot.turns[0].items[1].item.text, '你好。')
})

test('Codex paginated thread/read 报错时回退到 thread.path rollout 文件', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-codex-'))
  const file = path.join(directory, 'rollout.jsonl')
  fs.writeFileSync(file, [
    { timestamp: '2026-09-04T05:45:30.919Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-09-04T05:45:30.953Z', type: 'event_msg', payload: { type: 'item_completed', turn_id: 'turn-1', item: { type: 'UserMessage', id: 'user-1', content: [{ type: 'text', text: '导入测试' }] } } },
    { timestamp: '2026-09-04T05:45:34.828Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
  ].map(JSON.stringify).join('\n'))
  const requests = []
  const runtime = {
    threadId: 'thread-1',
    async connect() {},
    rpc: {
      async request(method, params) {
        requests.push({ method, params })
        if (!params.includeTurns) return { thread: { id: 'thread-1', historyMode: 'paginated', path: file, recencyAt: 20 } }
        throw new Error('paginated_threads is not supported yet')
      },
    },
  }
  try {
    const snapshot = await readCodexHistorySnapshot(runtime)
    assert.equal(snapshot.sourceId, 'thread-1')
    assert.equal(snapshot.turns[0].status, 'completed')
    assert.equal(snapshot.turns[0].items[0].item.content[0].text, '导入测试')
    assert.equal(requests.length, 2)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
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

test('新版 Kimi Code session wire 映射 turn.prompt 和 loop event', () => {
  const lines = [
    { type: 'turn.prompt', promptId: 'prompt-1', input: [{ type: 'text', text: '你好2026' }], time: 1788500442911 },
    { type: 'context.append_loop_event', turnId: '0', event: { type: 'content.part', part: { type: 'think', think: '先回应问候' } }, time: 1788500447051 },
    { type: 'context.append_loop_event', turnId: '0', event: { type: 'content.part', part: { type: 'text', text: '你好！' } }, time: 1788500447051 },
    { type: 'prompt.completed', promptId: 'prompt-1', finishedAt: '2026-09-04T05:40:47.054Z' },
  ]
  const snapshot = mapKimiHistorySnapshot('session_new', lines.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns[0].status, 'completed')
  assert.deepEqual(snapshot.turns[0].items.map((entry) => entry.item.type), ['user_message', 'reasoning', 'assistant_message'])
})
