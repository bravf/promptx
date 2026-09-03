import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { createApp } from './app.js'

function createControlTestRegistry() {
  const runtimes = []
  const models = [
    {
      id: 'model-a',
      label: 'Model A',
      defaultReasoningEffort: 'high',
      reasoningEfforts: [{ id: 'low', label: '低' }, { id: 'high', label: '高' }],
    },
    {
      id: 'model-b',
      label: 'Model B',
      defaultReasoningEffort: 'low',
      reasoningEfforts: [{ id: 'low', label: '低' }],
    },
  ]
  const provider = {
    id: 'codex',
    label: 'Codex Test',
    capabilities: { models: true, reasoningEffort: true, contextUsage: true },
    createRuntime(options) {
      const runtime = new EventEmitter()
      const selected = models.find((model) => model.id === options.modelId) || models[0]
      const requestedEffort = options.config?.reasoningEffort
      const currentReasoningEffort = selected.reasoningEfforts.some((item) => item.id === requestedEffort)
        ? requestedEffort
        : selected.defaultReasoningEffort
      runtime.options = options
      runtime.closed = false
      runtime.getControlState = async () => ({
        models,
        currentModelId: selected.id,
        reasoningEfforts: selected.reasoningEfforts,
        currentReasoningEffort,
        contextUsage: { usedTokens: 25, maxTokens: 100, percentage: 25, updatedAt: new Date().toISOString() },
      })
      runtime.startTurn = async (_content, clientMessageId) => ({ nativeTurnId: clientMessageId })
      runtime.cancel = async () => {}
      runtime.close = () => { runtime.closed = true }
      runtimes.push(runtime)
      return runtime
    },
  }
  return {
    runtimes,
    registry: {
      list: () => [{ id: provider.id, label: provider.label, capabilities: provider.capabilities }],
      get: (id) => {
        if (id !== provider.id) throw new Error(`不支持的 Provider：${id}`)
        return provider
      },
    },
  }
}

function multipartFile(name, mimeType, content) {
  const boundary = `promptx-${Date.now()}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${mimeType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return {
    body: Buffer.concat([head, Buffer.from(content), tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

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

  const turn = app.sqliteRepository.createTurn(agent.id, 'history-turn')
  app.sqliteRepository.updateTurn(turn.id, {
    status: 'completed',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z',
  })
  const turnsResponse = await app.inject({ method: 'GET', url: `/api/v2/agents/${agent.id}/turns?limit=20` })
  assert.equal(turnsResponse.statusCode, 200)
  assert.equal(turnsResponse.json().turns[0].id, turn.id)
  assert.equal(turnsResponse.json().turns[0].finishedAt, '2026-01-01T00:00:09.000Z')

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

test('v2 资产上传会持久化元数据并返回原始文件内容', async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-v2-assets-'))
  const app = await createApp({ databasePath: ':memory:', assetsDir, logger: false, webRoot: false })
  try {
    const workspaceResponse = await app.inject({ method: 'POST', url: '/api/v2/workspaces', payload: { cwd: process.cwd() } })
    const { workspace } = workspaceResponse.json()
    const upload = multipartFile('notes.txt', 'text/plain', 'asset-content')
    const uploadResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/workspaces/${workspace.id}/assets`,
      headers: { 'content-type': upload.contentType },
      payload: upload.body,
    })
    assert.equal(uploadResponse.statusCode, 201)
    const { asset } = uploadResponse.json()
    assert.equal(asset.name, 'notes.txt')
    assert.equal(asset.mimeType, 'text/plain')
    assert.equal(asset.size, 13)

    const contentResponse = await app.inject({ method: 'GET', url: `/api/v2/assets/${asset.id}/content` })
    assert.equal(contentResponse.statusCode, 200)
    assert.equal(contentResponse.body, 'asset-content')
    assert.match(contentResponse.headers['content-disposition'], /^attachment;/)
  } finally {
    await app.close()
    fs.rmSync(assetsDir, { recursive: true, force: true })
  }
})

test('Agent 控制接口持久化模型和思考强度，并在运行中拒绝切换', async () => {
  const { registry, runtimes } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, providerRegistry: registry })
  try {
    const workspaceResponse = await app.inject({ method: 'POST', url: '/api/v2/workspaces', payload: { cwd: process.cwd() } })
    const { agent } = workspaceResponse.json()

    const controlResponse = await app.inject({ method: 'GET', url: `/api/v2/agents/${agent.id}/control` })
    assert.equal(controlResponse.statusCode, 200)
    assert.equal(controlResponse.json().control.currentModelId, 'model-a')
    assert.equal(controlResponse.json().control.contextUsage.percentage, 25)

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/agents/${agent.id}/settings`,
      payload: { modelId: 'model-b' },
    })
    assert.equal(updateResponse.statusCode, 200)
    const updated = updateResponse.json()
    assert.equal(updated.agent.modelId, 'model-b')
    assert.equal(updated.agent.config.reasoningEffort, 'low')
    assert.equal(updated.control.currentReasoningEffort, 'low')
    assert.equal(runtimes[0].closed, true)

    const invalidResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/agents/${agent.id}/settings`,
      payload: { reasoningEffort: 'high' },
    })
    assert.equal(invalidResponse.statusCode, 400)

    const turnResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/agents/${agent.id}/turns`,
      payload: {
        clientMessageId: 'control-test-turn',
        input: { content: [{ type: 'text', text: '保持运行' }] },
      },
    })
    assert.equal(turnResponse.statusCode, 202)
    const runningUpdateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/agents/${agent.id}/settings`,
      payload: { modelId: 'model-a' },
    })
    assert.equal(runningUpdateResponse.statusCode, 409)
  } finally {
    await app.close()
  }
})
