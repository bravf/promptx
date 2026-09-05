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
import {
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  listWorkspaceDirectory,
  openWorkspaceFileStream,
  readWorkspaceFile,
} from '../workspaces/workspaceInspection.js'
import { publicAsset, removeStoredAssets, storeAsset } from '../assets/assetStorage.js'
import { DEFAULT_AGENT_TITLE } from '../agent/sessionTitle.js'
import { repositoryRoot, defaultBranch, addWorktree, addExistingBranch, removeWorktree, listCommits, runGit } from '../environments/worktreeService.js'
import { reconcileEnvironment } from '../environments/environmentReconcile.js'

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

export function createSseHeaders(origin = '', allowsOrigin = () => false) {
  const headers = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  }
  if (origin && allowsOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin
    headers.Vary = 'Origin'
  }
  return headers
}

export function registerRoutes(app, context) {
  const { repository, timelineStore, providerRegistry, agentManager, sessionImport, eventHub, assetsDir, corsPolicy } = context

  app.get('/api/v2/health', async () => ({ ok: true, version: 2 }))
  app.get('/api/v2/providers', async () => ({ providers: providerRegistry.list() }))
  app.get('/api/v2/import/sessions', async (request) => sessionImport.list({
    providerId: request.query.providerId,
    query: request.query.q,
    limit: request.query.limit,
  }))
  app.post('/api/v2/import/sessions', async (request, reply) => {
    const result = await sessionImport.import(request.body || {})
    reply.code(result.imported ? 201 : 200)
    return result
  })
  app.get('/api/v2/directories/search', async (request) => searchDirectories({
    query: request.query.q,
    limit: request.query.limit,
  }))

  // Task/Environment API. Legacy workspace endpoints remain available during migration.
  app.get('/api/v2/projects', async () => ({ projects: repository.listProjects() }))
  app.post('/api/v2/projects', async (request, reply) => {
    const root = await repositoryRoot(request.body?.repositoryRoot)
    const project = repository.createProject({ repositoryRoot: root, displayName: request.body?.displayName, defaultBranch: request.body?.defaultBranch || await defaultBranch(root) })
    reply.code(201)
    return { project }
  })
  app.get('/api/v2/projects/:projectId', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    return { project }
  })
  app.patch('/api/v2/projects/:projectId', async (request, reply) => {
    const project = repository.updateProject(request.params.projectId, request.body || {})
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    return { project }
  })
  app.delete('/api/v2/projects/:projectId', async (request, reply) => {
    if (!repository.getProject(request.params.projectId)) return reply.code(404).send({ error: 'project_not_found' })
    for (const task of repository.listTasks(request.params.projectId)) {
      for (const agent of repository.listAgentsByTask(task.id, true)) {
        await agentManager.cancel(agent.id).catch(() => {})
        agentManager.close(agent.id)
        repository.deleteAgent(agent.id)
      }
      repository.deleteTask(task.id)
    }
    repository.deleteProject(request.params.projectId)
    return { deleted: true }
  })
  app.get('/api/v2/projects/:projectId/tasks', async (request) => ({ tasks: repository.listTasks(request.params.projectId).map((task) => ({ ...task, agent: task.agentId ? repository.getAgent(task.agentId) : null })) }))
  app.get('/api/v2/tasks/:taskId', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    return { task, environment: repository.getEnvironment(task.environmentId) }
  })
  app.get('/api/v2/tasks/:taskId/environment', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    return { environment: repository.getEnvironment(task.environmentId) }
  })
  app.get('/api/v2/tasks/:taskId/agent', async (request, reply) => {
    const agents = repository.listAgentsByTask(request.params.taskId, false)
    if (!agents.length) return reply.code(404).send({ error: 'agent_not_found' })
    return { agent: agents[0] }
  })
  app.post('/api/v2/tasks/:taskId/turns', async (request, reply) => {
    const agents = repository.listAgentsByTask(request.params.taskId, false)
    if (!agents.length) return reply.code(404).send({ error: 'agent_not_found' })
    const turn = await agentManager.startTurn(agents[0].id, request.body || {})
    return { turn }
  })
  app.get('/api/v2/tasks/:taskId/timeline', async (request, reply) => {
    const agents = repository.listAgentsByTask(request.params.taskId, false)
    if (!agents.length) return reply.code(404).send({ error: 'agent_not_found' })
    const agent = agents[0]
    if (request.query.direction !== 'before') void agentManager.syncTimeline(agent.id).catch(() => {})
    return { timeline: timelineStore.fetch(agent.id, { direction: request.query.direction, limit: request.query.limit, mode: request.query.mode, cursor: parseCursor(request.query.cursor) }) }
  })
  app.get('/api/v2/tasks/:taskId/files', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    return { directory: await listWorkspaceDirectory(environment.cwd, request.query.path || '') }
  })
  app.get('/api/v2/tasks/:taskId/file', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    return { file: await readWorkspaceFile(environment.cwd, request.query.path || '') }
  })
  app.get('/api/v2/tasks/:taskId/file/content', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    const file = openWorkspaceFileStream(environment.cwd, request.query.path || '')
    reply.header('Content-Type', file.mimeType)
    reply.header('Content-Length', String(file.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream)
  })
  app.get('/api/v2/tasks/:taskId/git/status', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    return { git: await getWorkspaceGitStatus(environment.cwd) }
  })
  app.get('/api/v2/tasks/:taskId/git/diff', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    return { diff: await getWorkspaceGitDiff(environment.cwd, request.query.path || '') }
  })
  app.get('/api/v2/tasks/:taskId/git/commits', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    return { commits: await listCommits(environment.cwd, request.query.limit) }
  })
  app.post('/api/v2/tasks/:taskId/git/commit', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    const message = String(request.body?.message || '').trim()
    if (!message || message.length > 200) return reply.code(400).send({ error: 'invalid_commit_message' })
    const status = await getWorkspaceGitStatus(environment.cwd)
    if (!status.files?.length) return reply.code(409).send({ error: 'worktree_clean' })
    await runGit(environment.cwd, ['add', '--all'])
    await runGit(environment.cwd, ['commit', '-m', message])
    return { commits: await listCommits(environment.cwd, 1) }
  })
  app.post('/api/v2/tasks/:taskId/git/push', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    if (!environment.branchName) return reply.code(409).send({ error: 'branch_required' })
    await runGit(environment.cwd, ['push', '-u', 'origin', environment.branchName])
    return { pushed: true, branchName: environment.branchName }
  })
  app.post('/api/v2/tasks/:taskId/git/merge', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    const project = task && repository.getProject(task.projectId)
    if (!task || !environment || !project) return reply.code(404).send({ error: 'task_not_found' })
    if (environment.kind !== 'worktree' || !environment.branchName) return reply.code(409).send({ error: 'worktree_required' })
    const target = String(request.body?.targetBranch || project.defaultBranch || '').trim()
    if (!target) return reply.code(400).send({ error: 'target_branch_required' })
    const rootStatus = await getWorkspaceGitStatus(project.repositoryRoot)
    if (rootStatus.files?.length) return reply.code(409).send({ error: 'project_dirty', git: rootStatus })
    await runGit(project.repositoryRoot, ['checkout', target])
    await runGit(project.repositoryRoot, ['merge', '--no-ff', environment.branchName, '-m', request.body?.message || `Merge ${environment.branchName}`])
    if (request.body?.archive !== false) repository.archiveTask(task.id)
    return { merged: true, targetBranch: target, task: repository.getTask(task.id) }
  })
  app.post('/api/v2/tasks/:taskId/assets', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!task || !environment) return reply.code(404).send({ error: 'task_not_found' })
    const workspace = repository.createWorkspace({ cwd: environment.cwd, title: task.title })
    const part = await request.file()
    if (!part) return reply.code(400).send({ error: 'file_required' })
    const asset = await storeAsset({ part, workspaceId: workspace.id, assetsDir, repository })
    return { asset }
  })
  app.post('/api/v2/tasks/:taskId/archive', async (request, reply) => {
    for (const agent of repository.listAgentsByTask(request.params.taskId, false)) {
      await agentManager.cancel(agent.id).catch(() => {})
      agentManager.close(agent.id)
    }
    const task = repository.archiveTask(request.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    return { task }
  })
  app.post('/api/v2/tasks/:taskId/environment/reconcile', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    const updated = await reconcileEnvironment(environment)
    repository.updateEnvironment(environment.id, { status: updated.status })
    return { environment: repository.getEnvironment(environment.id) }
  })
  app.post('/api/v2/tasks/:taskId/environment/archive', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    const environment = repository.updateEnvironment(task.environmentId, { status: 'archived', archivedAt: new Date().toISOString() })
    return { environment }
  })
  app.post('/api/v2/tasks/:taskId/environment/rebind', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    const environment = task && repository.getEnvironment(task.environmentId)
    if (!environment) return reply.code(404).send({ error: 'task_not_found' })
    const cwd = fs.realpathSync(String(request.body?.cwd || '').trim())
    const rebound = repository.rebindEnvironment(environment.id, { cwd, repositoryRoot: request.body?.repositoryRoot || environment.repositoryRoot, kind: 'local', ownership: 'external' })
    return { environment: rebound }
  })
  app.post('/api/v2/tasks/:taskId/copy', async (request, reply) => {
    const source = repository.getTask(request.params.taskId)
    if (!source) return reply.code(404).send({ error: 'task_not_found' })
    const sourceEnvironment = repository.getEnvironment(source.environmentId)
    const project = repository.getProject(source.projectId)
    if (!project || !sourceEnvironment) return reply.code(404).send({ error: 'task_environment_not_found' })
    const body = request.body || {}
    const slug = body.slug || `${source.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`
    const created = await addWorktree({ repositoryRoot: project.repositoryRoot, baseRef: body.baseRef || sourceEnvironment.baseRef || project.defaultBranch || 'HEAD', branchName: body.branchName || `codex/${slug}`, slug })
    const environment = repository.createEnvironment({ kind: 'worktree', cwd: created.path, repositoryRoot: project.repositoryRoot, branchName: created.branchName, baseRef: created.baseRef, worktreePath: created.path, ownership: 'promptx' })
    const task = repository.createTask({ projectId: project.id, environmentId: environment.id, providerId: source.providerId, title: body.title || source.title })
    const workspace = repository.createWorkspace({ cwd: environment.cwd, title: project.displayName })
    const agent = repository.createAgent(workspace.id, { taskId: task.id, providerId: task.providerId, title: task.title })
    return { task, environment, workspace, agent }
  })
  app.delete('/api/v2/tasks/:taskId', async (request, reply) => {
    const task = repository.getTask(request.params.taskId)
    if (!task) return reply.code(404).send({ error: 'task_not_found' })
    const environment = repository.getEnvironment(task.environmentId)
    if (environment?.status === 'running') return reply.code(409).send({ error: 'task_running' })
    for (const agent of repository.listAgentsByTask(task.id, true)) {
      await agentManager.cancel(agent.id).catch(() => {})
      agentManager.close(agent.id)
      repository.deleteAgent(agent.id)
    }
    if (request.body?.deleteWorktree) {
      if (environment.kind !== 'worktree' || environment.ownership !== 'promptx') return reply.code(409).send({ error: 'worktree_not_owned' })
      const git = await getWorkspaceGitStatus(environment.cwd)
      if ((git.files?.length || git.ahead || 0) && !request.body.force) return reply.code(409).send({ error: 'worktree_dirty', git })
      await removeWorktree(environment.repositoryRoot, environment.worktreePath || environment.cwd, Boolean(request.body.force))
    }
    repository.deleteTask(task.id)
    return { deleted: true }
  })
  app.post('/api/v2/projects/:projectId/tasks', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found' })
    const body = request.body || {}
    let environment
    let createdWorktree = null
    try {
      if ((body.executionKind || 'local') === 'worktree') {
        createdWorktree = await addWorktree({ repositoryRoot: project.repositoryRoot, baseRef: body.baseRef || project.defaultBranch || 'HEAD', branchName: body.branchName || `codex/${body.slug || 'task'}`, slug: body.slug || 'task' })
        environment = repository.createEnvironment({ kind: 'worktree', cwd: createdWorktree.path, repositoryRoot: project.repositoryRoot, branchName: createdWorktree.branchName, baseRef: createdWorktree.baseRef, worktreePath: createdWorktree.path, ownership: 'promptx' })
      } else if (body.executionKind === 'existing') {
        const cwd = fs.realpathSync(String(body.cwd || project.repositoryRoot))
        environment = repository.createEnvironment({ kind: 'local', cwd, repositoryRoot: project.repositoryRoot, ownership: 'external' })
      } else {
        environment = repository.createEnvironment({ kind: 'local', cwd: project.repositoryRoot, repositoryRoot: project.repositoryRoot })
      }
      const task = repository.createTask({ projectId: project.id, environmentId: environment.id, providerId: body.providerId || 'codex', title: body.title })
      const workspace = repository.createWorkspace({ cwd: environment.cwd, title: project.displayName })
      const agent = repository.createAgent(workspace.id, { taskId: task.id, providerId: task.providerId, title: task.title })
      reply.code(201)
      return { task, environment, workspace, agent }
    } catch (error) {
      if (createdWorktree) await removeWorktree(project.repositoryRoot, createdWorktree.path, true).catch(() => {})
      throw error
    }
  })

  app.get('/api/v2/workspaces', async () => ({ workspaces: repository.listWorkspaces() }))
  app.get('/api/v2/workspaces/:workspaceId/files', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    return { directory: listWorkspaceDirectory(workspace.cwd, request.query.path) }
  })
  app.get('/api/v2/workspaces/:workspaceId/file', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    return { file: readWorkspaceFile(workspace.cwd, request.query.path) }
  })
  app.get('/api/v2/workspaces/:workspaceId/file/content', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    const file = openWorkspaceFileStream(workspace.cwd, request.query.path)
    reply.header('Content-Type', file.mimeType)
    reply.header('Content-Length', String(file.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream)
  })
  app.get('/api/v2/workspaces/:workspaceId/git/status', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    return { git: await getWorkspaceGitStatus(workspace.cwd) }
  })
  app.get('/api/v2/workspaces/:workspaceId/git/diff', async (request, reply) => {
    const workspace = repository.getWorkspace(request.params.workspaceId)
    if (!workspace) return reply.code(404).send({ error: 'workspace_not_found', message: '工作区不存在。' })
    return { diff: await getWorkspaceGitDiff(workspace.cwd, request.query.path) }
  })
  app.get('/api/v2/events', (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin, (origin) => corsPolicy.allows(origin)))
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
    const project = repository.getProjectByRoot(workspace.cwd) || repository.createProject({ repositoryRoot: workspace.cwd, displayName: workspace.title, defaultBranch: await defaultBranch(workspace.cwd).catch(() => '') })
    const environment = repository.getEnvironmentByCwd(workspace.cwd) || repository.createEnvironment({ kind: 'local', cwd: workspace.cwd, repositoryRoot: project.repositoryRoot, ownership: 'external', status: 'ready' })
    const task = repository.createTask({ projectId: project.id, environmentId: environment.id, providerId: provider.id, title: input.title || DEFAULT_AGENT_TITLE })
    let agent = repository.createAgent(workspace.id, {
      providerId: provider.id,
      taskId: task.id,
      title: DEFAULT_AGENT_TITLE,
    }, provider.capabilities)
    agent = repository.updateAgent(agent.id, { lifecycle: 'ready' })
    reply.code(201)
    return { workspace, project, task, environment, agent }
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

  app.get('/api/v2/agents/:agentId/timeline', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (request.query.direction !== 'before') {
      void agentManager.syncTimeline(agent.id).catch((error) => request.log.warn(error, 'Timeline 后台同步失败'))
    }
    return { timeline: timelineStore.fetch(agent.id, {
      direction: request.query.direction,
      limit: request.query.limit,
      mode: request.query.mode,
      cursor: parseCursor(request.query.cursor),
    }) }
  })

  app.post('/api/v2/agents/:agentId/timeline/sync', async (request, reply) => {
    const agent = repository.getAgent(request.params.agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    return { sync: await agentManager.syncTimeline(agent.id) }
  })

  app.get('/api/v2/agents/:agentId/events', (request, reply) => {
    const agentId = request.params.agentId
    const agent = repository.getAgent(agentId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin, (origin) => corsPolicy.allows(origin)))
    const unsubscribe = eventHub.subscribe(agentId, (event) => sseWrite(raw, event))
    const cursor = parseCursor(request.headers['last-event-id'] || request.query.cursor)
    const snapshot = timelineStore.fetch(agentId, { direction: cursor ? 'after' : 'tail', cursor })
    if (snapshot.reset) sseWrite(raw, { type: 'reset', timeline: snapshot })
    else snapshot.rows.forEach((row) => sseWrite(raw, { type: 'timeline', epoch: snapshot.epoch, row }))
    sseWrite(raw, { type: 'agent', agent: repository.getAgent(agentId) })
    sseWrite(raw, { type: 'timeline-synced', sync: { status: 'current', turns: repository.listTurns(agentId, 1000) } })
    const control = agentManager.controlStates.get(agentId)
    if (control) sseWrite(raw, { type: 'control', control })
    void agentManager.syncTimeline(agentId).catch((error) => request.log.warn(error, 'Timeline 重连同步失败'))
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 15000)
    heartbeat.unref?.()
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
