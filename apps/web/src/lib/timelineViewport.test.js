import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTimelineAtBottom } from './timelineViewport.js'

test('内容不足一屏时视为位于 Timeline 底部', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 500, clientHeight: 600, scrollTop: 0 }), true)
})

test('距离底部阈值内继续跟随新消息', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 536 }), true)
})

test('用户离开底部后停止跟随新消息', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 535 }), false)
})
