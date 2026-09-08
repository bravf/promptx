import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { mapCodexHistorySnapshot, mapCodexRolloutSnapshot, readCodexHistorySnapshot } from './codexHistory.js'
import { mapClaudeHistorySnapshot, readClaudeHistorySnapshot } from './claudeHistory.js'
import { mapKimiHistorySnapshot, readKimiHistorySnapshot } from './kimiHistory.js'

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

test('Codex 旧 rollout 的生成消息 ID 按 Turn 隔离', () => {
  const content = [
    { timestamp: '2026-09-04T05:45:30Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-1' } },
    { timestamp: '2026-09-04T05:45:31Z', type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-1', message: '你好' } },
    { timestamp: '2026-09-04T05:45:32Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-1' } },
    { timestamp: '2026-09-04T05:46:30Z', type: 'event_msg', payload: { type: 'task_started', turn_id: 'turn-2' } },
    { timestamp: '2026-09-04T05:46:31Z', type: 'event_msg', payload: { type: 'user_message', turn_id: 'turn-2', message: '你好' } },
    { timestamp: '2026-09-04T05:46:32Z', type: 'event_msg', payload: { type: 'task_complete', turn_id: 'turn-2' } },
  ].map(JSON.stringify).join('\n')
  const snapshot = mapCodexRolloutSnapshot({ id: 'thread-1' }, content)
  const ids = snapshot.turns.map((turn) => turn.items[0].providerMessageId)
  assert.equal(new Set(ids).size, 2)
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

test('Claude API 错误会映射为失败 Turn 并保留错误消息', () => {
  const lines = [
    { type: 'user', uuid: 'user-1', timestamp: '2026-09-04T10:00:00Z', message: { content: '检查' } },
    { type: 'assistant', uuid: 'assistant-1', timestamp: '2026-09-04T10:00:01Z', isApiErrorMessage: true,
      error: 'server_error', message: { id: 'message-1', stop_reason: 'stop_sequence', content: [{ type: 'text', text: 'API Error: 503' }] } },
  ]
  const snapshot = mapClaudeHistorySnapshot('claude-session', lines.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns[0].status, 'failed')
  assert.equal(snapshot.turns[0].errorMessage, 'API Error: 503')
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

test('新版 Kimi 映射工具生命周期和失败 Turn', () => {
  const lines = [
    { type: 'turn.prompt', promptId: 'prompt-1', input: [{ type: 'text', text: '读取' }], time: 1788500442911 },
    { type: 'context.append_loop_event', turnId: 0, event: { type: 'tool.call', turnId: 0, uuid: 'call-event', toolCallId: 'tool-1', name: 'Read', args: { path: 'a.js' } }, time: 1788500443000 },
    { type: 'context.append_loop_event', turnId: 0, event: { type: 'tool.result', turnId: 0, parentUuid: 'call-event', toolCallId: 'tool-1', result: { output: 'ok' } }, time: 1788500443100 },
    { type: 'turn.ended', turnId: 0, reason: 'failed', error: { message: '认证失败' }, time: 1788500443200 },
    { type: 'prompt.completed', promptId: 'prompt-1', reason: 'failed', finishedAt: '2026-09-04T05:40:43.300Z' },
  ]
  const snapshot = mapKimiHistorySnapshot('session-new', lines.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns[0].status, 'failed')
  assert.equal(snapshot.turns[0].errorMessage, '认证失败')
  assert.equal(snapshot.turns[0].runtimeTurnId, '0')
  assert.equal(snapshot.turns[0].items.find((entry) => entry.item.type === 'tool_call').item.status, 'completed')
})

test('Kimi 多 Agent 会话优先读取 main wire', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-kimi-main-'))
  const sessionRoot = path.join(root, 'sessions', 'project', 'session-1', 'agents')
  fs.mkdirSync(path.join(sessionRoot, 'agent-0'), { recursive: true })
  fs.mkdirSync(path.join(sessionRoot, 'main'), { recursive: true })
  fs.writeFileSync(path.join(sessionRoot, 'agent-0', 'wire.jsonl'), JSON.stringify({
    type: 'turn.prompt', promptId: 'internal', input: [{ type: 'text', text: '<git-context>' }], time: 1788500440000,
  }))
  fs.writeFileSync(path.join(sessionRoot, 'main', 'wire.jsonl'), [
    { type: 'turn.prompt', promptId: 'main-prompt', input: [{ type: 'text', text: '用户问题' }], time: 1788500441000 },
    { type: 'context.append_loop_event', turnId: 0, event: { type: 'content.part', turnId: 0, part: { type: 'text', text: '回答' } }, time: 1788500442000 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 1788500443000 },
  ].map(JSON.stringify).join('\n'))
  const previous = process.env.KIMI_HOME
  process.env.KIMI_HOME = root
  try {
    const snapshot = readKimiHistorySnapshot('session-1')
    assert.equal(snapshot.turns[0].items[0].item.content[0].text, '用户问题')
  } finally {
    if (previous === undefined) delete process.env.KIMI_HOME
    else process.env.KIMI_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Kimi 增量游标从运行中 Turn 起点重读直到确认完成', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-kimi-cursor-'))
  const wire = path.join(root, 'sessions', 'project', 'session-1', 'agents', 'main', 'wire.jsonl')
  fs.mkdirSync(path.dirname(wire), { recursive: true })
  fs.writeFileSync(wire, [
    { type: 'turn.prompt', promptId: 'prompt-1', input: [{ type: 'text', text: '第一轮' }], time: 1788500441000 },
    { type: 'context.append_loop_event', turnId: 0, event: { type: 'content.part', turnId: 0, part: { type: 'text', text: '完成' } }, time: 1788500442000 },
    { type: 'turn.ended', turnId: 0, reason: 'completed', time: 1788500443000 },
  ].map(JSON.stringify).join('\n') + '\n')
  const previous = process.env.KIMI_HOME
  process.env.KIMI_HOME = root
  try {
    const first = readKimiHistorySnapshot('session-1')
    const firstCursor = first.cursor
    fs.appendFileSync(wire, [
      { type: 'turn.prompt', promptId: 'prompt-2', input: [{ type: 'text', text: '第二轮' }], time: 1788500444000 },
      { type: 'context.append_loop_event', turnId: 1, event: { type: 'content.part', turnId: 1, part: { type: 'text', text: '写入中' } }, time: 1788500445000 },
    ].map(JSON.stringify).join('\n') + '\n')
    const running = readKimiHistorySnapshot('session-1', { cursor: firstCursor })
    assert.equal(running.completeness, 'incremental')
    assert.equal(running.turns[0].status, 'running')
    assert.equal(running.cursor, firstCursor)

    fs.appendFileSync(wire, `${JSON.stringify({ type: 'turn.ended', turnId: 1, reason: 'completed', time: 1788500446000 })}\n`)
    const completed = readKimiHistorySnapshot('session-1', { cursor: running.cursor })
    assert.equal(completed.turns[0].status, 'completed')
    assert.ok(completed.cursor > firstCursor)
  } finally {
    if (previous === undefined) delete process.env.KIMI_HOME
    else process.env.KIMI_HOME = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('Claude 增量游标保留运行中 Turn 的完整上下文', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-cursor-'))
  const cwd = path.join(root, 'workspace')
  const projectDir = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  const file = path.join(root, 'projects', projectDir, 'session-1.jsonl')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.mkdirSync(cwd)
  fs.writeFileSync(file, [
    { type: 'user', uuid: 'user-1', timestamp: '2026-09-04T10:00:00Z', message: { content: '第一轮' } },
    { type: 'assistant', uuid: 'answer-1', timestamp: '2026-09-04T10:00:01Z', message: { id: 'message-1', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成' }] } },
  ].map(JSON.stringify).join('\n') + '\n')
  const previous = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = root
  try {
    const first = readClaudeHistorySnapshot({ cwd, sessionId: 'session-1' })
    fs.appendFileSync(file, `${JSON.stringify({ type: 'user', uuid: 'user-2', timestamp: '2026-09-04T10:01:00Z', message: { content: '第二轮' } })}\n`)
    const running = readClaudeHistorySnapshot({ cwd, sessionId: 'session-1', cursor: first.cursor })
    assert.equal(running.turns[0].status, 'running')
    assert.equal(running.cursor, first.cursor)
    fs.appendFileSync(file, `${JSON.stringify({ type: 'assistant', uuid: 'answer-2', timestamp: '2026-09-04T10:01:01Z', message: { id: 'message-2', stop_reason: 'end_turn', content: [{ type: 'text', text: '完成二' }] } })}\n`)
    const completed = readClaudeHistorySnapshot({ cwd, sessionId: 'session-1', cursor: running.cursor })
    assert.equal(completed.turns[0].status, 'completed')
    assert.equal(completed.turns[0].items.at(-1).item.text, '完成二')
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previous
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('新版 Kimi 不会用上一轮 turn.ended 提前结束刚开始的 Turn', () => {
  const lines = [
    { type: 'turn.prompt', promptId: 'prompt-1', input: [{ type: 'text', text: '第一轮' }], time: 1788500442911 },
    { type: 'context.append_loop_event', turnId: 15, event: { type: 'content.part', turnId: 15, part: { type: 'text', text: '第一轮回复' } }, time: 1788500447051 },
    { type: 'turn.ended', turnId: 15, time: 1788500447052 },
    { type: 'prompt.completed', promptId: 'prompt-1', finishedAt: '2026-09-04T05:40:47.054Z' },
    { type: 'turn.prompt', promptId: 'prompt-2', input: [{ type: 'text', text: '继续' }], time: 1788500450000 },
    { type: 'context.append_loop_event', turnId: 16, event: { type: 'step.begin', turnId: 16 }, time: 1788500450001 },
  ]

  const snapshot = mapKimiHistorySnapshot('session_new', lines.map(JSON.stringify).join('\n'))

  assert.equal(snapshot.turns[0].status, 'completed')
  assert.equal(snapshot.turns[1].status, 'running')
  assert.equal(snapshot.turns[1].finishedAt, '2026-09-04T05:40:50.001Z')
})
