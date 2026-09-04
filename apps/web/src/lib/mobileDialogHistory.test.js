import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createMobileDialogHistoryState, getMobileDialogHistoryState } from './mobileDialogHistory.js'

test('弹层 history 状态保留路由和 Timeline 字段', () => {
  const state = createMobileDialogHistoryState({ current: '/', promptxV2MobileView: 'timeline' }, 'settings')
  assert.deepEqual(state, {
    current: '/',
    promptxV2MobileView: 'timeline',
    promptxV2MobileDialog: 'settings',
  })
  assert.equal(getMobileDialogHistoryState(state), 'settings')
})

test('弹层 history 忽略未知弹层', () => {
  const state = createMobileDialogHistoryState({ current: '/' }, 'unknown')
  assert.deepEqual(state, { current: '/' })
  assert.equal(getMobileDialogHistoryState({ promptxV2MobileDialog: 'unknown' }), '')
})
