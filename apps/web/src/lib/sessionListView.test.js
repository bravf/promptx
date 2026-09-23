import assert from 'node:assert/strict'
import test from 'node:test'
import { groupRecentSessions, readSessionListView, writeSessionListView } from './sessionListView.js'

test('最近列表跨工作区排序，置顶只出现一次，不改变工作区列表顺序', () => {
  const now = new Date(2026, 8, 23, 12)
  const iso = (day, hour = 12) => new Date(2026, 8, day, hour).toISOString()
  const tasks = [
    { id: 'old', lastActiveAt: iso(1) },
    { id: 'yesterday', lastActiveAt: iso(22, 23) },
    { id: 'pinned', pinnedAt: iso(10), lastActiveAt: iso(1) },
    { id: 'today', projectId: 'a', lastActiveAt: iso(23, 0) },
    { id: 'newest', projectId: 'b', lastActiveAt: iso(23, 11) },
    { id: 'monday', lastActiveAt: iso(21) },
    { id: 'unknown', lastActiveAt: 'invalid' },
  ]
  const original = tasks.map(task => task.id)
  const groups = groupRecentSessions(tasks, now)
  assert.deepEqual(groups.map(group => group.label), ['置顶', '今天', '昨天', '星期一', '9月', '更早'])
  assert.deepEqual(groups[1].tasks.map(task => task.id), ['newest', 'today'])
  assert.deepEqual(tasks.map(task => task.id), original)
  assert.equal(groups.flatMap(group => group.tasks).length, tasks.length)
  assert.deepEqual(groupRecentSessions([], now), [])
})

test('按本地日期区分跨年昨天，缺少活动时间时回退创建时间', () => {
  const groups = groupRecentSessions([
    { id: 'yesterday', createdAt: new Date(2025, 11, 31, 23, 59).toISOString() },
    { id: 'older', createdAt: new Date(2025, 10, 1).toISOString() },
  ], new Date(2026, 0, 1, 0, 1))
  assert.deepEqual(groups.map(group => group.label), ['昨天', '2025年11月'])
})

test('视图偏好持久化，损坏值或存储不可用时回退工作区', () => {
  let value
  const storage = { getItem: () => value, setItem: (_, next) => { value = next } }
  assert.equal(readSessionListView(storage), 'workspace')
  writeSessionListView('recent', storage)
  assert.equal(readSessionListView(storage), 'recent')
  value = 'invalid'
  assert.equal(readSessionListView(storage), 'workspace')
  const blocked = { getItem() { throw new Error() }, setItem() { throw new Error() } }
  assert.equal(readSessionListView(blocked), 'workspace')
  assert.doesNotThrow(() => writeSessionListView('recent', blocked))
})
