import assert from 'node:assert/strict'
import test from 'node:test'

import { parseEventBlock } from './eventSource.js'

test('SSE 解析器保留事件类型、游标和多行数据', () => {
  assert.deepEqual(parseEventBlock([
    'id: epoch-1:42',
    'event: timeline',
    'data: {"row":',
    'data: {"seq":42}}',
  ].join('\n')), {
    type: 'timeline',
    id: 'epoch-1:42',
    data: '{"row":\n{"seq":42}}',
  })
})

test('SSE 解析器忽略 heartbeat 和空事件', () => {
  assert.equal(parseEventBlock(': heartbeat'), null)
  assert.equal(parseEventBlock('event: ping'), null)
})
