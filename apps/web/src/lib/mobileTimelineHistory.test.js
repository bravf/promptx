import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMobileTimelineHistoryState, hasMobileTimelineHistoryState } from './mobileTimelineHistory.js'

test('Timeline history 状态保留 Vue Router 已有字段', () => {
  const state = createMobileTimelineHistoryState({ current: '/', position: 3 })
  assert.deepEqual(state, {
    current: '/',
    position: 3,
    promptxV2MobileView: 'timeline',
  })
  assert.equal(hasMobileTimelineHistoryState(state), true)
  assert.equal(hasMobileTimelineHistoryState({ current: '/' }), false)
})
