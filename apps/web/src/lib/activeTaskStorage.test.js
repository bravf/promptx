import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ACTIVE_TASK_STORAGE_KEY, readActiveTaskId, writeActiveTaskId } from './activeTaskStorage.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('当前会话 ID 可以持久化和清除', () => {
  const storage = memoryStorage()
  writeActiveTaskId(' task-2 ', storage)
  assert.equal(storage.getItem(ACTIVE_TASK_STORAGE_KEY), 'task-2')
  assert.equal(readActiveTaskId(storage), 'task-2')

  writeActiveTaskId('', storage)
  assert.equal(readActiveTaskId(storage), '')
})

test('存储不可用时静默回退', () => {
  const storage = {
    getItem() { throw new Error('disabled') },
    setItem() { throw new Error('disabled') },
    removeItem() { throw new Error('disabled') },
  }
  assert.equal(readActiveTaskId(storage), '')
  assert.doesNotThrow(() => writeActiveTaskId('task-1', storage))
})
