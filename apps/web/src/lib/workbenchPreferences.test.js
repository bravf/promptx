import assert from 'node:assert/strict'
import test from 'node:test'

import {
  WORKBENCH_PREFERENCE_KEYS,
  WORKBENCH_SEND_BEHAVIOR,
  getWorkbenchPreference,
  initializeWorkbenchPreferences,
  setWorkbenchPreference,
  shouldSendOnWorkbenchKeydown,
} from './workbenchPreferences.js'

test('initializeWorkbenchPreferences falls back to shift+enter send behavior', () => {
  const preferences = initializeWorkbenchPreferences()

  assert.equal(preferences.sendBehavior, WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER)
  assert.equal(preferences.notificationSoundEnabled, false)
  assert.equal(getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR), WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER)
  assert.equal(getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED), false)
})

test('setWorkbenchPreference normalizes unknown send behavior to shift+enter', () => {
  setWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR, 'unknown')

  assert.equal(getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR), WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER)
})

test('setWorkbenchPreference normalizes notification sound flag to boolean', () => {
  setWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED, 'true')
  assert.equal(getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED), true)

  setWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED, 'off')
  assert.equal(getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED), false)
})

test('shouldSendOnWorkbenchKeydown respects enter send behavior', () => {
  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.ENTER,
    isEditing: true,
    isComposing: false,
  }), true)

  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.ENTER,
    isEditing: true,
    isComposing: false,
  }), false)
})

test('shouldSendOnWorkbenchKeydown respects shift+enter send behavior', () => {
  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
    isEditing: true,
    isComposing: false,
  }), true)

  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
    isEditing: true,
    isComposing: false,
  }), false)
})

test('shouldSendOnWorkbenchKeydown blocks button-only, non-editing, and composing states', () => {
  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.BUTTON_ONLY,
    isEditing: true,
    isComposing: false,
  }), false)

  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
    isEditing: false,
    isComposing: false,
  }), false)

  assert.equal(shouldSendOnWorkbenchKeydown({
    key: 'Enter',
    shiftKey: true,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
  }, {
    sendBehavior: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
    isEditing: true,
    isComposing: true,
  }), false)
})
