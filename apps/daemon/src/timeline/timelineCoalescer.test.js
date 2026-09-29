import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { TimelineCoalescer } from './timelineCoalescer.js'

test('仅合并相邻同 phase 文本，保留工具与 final 的顺序', () => {
  const result = [], coalescer = new TimelineCoalescer(event => result.push(event.item))
  const push = item => coalescer.push('a', { agentId: 'a', turnId: 't', item })
  push({ type: 'assistant_message', messageId: 'm', phase: 'commentary', text: 'A' })
  push({ type: 'assistant_message', messageId: 'm', phase: 'commentary', text: 'B' })
  push({ type: 'tool_call', callId: 'c', status: 'running' })
  push({ type: 'assistant_message', messageId: 'm', phase: 'commentary', text: 'C' })
  push({ type: 'assistant_message', messageId: 'm', phase: 'final_answer', text: 'D' })
  coalescer.flushAll()
  assert.deepEqual(result.map(item => item.text || item.type), ['AB', 'tool_call', 'C', 'D'])
  assert.equal(result.at(-1).phase, 'final_answer')
})

test('定时写入失败不会丢弃待写记录，恢复后继续写入且不重复已写记录', async () => {
  let failed = true
  const result = [], errors = []
  const coalescer = new TimelineCoalescer(event => {
    if (event.item.text === 'B' && failed) throw new Error('模拟写入失败')
    result.push(event.item.text)
  }, 5, error => errors.push(error))
  for (const text of ['A', 'B', 'C']) coalescer.push('a', { item: { type: 'assistant_message', messageId: text, text } })
  await delay(20)
  assert.equal(errors.length, 1)
  assert.deepEqual(result, ['A'])
  failed = false
  coalescer.flushAll()
  assert.deepEqual(result, ['A', 'B', 'C'])
})
