import assert from 'node:assert/strict'
import test from 'node:test'
import { groupBackgroundTasks, sessionActivity } from './backgroundTaskPresentation.js'

test('前台完成后后台仍执行，常驻任务不阻止完成', () => {
  assert.equal(sessionActivity({ lifecycle: 'ready', backgroundTasks: [{ status: 'running' }] }).running, true)
  assert.equal(sessionActivity({ lifecycle: 'running', backgroundTasks: [] }).running, true)
  assert.equal(sessionActivity({ lifecycle: 'ready', backgroundTasks: [{ status: 'completed' }, { status: 'running', ambient: true }] }).running, false)
})

test('跨轮次子任务保留发起轮次，未知来源独立归组', () => {
  const tasks = [{ id: 'a', originTurnId: 'first' }, { id: 'b', originTurnId: 'second' }, { id: 'c' }, { id: 'd', ambient: true }]
  const groups = groupBackgroundTasks(tasks)
  assert.deepEqual(groups.get('first').map(item => item.id), ['a'])
  assert.deepEqual(groups.get('second').map(item => item.id), ['b'])
  assert.deepEqual(groups.get('').map(item => item.id), ['c'])
})
