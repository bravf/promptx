import assert from 'node:assert/strict'
import { test } from 'node:test'
import { COLLAPSED_PROJECTS_STORAGE_KEY, readCollapsedProjectIds, writeCollapsedProjectIds } from './projectExpansionStorage.js'

function memoryStorage() {
  const values = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  }
}

test('已折叠工作区 ID 可以持久化、去重和清除', () => {
  const storage = memoryStorage()
  writeCollapsedProjectIds([' project-2 ', 'project-1', 'project-2', ''], storage)

  assert.equal(storage.getItem(COLLAPSED_PROJECTS_STORAGE_KEY), '["project-2","project-1"]')
  assert.deepEqual(readCollapsedProjectIds(storage), ['project-2', 'project-1'])

  writeCollapsedProjectIds([], storage)
  assert.deepEqual(readCollapsedProjectIds(storage), [])
})

test('无效数据和不可用存储会静默回退', () => {
  const malformedStorage = memoryStorage()
  malformedStorage.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, '{invalid')
  assert.deepEqual(readCollapsedProjectIds(malformedStorage), [])

  const unavailableStorage = {
    getItem() { throw new Error('disabled') },
    setItem() { throw new Error('disabled') },
    removeItem() { throw new Error('disabled') },
  }
  assert.deepEqual(readCollapsedProjectIds(unavailableStorage), [])
  assert.doesNotThrow(() => writeCollapsedProjectIds(['project-1'], unavailableStorage))
})
