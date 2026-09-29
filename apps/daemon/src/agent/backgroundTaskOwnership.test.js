import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveBackgroundTaskOwnership } from './backgroundTaskOwnership.js'

test('子命令继承父任务归属，纠正旧轮次，乱序及多层任务可解析', () => {
  const tasks = [
    { id: 'shell', callId: 'shell-call', parentCallId: 'child-call', originTurnId: 'wrong' },
    { id: 'nested-shell', parentTaskId: 'shell', originTurnId: null },
    { id: 'child', callId: 'child-call', originTurnId: 'old' },
    { id: 'main-command', callId: 'main-call', originTurnId: 'old' },
    { id: 'orphan', parentCallId: 'missing', originTurnId: 'wrong' },
  ]
  const resolved = new Map(resolveBackgroundTaskOwnership(tasks, new Map([['child-call', 'request-1'], ['main-call', 'request-2']])).map(task => [task.id, task]))
  assert.equal(resolved.get('shell').parentTaskId, 'child')
  assert.equal(resolved.get('shell').originTurnId, 'request-1')
  assert.equal(resolved.get('nested-shell').originTurnId, 'request-1')
  assert.equal(resolved.get('main-command').originTurnId, 'request-2')
  assert.equal(resolved.get('orphan').originTurnId, null)
  assert.equal(tasks[0].originTurnId, 'wrong')
})
