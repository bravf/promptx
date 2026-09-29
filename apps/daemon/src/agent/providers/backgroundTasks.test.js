import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeRuntime } from './claude.js'
import { CodexRuntime } from './codex.js'
import { grokProvider } from './grok.js'
import { AcpRuntime } from './acp.js'
import { mapClaudeHistorySnapshot } from '../history/providers/claudeHistory.js'

test('Claude 后台状态跨主轮次，自动续跑且子消息不会混入主正文', async () => {
  const runtime = new ClaudeRuntime({ cwd: '/tmp' })
  runtime.activeRunId = 'user-1'
  const starts = [], ends = [], messages = []
  runtime.on('turnStarted', event => starts.push(event))
  runtime.on('turnCompleted', event => ends.push(event))
  runtime.on('timeline', event => messages.push(event))
  async function* stream() {
    yield { type: 'system', subtype: 'task_started', task_id: 'child', tool_use_id: 'call', description: '分析', task_type: 'local_agent', is_backgrounded: true }
    yield { type: 'result', subtype: 'success' }
    assert.equal(runtime.backgroundTasks.running.length, 1)
    yield { type: 'assistant', parent_tool_use_id: 'call', message: { content: [{ type: 'text', text: '子结果' }] } }
    yield { type: 'system', subtype: 'task_notification', task_id: 'child', status: 'completed', summary: '子结果' }
    yield { type: 'assistant', uuid: 'auto-1', message: { id: 'answer', content: [{ type: 'text', text: '最终汇总' }] } }
    yield { type: 'result', subtype: 'success' }
    runtime.closing = true
  }
  runtime.runningQuery = stream()
  runtime.refreshContextUsage = async () => {}
  await runtime.consume(runtime.runningQuery, new AbortController())
  assert.equal(starts[0].autonomous, true)
  assert.equal(ends.length, 2)
  assert.equal(runtime.backgroundTasks.running.length, 0)
  assert.deepEqual(messages.map(item => item.text), ['最终汇总'])
})

test('Codex 子线程乱序消息被缓存，子完成不结束主 Turn', () => {
  const runtime = new CodexRuntime({ cwd: '/tmp', nativeHandle: { threadId: 'root' } })
  runtime.turnId = 'root-turn'
  const ends = [], messages = []
  runtime.on('turnCompleted', event => ends.push(event))
  runtime.on('timeline', event => messages.push(event))
  runtime.onNotification({ method: 'item/completed', params: { threadId: 'child', item: { type: 'agentMessage', text: '子结果' } } })
  runtime.onNotification({ method: 'item/completed', params: { threadId: 'root', item: { id: 'spawn', type: 'subAgentActivity', agentThreadId: 'child', agentPath: '/root/child', kind: 'started' } } })
  runtime.onNotification({ method: 'turn/completed', params: { threadId: 'child', turn: { id: 'child-turn', status: 'completed' } } })
  assert.equal(runtime.turnId, 'root-turn')
  assert.equal(ends.length, 0)
  assert.equal(messages.some(item => item.text === '子结果'), false)
  assert.equal(runtime.backgroundTasks.tasks.get('child').summary, '子结果')
  assert.equal(runtime.backgroundTasks.running.length, 0)
})

test('Grok 原生扩展识别子任务，忽略旧 attempt 结果与其他会话', () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp', nativeHandle: { sessionId: 'root' } })
  const send = update => runtime.onExtNotification('_x.ai/session_notification', { sessionId: 'root', update })
  send({ sessionUpdate: 'subagent_spawned', subagent_id: 'child', attempt_id: 'new', description: '分析' })
  send({ sessionUpdate: 'subagent_finished', subagent_id: 'child', attempt_id: 'old', status: 'completed' })
  assert.equal(runtime.backgroundTasks.running.length, 1)
  runtime.onExtNotification('_x.ai/session_notification', { sessionId: 'other', update: { sessionUpdate: 'subagent_finished', subagent_id: 'child', status: 'completed' } })
  assert.equal(runtime.backgroundTasks.running.length, 1)
  send({ sessionUpdate: 'subagent_finished', subagent_id: 'child', attempt_id: 'new', status: 'completed', output: '报告' })
  assert.equal(runtime.backgroundTasks.tasks.get('child').summary, '报告')
})

test('通用 ACP 不从 Task 工具名称猜测子任务，保留工具状态', () => {
  const runtime = new AcpRuntime()
  runtime.onSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'c', title: 'Task', status: 'in_progress' })
  assert.equal(runtime.backgroundTasks.tasks.size, 0)
  assert.equal(runtime.toolCalls.get('c').status, 'running')
})

test('Claude 历史把无用户输入的续跑分开，并保留同消息的 thinking/text', () => {
  const entries = [
    { type: 'user', uuid: 'u', message: { content: '任务' } },
    { type: 'assistant', uuid: 'a', message: { id: 'm1', stop_reason: 'end_turn', content: [{ type: 'text', text: '等待' }] } },
    { type: 'assistant', uuid: 'b', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '思考' }] } },
    { type: 'assistant', uuid: 'c', message: { id: 'm2', stop_reason: 'end_turn', content: [{ type: 'text', text: '汇总' }] } },
  ]
  const snapshot = mapClaudeHistorySnapshot('session', entries.map(JSON.stringify).join('\n'))
  assert.equal(snapshot.turns.length, 2)
  assert.equal(snapshot.turns[1].runtimeTurnId, 'claude:b')
  assert.equal(snapshot.turns[1].items.some(entry => entry.item.type === 'user_message'), false)
  assert.equal(snapshot.turns[1].items.at(-1).item.text, '汇总')
})

test('Grok 自动续跑使用稳定事件标识且可独立结束', () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp', nativeHandle: { sessionId: 'root' } })
  const starts = [], ends = []
  runtime.on('turnStarted', event => starts.push(event))
  runtime.on('turnCompleted', event => ends.push(event))
  runtime.onSessionNotification({ sessionId: 'root', _meta: { eventId: 'wake-1' }, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '自动汇总' } } })
  runtime.onExtNotification('_x.ai/session_notification', { sessionId: 'root', update: { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' } })
  assert.equal(starts[0].nativeTurnId, 'grok:auto:wake-1')
  assert.equal(ends[0].nativeTurnId, starts[0].nativeTurnId)
  assert.equal(runtime.activeRunId, null)
})

test('ACP 被替换的请求结束不会结算新请求', async () => {
  const runtime = new AcpRuntime()
  const ends = []
  let resolveOld
  runtime.connected = true
  runtime.connection = { prompt: () => new Promise(resolve => { resolveOld = resolve }) }
  runtime.on('turnCompleted', event => ends.push(event))
  await runtime.startTurn([{ type: 'text', text: 'old' }], 'old')
  runtime.connection = { prompt: async () => ({ stopReason: 'end_turn' }) }
  await runtime.startTurn([{ type: 'text', text: 'new' }], 'new')
  resolveOld({ stopReason: 'end_turn' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(ends.map(event => event.runId), ['new'])
})

test('Grok 停止子会话失败不能伪报成功', async () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp' })
  runtime.backgroundTasks.update({ id: 'child', childSessionId: 'child', status: 'running' })
  runtime.connection = { extMethod: async () => { throw new Error('拒绝停止') } }
  await assert.rejects(runtime.stopBackgroundTasks(), /拒绝停止/)
  assert.equal(runtime.backgroundTasks.running.length, 1)
})


test('ACP 准备用户输入时发生自动续跑，不覆盖自动轮次', async () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp', nativeHandle: { sessionId: 'root' } })
  let prompts = 0
  runtime.connection = { prompt: async () => { prompts += 1 } }
  runtime.connect = async () => {
    runtime.onSessionNotification({ sessionId: 'root', _meta: { eventId: 'racing-wake' }, update: {
      sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '自动汇总' },
    } })
  }
  await assert.rejects(runtime.startTurn([{ type: 'text', text: '用户消息' }], 'user'), /自动续跑/)
  assert.equal(runtime.activeRunId, 'grok:auto:racing-wake')
  assert.equal(prompts, 0)
})

test('Claude 实时占位不触发自动续跑，也不妨碍已有轮次结束', async () => {
  for (const active of [null, 'user-turn']) {
    const runtime = new ClaudeRuntime({ cwd: '/tmp' })
    runtime.activeRunId = active
    runtime.refreshContextUsage = async () => {}
    const starts = [], ends = [], messages = []
    runtime.on('turnStarted', event => starts.push(event))
    runtime.on('turnCompleted', event => ends.push(event))
    runtime.on('timeline', event => messages.push(event))
    async function* stream() {
      yield { type: 'assistant', uuid: 'placeholder', message: { id: 'placeholder', model: '<synthetic>', content: [{ type: 'text', text: 'No response requested.' }] } }
      yield { type: 'result', subtype: 'success' }
      yield { type: 'assistant', uuid: 'real', message: { id: 'real', model: 'claude', content: [{ type: 'text', text: 'No response requested.' }] } }
      yield { type: 'result', subtype: 'success' }
      runtime.closing = true
    }
    runtime.runningQuery = stream()
    await runtime.consume(runtime.runningQuery, new AbortController())
    assert.deepEqual(starts.map(event => event.nativeTurnId), ['claude:real'])
    assert.equal(ends.length, active ? 2 : 1)
    assert.deepEqual(messages.map(item => item.messageId), ['real'])
  }
})
