import assert from 'node:assert/strict'
import test from 'node:test'
import { projectTimelineRows } from './timeline.js'

test('projectTimelineRows 合并文本增量和工具生命周期', () => {
  const rows = [
    { seq: 1, timestamp: '1', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: '你' } },
    { seq: 2, timestamp: '2', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: '好' } },
    { seq: 3, timestamp: '3', turnId: 't1', item: { type: 'tool_call', callId: 'c1', name: 'shell', status: 'running', detail: { type: 'shell', output: '' } } },
    { seq: 4, timestamp: '4', turnId: 't1', item: { type: 'tool_call', callId: 'c1', name: 'shell', status: 'completed', detail: { type: 'shell', output: 'ok' } } },
  ]

  const projected = projectTimelineRows(rows)
  assert.equal(projected.length, 2)
  assert.equal(projected[0].item.text, '你好')
  assert.equal(projected[1].item.status, 'completed')
  assert.equal(projected[1].item.detail.output, 'ok')
})

test('projectTimelineRows 不合并阶段不同的 Assistant 消息', () => {
  const projected = projectTimelineRows([
    { seq: 1, timestamp: '1', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'commentary', text: '先检查。' } },
    { seq: 2, timestamp: '2', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: '检查完成。' } },
  ])

  assert.equal(projected.length, 2)
  assert.deepEqual(projected.map((entry) => entry.item.phase), ['commentary', 'final_answer'])
})

test('projectTimelineRows 合并同一 Turn 中重复的 Assistant 错误和 Error', () => {
  const message = 'API Error: 503 No available accounts.'
  const projected = projectTimelineRows([
    { seq: 1, timestamp: '1', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: ` ${message}\n` } },
    { seq: 2, timestamp: '2', turnId: 't1', item: { type: 'error', code: 'provider_error', message } },
  ])

  assert.equal(projected.length, 1)
  assert.equal(projected[0].item.type, 'error')
  assert.equal(projected[0].item.message, message)
  assert.deepEqual(projected[0].collapsed, ['duplicate_provider_error'])
  assert.equal(projected[0].seqStart, 1)
  assert.equal(projected[0].seqEnd, 2)
})

test('projectTimelineRows 保留内容不同的 Assistant 消息和 Error', () => {
  const projected = projectTimelineRows([
    { seq: 1, timestamp: '1', turnId: 't1', item: { type: 'assistant_message', messageId: 'm1', phase: 'final_answer', text: '已经完成部分工作。' } },
    { seq: 2, timestamp: '2', turnId: 't1', item: { type: 'error', code: 'provider_error', message: '连接中断。' } },
  ])

  assert.equal(projected.length, 2)
  assert.equal(projected[0].item.type, 'assistant_message')
  assert.equal(projected[1].item.type, 'error')
})
