import {
  CreateAgentInputSchema,
  CreateConversationInputSchema,
  CreateTurnInputSchema,
  UpdateAgentSettingsInputSchema,
  UpdateWorkspaceInputSchema,
} from '../../../../packages/protocol/src/index.js'
import fs from 'node:fs'
import path from 'node:path'
import { searchDirectories } from '../workspaces/directorySearch.js'
import { publicAsset, removeStoredAssets, storeAsset } from '../assets/assetStorage.js'
import { DEFAULT_AGENT_TITLE } from '../agent/sessionTitle.js'

function parseCursor(value) {
  if (!value) return null
  const [epoch, seq] = String(value).split(':')
  return epoch && Number.isInteger(Number(seq)) ? { epoch, seq: Number(seq) } : null
}

function sseWrite(raw, event) {
  if (event.type === 'timeline') raw.write(`id: ${event.epoch}:${event.row.seq}\n`)
  raw.write(`event: ${event.type}\n`)
  raw.write(`data: ${JSON.stringify(event)}\n\n`)
}

export function createSseHeaders(origin = '') {
  return {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    'Access-Control-Allow-Origin': origin || '*',
    Vary: 'Origin',
  }
}

export function registerRoutes(app, context) {
  const { repository, timelineStore, providerRegistry, agentManager, eventHub, assetsDir } = context

  app.get('/api/v2/health', async () => ({ ok: true, version: 2 }))
  app.get('/api/v2/providers', async () => ({ providers: providerRegistry.list() }))
  app.get('/api/v2/directories/search', async (request) => searchDirectories({
    query: request.query.q,
    limit: request.query.limit,
  }))

  app.get('/api/v2/workspaces', async () => ({ workspaces: repository.listWorkspaces() }))
  app.get('/api/v2/events', (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin))
    const writeAgent = (agent) => sseWrite(raw, { type: 'agent', agent })
    const unsubscribe = eventHub.subscribeAll((event) => {
      if (event.type === 'agent') writeAgent(event.agent)
    })
    repository.listAllAgents().forEach(writeAgent)
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 15000)
    heartbeat.unref?.()
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
  app.post('/api/v2/conversations', async (request, reply) => {
    const input = CreateConversationInputSchema.parse(request.body)
    const provider = providerRegistry.get(input.providerId)
    const workspace = repository.createWorkspace(input)
    let agent = repository.createAgent(workspace.id, {
      providerId: provider.id,
      title: DEFAULT_AGENT_TITLE,
    }, provider.capabilities)
    agent = repository.updateAgent(agent.id, { lifecycle: 'ready' })
    reply.code(201)
    return { workspace, agent }
  })
  app.patch('/api/v2/workspaces/:workspaceId', async (request) => ({
    workspace: repository.updateWorkspace(request.params.workspaceId, UpdateWorkspaceInputSchema.parse(request.body)),
  }))
  app.delete('/api/v2/workspaces/:workspaceId', async (request, reply) => {
    const assets = repository.listWorkspaceAssets(request.params.workspaceId)
    for (const agent of repository.listAgents(request.params.workspaceId, true)) agentManager.close(agent.id)
    if (!repository.deleteWorkspace(request.params.workspaceId)) return reply.code(404).send({ error: 'workspace_not_found' })
    removeStoredAssets(assets)
    fs.rmSync(path.join(assetsDir, request.params.workspaceId), { recursive: true, force: true })
    return reply.code(204).send()
  })

  app.post('/api/v2/workspaces/:workspaceId/assets', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    const part = await request.file()
    if (!part) return reply.code(400).send({ error: 'file_missing', message: '没有收到附件。' })
    const asset = await storeAsset({ part, workspaceId: workspace.id, assetsDir, repository })
    reply.code(201)
    return { asset: publicAsset(asset) }
  })

  app.get('/api/v2/assets/:assetId/content', async (request, reply) => {
    const asset = repository.getAsset(request.params.assetId)
    if (!asset || !fs.existsSync(asset.storagePath)) {
      return reply.code(404).send({ error: 'asset_not_found', message: '附件不存在。' })
    }
    const inline = asset.mimeType.startsWith('image/')
    reply.header('Content-Type', asset.mimeType)
    reply.header('Content-Length', String(asset.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(asset.name)}`)
    return reply.send(fs.createReadStream(asset.storagePath))
  })

  app.get('/api/v2/workspaces/:workspaceId/agents', async (request) => ({
    agents: repository.listAgents(request.params.workspaceId, request.query.includeArchived === 'true'),
  }))
  app.post('/api/v2/workspaces/:workspaceId/agents', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found' })
    const input = CreateAgentInputSchema.parse(request.body)
    const provider = providerRegistry.get(input.providerId)
    const agent = repository.createAgent(workspace.id, input, provider.capabilities)
    repository.updateAgent(agent.id, { lifecycle: 'ready' })
    reply.code(201)
    return { agent: repository.getAgent(agent.id) }
  })

  app.get('/api/v2/agents/:agentId', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    return agent ? { agent } : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.get('/api/v2/agents/:agentId/control', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    return { control: await agentManager.getControlState(agent.id) }
  })
  app.patch('/api/v2/agents/:agentId/settings', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    return agentManager.updateSettings(agent.id, UpdateAgentSettingsInputSchema.parse(request.body))
  })
  app.get('/api/v2/agents/:agentId/turns', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const requestedLimit = Number(request.query.limit || 300)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 300))
    return { turns: repository.listTurns(agent.id, limit) }
  })
  app.post('/api/v2/agents/:agentId/turns', async (request, reply) => {
    const input = CreateTurnInputSchema.parse(request.body)
    const turn = await agentManager.startTurn(request.params.agentId, input)
    reply.code(202)
    return { turn }
  })
  app.post('/api/v2/agents/:agentId/cancel', async (request) => ({ canceled: await agentManager.cancel(request.params.agentId) }))
  app.post('/api/v2/agents/:agentId/close', async (request) => ({ agent: agentManager.close(request.params.agentId) }))
  app.post('/api/v2/agents/:agentId/archive', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    await agentManager.cancel(agent.id)
    agentManager.close(agent.id)
    return { agent: repository.updateAgent(agent.id, { lifecycle: 'archived', archivedAt: new Date().toISOString() }) }
  })
  app.delete('/api/v2/agents/:agentId', async (request, reply) => {
    agentManager.close(request.params.agentId)
    if (!repository.deleteAgent(request.params.agentId)) return reply.code(404).send({ error: 'agent_not_found' })
    return reply.code(204).send()
  })
  app.post('/api/v2/agents/:agentId/attention/clear', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const updated = repository.clearAgentAttention(agent.id)
    eventHub.publish(agent.id, { type: 'agent', agent: updated })
    return { agent: updated }
  })

  app.get('/api/v2/agents/:agentId/timeline', async (request) => ({
    timeline: timelineStore.fetch(request.params.agentId, {
      direction: request.query.direction,
      limit: request.query.limit,
      mode: request.query.mode,
      cursor: parseCursor(request.query.cursor),
    }),
  }))

  app.get('/api/v2/agents/:agentId/events', (request, reply) => {
    const agentId = request.params.agentId
    const agent = repository.getAgent(agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin))
    const unsubscribe = eventHub.subscribe(agentId, (event) => sseWrite(raw, event))
    const cursor = parseCursor(request.headers['last-event-id'] || request.query.cursor)
    const snapshot = timelineStore.fetch(agentId, { direction: cursor ? 'after' : 'tail', cursor })
    if (snapshot.reset) sseWrite(raw, { type: 'reset', timeline: snapshot })
    else snapshot.rows.forEach((row) => sseWrite(raw, { type: 'timeline', epoch: snapshot.epoch, row }))
    sseWrite(raw, { type: 'agent', agent: repository.getAgent(agentId) })
    const control = agentManager.controlStates.get(agentId)
    if (control) sseWrite(raw, { type: 'control', control })
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 15000)
    heartbeat.unref?.()
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
