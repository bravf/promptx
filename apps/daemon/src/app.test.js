import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createApp } from './app.js'

test('CORS 预检允许 v2 的 PATCH 和 DELETE 请求', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false })

  for (const method of ['PATCH', 'DELETE']) {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/agents/example',
      headers: {
        origin: 'http://127.0.0.1:5174',
        'access-control-request-method': method,
      },
    })
    assert.equal(response.statusCode, 204)
    const allowedMethods = response.headers['access-control-allow-methods'].split(',').map((item) => item.trim())
    assert.ok(allowedMethods.includes(method))
  }

  await app.close()
})

test('Workspace、Agent 和 Timeline API 形成完整基础链路', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false })

  const workspaceResponse = await app.inject({ method: 'POST', url: '/api/v2/workspaces', payload: { cwd: process.cwd() } })
  assert.equal(workspaceResponse.statusCode, 201)
  const { workspace, agent } = workspaceResponse.json()
  assert.equal(agent.providerId, 'codex')
  assert.equal(agent.lifecycle, 'ready')

  const agentsResponse = await app.inject({ method: 'GET', url: `/api/v2/workspaces/${workspace.id}/agents` })
  assert.equal(agentsResponse.statusCode, 200)
  assert.deepEqual(agentsResponse.json().agents.map((item) => item.id), [agent.id])

  app.sqliteRepository.appendTimeline(agent.id, null, { type: 'system_notice', code: 'ready', text: '已就绪' })
  const timelineResponse = await app.inject({ method: 'GET', url: `/api/v2/agents/${agent.id}/timeline` })
  assert.equal(timelineResponse.statusCode, 200)
  assert.equal(timelineResponse.json().timeline.rows[0].item.text, '已就绪')

  await app.close()
})

test('重复添加工作区不会重复创建默认 Agent，且 Agent 可以删除', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false })

  const firstResponse = await app.inject({ method: 'POST', url: '/api/v2/workspaces', payload: { cwd: process.cwd() } })
  const secondResponse = await app.inject({ method: 'POST', url: '/api/v2/workspaces', payload: { cwd: process.cwd() } })
  const first = firstResponse.json()
  const second = secondResponse.json()
  assert.equal(second.workspace.id, first.workspace.id)
  assert.equal(second.agent.id, first.agent.id)

  const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/v2/agents/${first.agent.id}` })
  assert.equal(deleteResponse.statusCode, 204)
  const agentsResponse = await app.inject({ method: 'GET', url: `/api/v2/workspaces/${first.workspace.id}/agents` })
  assert.deepEqual(agentsResponse.json().agents, [])

  await app.close()
})
