import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  SPLIT_TIMELINE_STORAGE_KEY,
  readSplitTimelineState,
  resolveSplitTimelineState,
  writeSplitTimelineState,
} from './splitTimelineStorage.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

test('拆屏布局可以持久化并过滤重复会话', () => {
  const storage = memoryStorage()
  writeSplitTimelineState({ enabled: true, primaryTaskId: ' a ', secondaryTaskId: 'a', focusedPane: 'secondary' }, storage)
  assert.ok(storage.getItem(SPLIT_TIMELINE_STORAGE_KEY))
  assert.deepEqual(readSplitTimelineState(storage), {
    enabled: true,
    primaryTaskId: 'a',
    secondaryTaskId: '',
    focusedPane: 'secondary',
  })
})

test('无效会话会降级并把有效的次窗格提升为主窗格', () => {
  assert.deepEqual(resolveSplitTimelineState({
    enabled: true,
    primaryTaskId: 'missing',
    secondaryTaskId: 'task-2',
    focusedPane: 'secondary',
  }, ['task-1', 'task-2']), {
    enabled: false,
    primaryTaskId: 'task-2',
    secondaryTaskId: '',
    focusedPane: 'primary',
  })
})

test('关闭拆屏时不恢复次窗格', () => {
  assert.deepEqual(resolveSplitTimelineState({
    enabled: false,
    primaryTaskId: 'task-1',
    secondaryTaskId: 'task-2',
    focusedPane: 'secondary',
  }, ['task-1', 'task-2']), {
    enabled: false,
    primaryTaskId: 'task-1',
    secondaryTaskId: '',
    focusedPane: 'primary',
  })
})

test('损坏的存储内容会静默回退', () => {
  const storage = { getItem: () => '{bad json' }
  assert.deepEqual(readSplitTimelineState(storage), {
    enabled: false,
    primaryTaskId: '',
    secondaryTaskId: '',
    focusedPane: 'primary',
  })
})
