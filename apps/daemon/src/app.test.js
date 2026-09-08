import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { spawnSync } from 'node:child_process'
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

async function createLocalTask(app, input) {
  const projectResponse = await app.inject({
    method: 'POST',
    url: '/api/v2/projects',
    payload: { repositoryRoot: input.cwd, displayName: input.title },
  })
  if (projectResponse.statusCode !== 201) return projectResponse
  const project = projectResponse.json().project
  const taskResponse = await app.inject({
    method: 'POST',
    url: `/api/v2/projects/${project.id}/tasks`,
    payload: {
      providerId: input.providerId,
      title: input.title,
      executionKind: 'local',
    },
  })
  const payload = taskResponse.json()
  return {
    ...taskResponse,
    json: () => ({ ...payload, project }),
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

test('前端重新构建后的新资源可直接读取，缺失资源不返回 HTML', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-rebuild-assets-'))
  let app
  t.after(async () => {
    await app?.close()
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  const webRoot = path.join(root, 'web')
  fs.mkdirSync(path.join(webRoot, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(webRoot, 'index.html'), '<html>PromptX</html>')
  app = await createApp({
    databasePath: ':memory:', assetsDir: path.join(root, 'uploads'), logger: false, webRoot, relay: false,
    relayOptions: { configPath: path.join(root, 'relay.json'), identityPath: path.join(root, 'identity.json') },
  })
  await app.ready()
  fs.writeFileSync(path.join(webRoot, 'assets', 'new-build.js'), 'export const rebuilt = true')
  const asset = await app.inject({ method: 'GET', url: '/assets/new-build.js' })
  assert.equal(asset.statusCode, 200)
  assert.match(asset.headers['content-type'], /javascript/)
  assert.equal(asset.body, 'export const rebuilt = true')
  assert.equal((await app.inject({ method: 'GET', url: '/assets/missing.js' })).statusCode, 404)
  assert.match((await app.inject({ method: 'GET', url: '/workbench' })).body, /<html>PromptX/)
})

test('CORS 预检允许 v2 的 PATCH 和 DELETE 请求', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })

  for (const method of ['PATCH', 'DELETE']) {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/tasks/example',
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

test('Daemon 拒绝未授权网页来源访问 API', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })
  try {
    const preflight = await app.inject({
      method: 'OPTIONS',
      url: '/api/v2/projects',
      headers: {
        origin: 'https://evil.example',
        'access-control-request-method': 'DELETE',
      },
    })
    assert.equal(preflight.statusCode, 403)
    assert.equal(preflight.headers['access-control-allow-origin'], undefined)

    const request = await app.inject({
      method: 'GET',
      url: '/api/v2/projects',
      headers: { origin: 'https://evil.example' },
    })
    assert.equal(request.statusCode, 403)
    assert.equal(request.json().error, 'origin_not_allowed')
  } finally {
    await app.close()
  }
})

test('Daemon 允许正式版同源网页访问 API', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/providers',
      headers: { origin: 'http://127.0.0.1:3001' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:3001')
  } finally {
    await app.close()
  }
})

test('Daemon 允许 5175 Vite 开发端口访问 API', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })
  try {
    const response = await app.inject({
      method: 'GET',
      url: '/api/v2/providers',
      headers: { origin: 'http://127.0.0.1:5175' },
    })
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['access-control-allow-origin'], 'http://127.0.0.1:5175')
  } finally {
    await app.close()
  }
})

test('可预期的工作区和 Relay 配置输入错误返回 400 与中文提示', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-input-errors-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    webRoot: false,
    relay: false,
    relayOptions: {
      configPath: path.join(root, 'relay-config.json'),
      identityPath: path.join(root, 'relay-identity.json'),
    },
  })
  try {
    const projectResponse = await app.inject({
      method: 'POST',
      url: '/api/v2/projects',
      payload: { repositoryRoot: path.join(root, 'missing') },
    })
    assert.equal(projectResponse.statusCode, 400)
    assert.equal(projectResponse.json().message, '工作区路径不存在或无法访问。')

    const relayResponse = await app.inject({
      method: 'PUT',
      url: '/api/v2/relay/config',
      payload: { relayUrl: 'invalid-relay-url' },
    })
    assert.equal(relayResponse.statusCode, 400)
    assert.equal(relayResponse.json().message, 'Relay 地址格式无效。')
  } finally {
    await app.close()
  }
})

test('Project、Task 和 Timeline API 形成完整基础链路', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })

  const workspaceResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'claude' })
  assert.equal(workspaceResponse.statusCode, 201)
  const { task, agent } = workspaceResponse.json()
  assert.equal(agent.providerId, 'claude')
  assert.equal(agent.lifecycle, 'ready')

  const agentResponse = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/agent` })
  assert.equal(agentResponse.statusCode, 200)
  assert.equal(agentResponse.json().agent.id, agent.id)

  app.sqliteRepository.appendTimeline(agent.taskId, null, { type: 'system_notice', code: 'ready', text: '已就绪' })
  const timelineResponse = await app.inject({ method: 'GET', url: `/api/v2/tasks/${agent.taskId}/timeline` })
  assert.equal(timelineResponse.statusCode, 200)
  assert.equal(timelineResponse.json().timeline.rows[0].item.text, '已就绪')

  const turn = app.sqliteRepository.createTurn(task.id, 'history-turn')
  app.sqliteRepository.updateTurn(turn.id, {
    status: 'completed',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:09.000Z',
  })
  const turnsResponse = await app.inject({ method: 'GET', url: `/api/v2/tasks/${agent.taskId}/turns?limit=20` })
  assert.equal(turnsResponse.statusCode, 200)
  assert.equal(turnsResponse.json().turns[0].id, turn.id)
  assert.equal(turnsResponse.json().turns[0].finishedAt, '2026-01-01T00:00:09.000Z')

  await app.close()
})

test('本机目录选择 API 返回路径并拒绝 Relay 远程触发', async () => {
  const calls = []
  const app = await createApp({
    databasePath: ':memory:',
    logger: false,
    webRoot: false,
    relay: false,
    directoryPicker: async (input) => {
      calls.push(input)
      return { canceled: false, path: process.cwd() }
    },
  })
  try {
    const selected = await app.inject({
      method: 'POST',
      url: '/api/v2/directories/pick',
      payload: { initialPath: process.cwd() },
    })
    assert.equal(selected.statusCode, 200)
    assert.deepEqual(selected.json(), { canceled: false, path: process.cwd() })
    assert.deepEqual(calls, [{ initialPath: process.cwd() }])

    const relayed = await app.inject({
      method: 'POST',
      url: '/api/v2/directories/pick',
      headers: { 'x-promptx-relay-request': '1' },
      payload: {},
    })
    assert.equal(relayed.statusCode, 403)
    assert.equal(relayed.json().error, 'directory_picker_local_only')
    assert.equal(calls.length, 1)
  } finally {
    await app.close()
  }
})

test('工作区和会话 API 支持置顶、重命名，工作区归档保留会话置顶', async () => {
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })
  try {
    const conversation = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex', title: '原会话名' })
    assert.equal(conversation.statusCode, 201)
    const { project, task } = conversation.json()

    const projectPin = await app.inject({
      method: 'POST',
      url: `/api/v2/projects/${project.id}/pin`,
      payload: { pinned: true },
    })
    assert.equal(projectPin.statusCode, 200)
    assert.ok(projectPin.json().project.pinnedAt)

    const taskPin = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${task.id}/pin`,
      payload: { pinned: true },
    })
    assert.equal(taskPin.statusCode, 200)
    assert.ok(taskPin.json().task.pinnedAt)

    const rename = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${task.id}`,
      payload: { title: '  新会话名  ' },
    })
    assert.equal(rename.statusCode, 200)
    assert.equal(rename.json().task.title, '新会话名')

    for (const title of ['   ', 'x'.repeat(121)]) {
      const invalid = await app.inject({ method: 'PATCH', url: `/api/v2/tasks/${task.id}`, payload: { title } })
      assert.equal(invalid.statusCode, 400)
    }
    assert.equal(app.sqliteRepository.getTask(task.id).title, '新会话名')

    const archive = await app.inject({ method: 'POST', url: `/api/v2/projects/${project.id}/archive` })
    assert.equal(archive.statusCode, 200)
    assert.equal(archive.json().project.pinnedAt, null)
    assert.ok(app.sqliteRepository.getTask(task.id).pinnedAt)
    const hiddenTurn = await app.inject({
      method: 'POST', url: `/api/v2/tasks/${task.id}/turns`,
      payload: { clientMessageId: 'archived-project-turn', input: { content: [{ type: 'text', text: '不应执行' }] } },
    })
    assert.equal(hiddenTurn.statusCode, 409)
    assert.equal(hiddenTurn.json().error, 'task_archived')
  } finally {
    await app.close()
  }
})

test('Task inspection API 提供文件、Git 状态并拒绝路径逃逸', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-v2-inspection-api-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.writeFileSync(path.join(root, 'README.md'), '# Before\n')
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'promptx@example.com'],
    ['config', 'user.name', 'PromptX Test'],
    ['add', 'README.md'],
    ['commit', '-qm', 'initial'],
  ]) {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# After\n')

  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false })
  try {
    const conversation = await createLocalTask(app, { cwd: root, providerId: 'codex' })
    const { task } = conversation.json()
    const files = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/files?path=` })
    assert.equal(files.statusCode, 200)
    assert.deepEqual(files.json().directory.entries.map((entry) => entry.name), ['README.md'])

    const file = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/file?path=README.md` })
    assert.equal(file.statusCode, 200)
    assert.equal(file.json().file.content, '# After\n')

    const status = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/git/status` })
    assert.equal(status.statusCode, 200)
    assert.equal(status.json().git.files[0].path, 'README.md')

    const diff = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/git/diff?path=README.md` })
    assert.equal(diff.statusCode, 200)
    assert.match(diff.json().diff.unstaged, /\+\# After/)

    const escaped = await app.inject({ method: 'GET', url: `/api/v2/tasks/${task.id}/file?path=../secret.txt` })
    assert.equal(escaped.statusCode, 403)
    assert.equal(escaped.json().error, 'path_outside_workspace')
  } finally {
    await app.close()
  }
})

test('同一 Project 可以创建独立 Worktree Task', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-app-worktree-'))
  const workspace = path.join(root, 'repository')
  const previousWorktreesDir = process.env.PROMPTX_WORKTREES_DIR
  let app
  t.after(async () => {
    try {
      await app?.close()
    } finally {
      if (previousWorktreesDir === undefined) delete process.env.PROMPTX_WORKTREES_DIR
      else process.env.PROMPTX_WORKTREES_DIR = previousWorktreesDir
      await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 5 })
    }
  })
  fs.mkdirSync(workspace)
  process.env.PROMPTX_WORKTREES_DIR = path.join(root, 'worktrees')
  for (const args of [
    ['init', '-q'],
    ['config', 'user.email', 'promptx@example.com'],
    ['config', 'user.name', 'PromptX Test'],
    ['commit', '--allow-empty', '-qm', 'initial'],
  ]) {
    const result = spawnSync('git', args, { cwd: workspace, encoding: 'utf8', windowsHide: true })
    assert.equal(result.status, 0, result.stderr)
  }
  app = await createApp({
    databasePath: ':memory:', assetsDir: path.join(root, 'uploads'), logger: false, webRoot: false, relay: false,
    relayOptions: { configPath: path.join(root, 'relay.json'), identityPath: path.join(root, 'identity.json') },
  })

  const firstResponse = await createLocalTask(app, { cwd: workspace, providerId: 'codex' })
  const first = firstResponse.json()
  const secondResponse = await app.inject({ method: 'POST', url: `/api/v2/projects/${first.project.id}/tasks`, payload: { executionKind: 'worktree', providerId: 'claude', slug: `test-${Date.now()}` } })
  assert.equal(secondResponse.statusCode, 201)
  const second = secondResponse.json()
  assert.equal(second.task.projectId, first.project.id)
  assert.notEqual(second.task.id, first.task.id)
  assert.notEqual(second.agent.id, first.agent.id)
  assert.equal(second.agent.providerId, 'claude')

  const prematureDelete = await app.inject({ method: 'DELETE', url: `/api/v2/tasks/${first.task.id}` })
  assert.equal(prematureDelete.statusCode, 409)
  const archiveResponse = await app.inject({ method: 'POST', url: `/api/v2/tasks/${first.task.id}/archive` })
  assert.equal(archiveResponse.statusCode, 200)
  const archivedResponse = await app.inject({ method: 'GET', url: '/api/v2/tasks/archived' })
  assert.equal(archivedResponse.json().tasks.some((task) => task.id === first.task.id), true)
  const deleteResponse = await app.inject({ method: 'DELETE', url: `/api/v2/tasks/${first.task.id}` })
  assert.equal(deleteResponse.statusCode, 204)
  const tasksResponse = await app.inject({ method: 'GET', url: `/api/v2/projects/${first.project.id}/tasks` })
  assert.equal(tasksResponse.json().tasks.some((task) => task.id === second.task.id), true)
})

test('Agent 使用首条用户文本生成标题，后续消息不再覆盖', async () => {
  const { registry, runtimes } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversationResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { agent } = conversationResponse.json()
    assert.equal(agent.title, '新会话')

    const firstResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'title-first-turn',
        input: { content: [{ type: 'text', text: '  \n  分析   PromptX\t标题流程  \n这行不应该出现' }] },
      },
    })
    assert.equal(firstResponse.statusCode, 202)
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '分析 PromptX 标题流程')

    runtimes[0].emit('turnCompleted')
    assert.equal(app.sqliteRepository.getAgent(agent.id).requiresAttention, true)
    assert.equal(app.sqliteRepository.getAgent(agent.id).attentionReason, 'finished')
    const clearAttentionResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/attention/clear`,
    })
    assert.equal(clearAttentionResponse.statusCode, 200)
    assert.equal(clearAttentionResponse.json().agent.requiresAttention, false)
    const secondResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'title-second-turn',
        input: { content: [{ type: 'text', text: '这是第二条消息' }] },
      },
    })
    assert.equal(secondResponse.statusCode, 202)
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '分析 PromptX 标题流程')
  } finally {
    await app.close()
  }
})

test('首条纯附件消息不会让后续文本成为 Agent 标题', async () => {
  const { registry, runtimes } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversationResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { task, agent } = conversationResponse.json()
    const asset = app.sqliteRepository.createAsset(task.id, {
      name: 'notes.txt',
      mimeType: 'text/plain',
      size: 5,
      sha256: 'test-sha',
      storagePath: path.join(os.tmpdir(), `${agent.id}-notes.txt`),
    })

    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'attachment-first-turn',
        input: { content: [{ type: 'file', assetId: asset.id, name: asset.name, mimeType: asset.mimeType, size: asset.size }] },
      },
    })
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '新会话')

    runtimes[0].emit('turnCompleted')
    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'text-second-turn',
        input: { content: [{ type: 'text', text: '第二条文本' }] },
      },
    })
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '新会话')
  } finally {
    await app.close()
  }
})

test('显式 Agent 标题不会被首条用户消息覆盖', async () => {
  const { registry } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversationResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex', title: '固定标题' })
    const { agent } = conversationResponse.json()

    await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'explicit-title-turn',
        input: { content: [{ type: 'text', text: '不应替换标题' }] },
      },
    })
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '固定标题')
  } finally {
    await app.close()
  }
})

test('v2 资产上传会持久化元数据并返回原始文件内容', async () => {
  const assetsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-v2-assets-'))
  const app = await createApp({ databasePath: ':memory:', assetsDir, logger: false, webRoot: false, relay: false })
  try {
    const workspaceResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { task } = workspaceResponse.json()
    const upload = multipartFile('notes.txt', 'text/plain', 'asset-content')
    const uploadResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${task.id}/assets`,
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
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const workspaceResponse = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { agent } = workspaceResponse.json()

    const controlResponse = await app.inject({ method: 'GET', url: `/api/v2/tasks/${agent.taskId}/control` })
    assert.equal(controlResponse.statusCode, 200)
    assert.equal(controlResponse.json().control.currentModelId, 'model-a')
    assert.equal(controlResponse.json().control.contextUsage.percentage, 25)

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${agent.taskId}/settings`,
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
      url: `/api/v2/tasks/${agent.taskId}/settings`,
      payload: { reasoningEffort: 'high' },
    })
    assert.equal(invalidResponse.statusCode, 400)

    const turnResponse = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'control-test-turn',
        input: { content: [{ type: 'text', text: '保持运行' }] },
      },
    })
    assert.equal(turnResponse.statusCode, 202)
    const runningUpdateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${agent.taskId}/settings`,
      payload: { modelId: 'model-a' },
    })
    assert.equal(runningUpdateResponse.statusCode, 409)
  } finally {
    await app.close()
  }
})

test('Agent 发送预检期间拒绝并发切换模型', async () => {
  let markPrepareStarted
  let releasePrepare
  const prepareStarted = new Promise((resolve) => { markPrepareStarted = resolve })
  const prepareGate = new Promise((resolve) => { releasePrepare = resolve })
  const runtime = new EventEmitter()
  runtime.prepareTurn = async () => {
    markPrepareStarted()
    await prepareGate
  }
  runtime.startTurn = async () => ({})
  runtime.close = () => {}
  const provider = {
    id: 'codex',
    label: 'Codex Test',
    capabilities: { models: true },
    createRuntime: () => runtime,
  }
  const registry = {
    list: () => [{ id: provider.id, label: provider.label, capabilities: provider.capabilities }],
    get: () => provider,
  }
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversation = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { agent } = conversation.json()
    const turnRequest = app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'preparing-turn',
        input: { content: [{ type: 'text', text: '正在预检' }] },
      },
    })
    await prepareStarted

    const updateResponse = await app.inject({
      method: 'PATCH',
      url: `/api/v2/tasks/${agent.taskId}/settings`,
      payload: { modelId: 'model-b' },
    })
    assert.equal(updateResponse.statusCode, 409)

    releasePrepare()
    assert.equal((await turnRequest).statusCode, 202)
  } finally {
    releasePrepare?.()
    await app.close()
  }
})

test('运行中的 Agent 拒绝新的 Turn，重复请求保持幂等', async () => {
  const { registry } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversation = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { agent } = conversation.json()
    const firstPayload = {
      clientMessageId: 'running-first',
      input: { content: [{ type: 'text', text: '当前任务' }] },
    }
    const first = await app.inject({ method: 'POST', url: `/api/v2/tasks/${agent.taskId}/turns`, payload: firstPayload })
    assert.equal(first.statusCode, 202)
    const duplicate = await app.inject({ method: 'POST', url: `/api/v2/tasks/${agent.taskId}/turns`, payload: firstPayload })
    assert.equal(duplicate.statusCode, 202)
    assert.equal(duplicate.json().turn.id, first.json().turn.id)
    const rejected = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: { clientMessageId: 'running-second', input: { content: [{ type: 'text', text: '不应发送' }] } },
    })
    assert.equal(rejected.statusCode, 409)
  } finally {
    await app.close()
  }
})

test('运行中的 Agent 拒绝 Git 合并操作', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-running-merge-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'promptx@example.com'],
    ['config', 'user.name', 'PromptX Test'],
  ]) assert.equal(spawnSync('git', args, { cwd: root }).status, 0)
  fs.writeFileSync(path.join(root, 'README.md'), 'initial\n')
  for (const args of [['add', '.'], ['commit', '-m', 'initial']]) {
    assert.equal(spawnSync('git', args, { cwd: root }).status, 0)
  }

  const { registry } = createControlTestRegistry()
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const project = app.sqliteRepository.createProject({ repositoryRoot: root, displayName: '运行中合并' })
    const environment = app.sqliteRepository.createEnvironment({
      cwd: root, repositoryRoot: root, kind: 'worktree', branchName: 'feature', ownership: 'external',
    })
    const task = app.sqliteRepository.createTask({ projectId: project.id, environmentId: environment.id, title: '运行中会话' })
    app.sqliteRepository.createAgent(task.id, { providerId: 'codex' })
    const started = await app.inject({
      method: 'POST', url: `/api/v2/tasks/${task.id}/turns`,
      payload: { clientMessageId: 'running-merge', input: { content: [{ type: 'text', text: '保持运行' }] } },
    })
    assert.equal(started.statusCode, 202)
    const merge = await app.inject({
      method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' },
    })
    assert.equal(merge.statusCode, 409)
    assert.equal(merge.json().error, 'task_running')
  } finally {
    await app.close()
  }
})

test('Runtime 发送前预检失败时不创建 Turn 或用户 Timeline', async () => {
  const runtime = new EventEmitter()
  runtime.prepareTurn = async () => {
    const error = new Error('当前 Codex CLI 无法续跑该会话。')
    error.code = 'codex_paginated_resume_unsupported'
    error.statusCode = 409
    throw error
  }
  runtime.startTurn = async () => {
    assert.fail('预检失败后不应调用 startTurn')
  }
  runtime.close = () => {}
  const provider = {
    id: 'codex',
    label: 'Codex Test',
    capabilities: {},
    createRuntime: () => runtime,
  }
  const registry = {
    list: () => [{ id: provider.id, label: provider.label, capabilities: provider.capabilities }],
    get: () => provider,
  }
  const app = await createApp({ databasePath: ':memory:', logger: false, webRoot: false, relay: false, providerRegistry: registry })
  try {
    const conversation = await createLocalTask(app, { cwd: process.cwd(), providerId: 'codex' })
    const { agent } = conversation.json()
    const response = await app.inject({
      method: 'POST',
      url: `/api/v2/tasks/${agent.taskId}/turns`,
      payload: {
        clientMessageId: 'blocked-before-write',
        input: { content: [{ type: 'text', text: '不应写入 Timeline' }] },
      },
    })

    assert.equal(response.statusCode, 409)
    assert.equal(response.json().error, 'codex_paginated_resume_unsupported')
    assert.equal(app.sqliteRepository.listTurns(agent.taskId).length, 0)
    assert.equal(app.sqliteRepository.listTimelineRows(agent.taskId).length, 0)
    assert.equal(app.sqliteRepository.getAgent(agent.id).title, '新会话')
    assert.equal(app.sqliteRepository.getAgent(agent.id).lifecycle, 'ready')
  } finally {
    await app.close()
  }
})
