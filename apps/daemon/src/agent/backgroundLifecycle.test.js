import assert from 'node:assert/strict'
import test from 'node:test'
import { AgentManager } from './agentManager.js'
import { grokProvider } from './providers/grok.js'

test('后台运行阻止配置变更，但保留独立的前台忙碌判断', async () => {
  const manager = new AgentManager({ repository: { getAgent: () => ({ backgroundTasks: [{ status: 'running' }] }) } })
  assert.equal(manager.isBusy('a'), true)
  assert.equal(manager.isBusy('a', { includeBackground: false }), false)
  await assert.rejects(manager.updateSettings('a', { modelId: 'other' }), error => error.statusCode === 409)
})

test('停止全部：一个子任务失败仍停止其他子任务及主任务，并返回失败原因', async () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp' })
  for (const id of ['failed', 'other']) runtime.backgroundTasks.update({ id, childSessionId: id, status: 'running' })
  const attempts = []
  runtime.connection = { extMethod: async (_method, { sessionId }) => {
    attempts.push(sessionId)
    if (sessionId === 'failed') throw new Error('停止失败')
  } }
  let canceled = false
  runtime.cancel = async () => { canceled = true }
  const manager = new AgentManager({ repository: { getAgent: () => null } })
  manager.runtimes.set('a', runtime)
  manager.activeTurns.set('a', { id: 'turn' })
  await assert.rejects(manager.cancel('a', { all: true }), /停止失败/)
  assert.deepEqual(attempts, ['failed', 'other'])
  assert.equal(canceled, true)
  assert.equal(runtime.backgroundTasks.tasks.get('failed').status, 'running')
  assert.equal(runtime.backgroundTasks.tasks.get('other').status, 'canceled')
})
