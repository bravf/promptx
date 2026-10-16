import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isTimelineAtBottom } from './timelineViewport.js'

test('内容不足一屏时视为位于 Timeline 底部', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 500, clientHeight: 600, scrollTop: 0 }), true)
})

test('落到底部的小数误差内继续跟随新消息', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 }), true)
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 598 }), true)
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 598.5 }), true)
})

test('距离底部仍有可见间隙时停止跟随新消息', () => {
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 597 }), false)
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 536 }), false)
  assert.equal(isTimelineAtBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 568 }), false)
})
