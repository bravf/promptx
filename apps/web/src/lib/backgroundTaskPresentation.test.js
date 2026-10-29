import assert from 'node:assert/strict'
import test from 'node:test'
import { buildBackgroundTaskTree, groupBackgroundTasks, sessionActivity } from './backgroundTaskPresentation.js'

test('前台完成后后台仍执行，常驻任务不阻止完成', () => {
  assert.equal(sessionActivity({ lifecycle: 'ready', backgroundTasks: [{ status: 'running' }] }).running, true)
  assert.equal(sessionActivity({ lifecycle: 'running', backgroundTasks: [] }).running, true)
  assert.equal(sessionActivity({ lifecycle: 'ready', backgroundTasks: [{ status: 'completed' }, { status: 'running', ambient: true }] }).running, false)
})

test('工作流收尾期间持续阻塞发送，不把工作流计为子 Agent，等待提问仍阻塞新消息', () => {
  const task = { lifecycle: 'ready', backgroundTasks: [{ kind: 'workflow', status: 'running' }, { kind: 'local_agent', status: 'completed' }] }
  const activity = sessionActivity(task)
  assert.equal(activity.busy, true)
  assert.equal(activity.count, 0)
  assert.equal(activity.workflowCount, 1)
  assert.equal(activity.label, '等待工作流收尾')
  task.attentionReason = 'permission'
  assert.equal(sessionActivity(task).running, false)
  assert.equal(sessionActivity(task).busy, true)
  delete task.attentionReason
  task.backgroundTasks[0].status = 'completed'
  assert.equal(sessionActivity(task).busy, false)
})

test('跨轮次子任务保留发起轮次，未知来源独立归组', () => {
  const tasks = [{ id: 'a', originTurnId: 'first' }, { id: 'b', originTurnId: 'second' }, { id: 'c' }, { id: 'd', ambient: true }]
  const groups = groupBackgroundTasks(tasks)
  assert.deepEqual(groups.get('first').map(item => item.id), ['a'])
  assert.deepEqual(groups.get('second').map(item => item.id), ['b'])
  assert.deepEqual(groups.get('').map(item => item.id), ['c'])
})

test('子命令随父 Agent 归组并嵌套，未知父及循环不丢任务', () => {
  const tasks = [{ id: 'command', parentTaskId: 'agent', originTurnId: 'wrong' }, { id: 'agent', originTurnId: 'request' }, { id: 'main', originTurnId: 'request' }]
  assert.equal(groupBackgroundTasks(tasks).get('request').length, 3)
  const tree = buildBackgroundTaskTree(tasks)
  assert.deepEqual(tree.map(item => item.id), ['agent', 'main'])
  assert.equal(tree[0].children[0].id, 'command')
  assert.equal(buildBackgroundTaskTree([{ id: 'a', parentTaskId: 'b' }, { id: 'b', parentTaskId: 'a' }, { id: 'c', parentTaskId: 'missing' }]).length, 3)
})
