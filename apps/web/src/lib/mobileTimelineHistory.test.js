import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMobileTimelineHistoryState, getMobileTimelineTaskId, hasMobileTimelineHistoryState } from './mobileTimelineHistory.js'

test('Timeline history 状态保留 Vue Router 已有字段', () => {
  const state = createMobileTimelineHistoryState({ current: '/', position: 3 }, 'task-2')
  assert.deepEqual(state, {
    current: '/',
    position: 3,
    promptxV2MobileView: 'timeline',
    promptxV2MobileTaskId: 'task-2',
  })
  assert.equal(hasMobileTimelineHistoryState(state), true)
  assert.equal(getMobileTimelineTaskId(state), 'task-2')
  assert.equal(hasMobileTimelineHistoryState({ current: '/' }), false)
  assert.equal(getMobileTimelineTaskId({ promptxV2MobileTaskId: 'task-2' }), '')
})
