import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AcpRuntime } from './acp.js'
import { ClaudeRuntime } from './claude.js'
import { CodexRuntime } from './codex.js'

test('Codex 按 agentMessage phase 区分过程说明和最终回复', () => {
  const runtime = new CodexRuntime({ cwd: process.cwd() })
  const items = []
  runtime.on('timeline', (item) => items.push(item))

  runtime.onNotification({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: '' } } })
  runtime.onNotification({ method: 'item/agentMessage/delta', params: { itemId: 'commentary', delta: '我先检查项目。' } })
  runtime.onNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'commentary', phase: 'commentary', text: '我先检查项目。' } } })
  runtime.onNotification({ method: 'item/started', params: { item: { type: 'agentMessage', id: 'answer', phase: 'final_answer', text: '' } } })
  runtime.onNotification({ method: 'item/agentMessage/delta', params: { itemId: 'answer', delta: '项目分析完成。' } })

  assert.deepEqual(items.map((item) => item.phase), ['commentary', 'final_answer'])
})

test('Codex 可重试错误保留 Turn，并写入重试提示', () => {
  const runtime = new CodexRuntime({ cwd: process.cwd(), nativeHandle: { threadId: 'thread-current' } })
  runtime.turnId = 'turn-current'
  const items = []
  const failures = []
  runtime.on('timeline', (item) => items.push(item))
  runtime.on('turnFailed', (error) => failures.push(error))

  runtime.onNotification({
    method: 'error',
    params: {
      threadId: 'thread-current',
      turnId: 'turn-current',
      willRetry: true,
      error: { message: 'upstream returned 502' },
    },
  })

  assert.deepEqual(items, [{
    type: 'system_notice',
    code: 'provider_retrying',
    text: '模型服务连接异常，Codex 正在自动重试。',
  }])
  assert.equal(failures.length, 0)
})

test('Codex 不可重试错误结束当前 Turn，忽略其他 Turn 的错误', () => {
  const runtime = new CodexRuntime({ cwd: process.cwd(), nativeHandle: { threadId: 'thread-current' } })
  runtime.turnId = 'turn-current'
  const failures = []
  runtime.on('turnFailed', (error) => failures.push(error))

  runtime.onNotification({
    method: 'error',
    params: { threadId: 'thread-other', turnId: 'turn-current', willRetry: false, error: { message: 'other thread' } },
  })
  runtime.onNotification({
    method: 'error',
    params: { threadId: 'thread-current', turnId: 'turn-other', willRetry: false, error: { message: 'other turn' } },
  })
  runtime.onNotification({
    method: 'error',
    params: { threadId: 'thread-current', turnId: 'turn-current', willRetry: false, error: { message: '最终失败' } },
  })

  assert.deepEqual(failures.map((error) => error.message), ['最终失败'])
})

test('Claude 按工具调用、结束原因和子 Agent 标记设置消息阶段', () => {
  const runtime = new ClaudeRuntime({ cwd: process.cwd() })
  const items = []
  runtime.on('timeline', (item) => items.push(item))

  runtime.consumeAssistant({
    parent_tool_use_id: null,
    message: { id: 'tool-step', stop_reason: 'tool_use', content: [{ type: 'text', text: '先读取文件。' }, { type: 'tool_use', id: 'tool', name: 'Read', input: {} }] },
  })
  runtime.consumeAssistant({
    parent_tool_use_id: null,
    message: { id: 'answer', stop_reason: 'end_turn', content: [{ type: 'text', text: '读取完成。' }] },
  })
  runtime.consumeAssistant({
    parent_tool_use_id: 'parent-tool',
    message: { id: 'subagent', stop_reason: 'end_turn', content: [{ type: 'text', text: '子任务完成。' }] },
  })

  assert.deepEqual(items.filter((item) => item.type === 'assistant_message').map((item) => item.phase), ['commentary', 'final_answer', 'commentary'])
})

test('ACP 将 thought 放入过程，将 agent message 标记为最终回复', () => {
  const runtime = new AcpRuntime({ cwd: process.cwd() })
  const items = []
  runtime.on('timeline', (item) => items.push(item))

  runtime.onSessionUpdate({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: '正在分析。' } })
  runtime.onSessionUpdate({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '分析完成。' } })

  assert.deepEqual(items.map((item) => [item.type, item.phase]), [
    ['reasoning', undefined],
    ['assistant_message', 'final_answer'],
  ])
})
