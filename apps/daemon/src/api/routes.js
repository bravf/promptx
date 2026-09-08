import {
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  CreateTurnInputSchema,
  GitCommitInputSchema,
  GitMergeInputSchema,
  PinInputSchema,
  RebindEnvironmentInputSchema,
  RemoveWorktreeInputSchema,
  UpdateTaskInputSchema,
  UpdateAgentSettingsInputSchema,
  UpdateProjectInputSchema,
} from '../../../../packages/protocol/src/index.js'
import { DATABASE_VERSION } from '../db/database.js'
import fs from 'node:fs'
import { searchDirectories } from '../workspaces/directorySearch.js'
import {
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  listWorkspaceDirectory,
  openWorkspaceFileStream,
  readWorkspaceFile,
} from '../workspaces/workspaceInspection.js'
import { publicAsset, storeAsset } from '../assets/assetStorage.js'
import { DEFAULT_AGENT_TITLE } from '../agent/sessionTitle.js'
import { repositoryRoot, defaultBranch, addWorktree, removeWorktree, listCommits } from '../environments/worktreeService.js'
import { resolveExistingDirectory } from '../paths/canonicalPath.js'

function parseCursor(value) {
  if (!value) return null
  const [epoch, seq] = String(value).split(':')
  return epoch && Number.isInteger(Number(seq)) ? { epoch, seq: Number(seq) } : null
}

function badRequest(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
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

function taskContext(repository, taskId) {
  const task = repository.getTask(taskId)
  if (!task) return null
  return {
    task,
    project: repository.getProject(task.projectId),
    environment: repository.getEnvironment(task.environmentId),
    agent: repository.getTaskAgent(task.id),
  }
}

function publicTask(repository, task) {
  return {
    ...task,
    environment: repository.getEnvironment(task.environmentId),
    agent: repository.getTaskAgent(task.id),
  }
}

function resolveDirectoryPath(value) {
  try {
    return resolveExistingDirectory(value)
  } catch (error) {
    throw badRequest(error.message)
  }
}

async function resolveProjectInput(input) {
  const requested = resolveDirectoryPath(input.repositoryRoot)
  try {
    const root = await repositoryRoot(requested)
    return { repositoryRoot: root, defaultBranch: input.defaultBranch || await defaultBranch(root) }
  } catch {
    return { repositoryRoot: requested, defaultBranch: input.defaultBranch || '' }
  }
}

export function registerRoutes(app, context) {
  const { repository, timelineStore, providerRegistry, agentManager, sessionImport, eventHub, assetsDir, corsPolicy,
    directoryPicker, taskLifecycle, environmentService, gitDelivery } = context
  let directoryPickerOpen = false

  async function createTask(project, rawInput) {
    const input = CreateTaskInputSchema.parse(rawInput)
    const provider = providerRegistry.get(input.providerId)
    let createdWorktree = null
    let environment = null
    try {
      if (input.executionKind === 'worktree') {
        createdWorktree = await addWorktree({
          repositoryRoot: project.repositoryRoot,
          baseRef: input.baseRef || project.defaultBranch || 'HEAD',
          branchName: input.branchName || `codex/${input.slug || 'task'}`,
          slug: input.slug || 'task',
        })
      }
      const cwd = input.executionKind === 'worktree'
        ? createdWorktree.path
        : input.executionKind === 'existing'
          ? resolveDirectoryPath(input.cwd ?? project.repositoryRoot)
          : resolveDirectoryPath(project.repositoryRoot)
      const result = repository.transaction(() => {
        environment = repository.createEnvironment({
          kind: input.executionKind === 'worktree' ? 'worktree' : 'local',
          cwd,
          repositoryRoot: project.repositoryRoot,
          branchName: createdWorktree?.branchName || '',
          baseRef: createdWorktree?.baseRef || '',
          baseCommit: createdWorktree?.baseCommit || '',
          worktreePath: createdWorktree?.path || null,
          ownership: input.executionKind === 'worktree' ? 'promptx' : 'external',
        })
        const task = repository.createTask({
          projectId: project.id,
          environmentId: environment.id,
          title: input.title || DEFAULT_AGENT_TITLE,
        })
        const agent = repository.createAgent(task.id, input, provider.capabilities)
        return { task: repository.getTask(task.id), environment, agent }
      })
      return result
    } catch (error) {
      if (environment) repository.deleteEnvironment(environment.id)
      if (createdWorktree) await removeWorktree(project.repositoryRoot, createdWorktree.path, true).catch(() => {})
      throw error
    }
  }

  app.get('/api/v2/health', async () => ({ ok: true, version: DATABASE_VERSION }))
  app.get('/api/v2/providers', async () => ({ providers: providerRegistry.list() }))
  app.get('/api/v2/directories/search', async (request) => searchDirectories({
    query: request.query.q,
    limit: request.query.limit,
  }))
  app.post('/api/v2/directories/pick', async (request, reply) => {
    if (request.headers['x-promptx-relay-request'] === '1') {
      return reply.code(403).send({
        error: 'directory_picker_local_only',
        message: '远程访问时不能打开主机的目录选择器，请手动输入路径。',
      })
    }
    if (directoryPickerOpen) {
      return reply.code(409).send({ error: 'directory_picker_busy', message: '目录选择器已经打开。' })
    }
    const initialPath = request.body?.initialPath
    if (initialPath !== undefined && typeof initialPath !== 'string') throw badRequest('初始目录必须是文本。')
    if (String(initialPath || '').length > 4096) throw badRequest('初始目录过长。')
    directoryPickerOpen = true
    try {
      return await directoryPicker({ initialPath })
    } finally {
      directoryPickerOpen = false
    }
  })
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

  app.get('/api/v2/projects', async () => ({ projects: repository.listProjects() }))
  app.post('/api/v2/projects', async (request, reply) => {
    const input = CreateProjectInputSchema.parse(request.body)
    const resolved = await resolveProjectInput(input)
    const project = repository.createProject({ ...input, ...resolved })
    reply.code(201)
    return { project }
  })
  app.get('/api/v2/projects/:projectId', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    return project ? { project } : reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
  })
  app.patch('/api/v2/projects/:projectId', async (request, reply) => {
    const input = UpdateProjectInputSchema.parse(request.body ?? {})
    const project = repository.updateProject(request.params.projectId, input)
    return project ? { project } : reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
  })
  app.post('/api/v2/projects/:projectId/pin', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    const input = PinInputSchema.parse(request.body ?? {})
    return { project: repository.setProjectPinned(project.id, input.pinned) }
  })
  app.delete('/api/v2/projects/:projectId', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    if (project.lifecycle !== 'archived') {
      return reply.code(409).send({ error: 'project_not_archived', message: '只能永久删除已归档的工作区。' })
    }
    if (repository.listTasks(project.id, true).length) {
      return reply.code(409).send({ error: 'project_has_tasks', message: '请先在归档管理中永久删除该工作区的会话。' })
    }
    repository.deleteProject(project.id)
    return reply.code(204).send()
  })
  app.post('/api/v2/projects/:projectId/archive', async (request, reply) => {
    return { project: await taskLifecycle.archiveProject(request.params.projectId) }
  })
  app.post('/api/v2/projects/:projectId/restore', async (request, reply) => {
    return { project: taskLifecycle.restoreProject(request.params.projectId) }
  })
  app.get('/api/v2/projects/archived', async (request) => ({
    projects: repository.listArchivedProjects(request.query.q),
  }))
  app.get('/api/v2/projects/:projectId/tasks', async (request, reply) => {
    if (!repository.getProject(request.params.projectId)) {
      return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    }
    return { tasks: repository.listTasks(request.params.projectId).map((task) => publicTask(repository, task)) }
  })
  app.post('/api/v2/projects/:projectId/tasks', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    if (project.lifecycle !== 'active') return reply.code(409).send({ error: 'project_archived', message: '请先恢复工作区。' })
    const result = await createTask(project, request.body || {})
    reply.code(201)
    return result
  })

  app.get('/api/v2/tasks/:taskId', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current || reply.code(404).send({ error: 'task_not_found', message: '会话不存在。' })
  })
  app.patch('/api/v2/tasks/:taskId', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found', message: '会话不存在。' })
    const input = UpdateTaskInputSchema.parse(request.body ?? {})
    const task = repository.updateTask(current.task.id, input)
    return { task: publicTask(repository, task) }
  })
  app.post('/api/v2/tasks/:taskId/pin', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found', message: '会话不存在。' })
    const input = PinInputSchema.parse(request.body ?? {})
    const task = repository.setTaskPinned(current.task.id, input.pinned)
    return { task: publicTask(repository, task) }
  })
  app.get('/api/v2/tasks/:taskId/environment', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { environment: current.environment } : reply.code(404).send({ error: 'task_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/agent', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    return agent ? { agent } : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/control', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    return agent ? { control: await agentManager.getControlState(agent.id) } : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.patch('/api/v2/tasks/:taskId/settings', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    return agent
      ? agentManager.updateSettings(agent.id, UpdateAgentSettingsInputSchema.parse(request.body))
      : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/turns', async (request, reply) => {
    if (!repository.getTask(request.params.taskId)) return reply.code(404).send({ error: 'task_not_found' })
    const requested = Number(request.query.limit || 300)
    const limit = Math.min(1000, Math.max(1, Number.isFinite(requested) ? Math.floor(requested) : 300))
    return { turns: repository.listTurns(request.params.taskId, limit) }
  })
  app.post('/api/v2/tasks/:taskId/turns', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const turn = await agentManager.startTurn(agent.id, CreateTurnInputSchema.parse(request.body))
    reply.code(202)
    return { turn }
  })
  app.post('/api/v2/tasks/:taskId/cancel', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    return agent ? { canceled: await agentManager.cancel(agent.id) } : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.post('/api/v2/tasks/:taskId/attention/clear', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const updated = repository.clearAgentAttention(agent.id)
    eventHub.publish(agent.id, { type: 'agent', agent: updated })
    return { agent: updated }
  })
  app.get('/api/v2/tasks/:taskId/timeline', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    if (request.query.direction !== 'before') {
      void agentManager.syncTimeline(agent.id).catch((error) => request.log.warn(error, 'Timeline 后台同步失败'))
    }
    return { timeline: timelineStore.fetch(request.params.taskId, {
      direction: request.query.direction,
      limit: request.query.limit,
      mode: request.query.mode,
      cursor: parseCursor(request.query.cursor),
    }) }
  })
  app.post('/api/v2/tasks/:taskId/timeline/sync', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    return agent ? { sync: await agentManager.syncTimeline(agent.id, { force: true }) } : reply.code(404).send({ error: 'agent_not_found' })
  })

  app.get('/api/v2/tasks/:taskId/files', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { directory: await listWorkspaceDirectory(current.environment.cwd, request.query.path || '') }
      : reply.code(404).send({ error: 'task_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/file', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { file: await readWorkspaceFile(current.environment.cwd, request.query.path || '') }
      : reply.code(404).send({ error: 'task_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/file/content', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const file = openWorkspaceFileStream(current.environment.cwd, request.query.path || '')
    reply.header('Content-Type', file.mimeType)
    reply.header('Content-Length', String(file.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream)
  })
  app.get('/api/v2/tasks/:taskId/git/status', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { git: await getWorkspaceGitStatus(current.environment.cwd) }
      : reply.code(404).send({ error: 'task_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/git/diff', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { diff: await getWorkspaceGitDiff(current.environment.cwd, request.query.path || '') }
      : reply.code(404).send({ error: 'task_not_found' })
  })
  app.get('/api/v2/tasks/:taskId/git/commits', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current ? { commits: await listCommits(current.environment.cwd, request.query.limit) }
      : reply.code(404).send({ error: 'task_not_found' })
  })
  app.post('/api/v2/tasks/:taskId/git/commit', async (request, reply) => {
    const input = GitCommitInputSchema.parse(request.body ?? {})
    return { commits: await gitDelivery.commit(request.params.taskId, input.message) }
  })
  app.post('/api/v2/tasks/:taskId/git/push', async (request, reply) => {
    const branchName = await gitDelivery.push(request.params.taskId)
    return { pushed: true, branchName }
  })
  app.post('/api/v2/tasks/:taskId/git/merge', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const input = GitMergeInputSchema.parse(request.body ?? {})
    const target = input.targetBranch || current.project.defaultBranch
    if (!target) return reply.code(400).send({ error: 'target_branch_required' })
    const result = await gitDelivery.merge(current.task.id, { ...input, targetBranch: target })
    return { merged: true, ...result }
  })

  app.post('/api/v2/tasks/:taskId/assets', async (request, reply) => {
    if (!repository.getTask(request.params.taskId)) return reply.code(404).send({ error: 'task_not_found' })
    const part = await request.file()
    if (!part) return reply.code(400).send({ error: 'file_required', message: '没有收到附件。' })
    const asset = await storeAsset({ part, taskId: request.params.taskId, assetsDir, repository })
    reply.code(201)
    return { asset: publicAsset(asset) }
  })
  app.get('/api/v2/assets/:assetId/content', async (request, reply) => {
    const asset = repository.getAsset(request.params.assetId)
    if (!asset || !fs.existsSync(asset.storagePath)) {
      return reply.code(404).send({ error: 'asset_not_found', message: '附件不存在。' })
    }
    reply.header('Content-Type', asset.mimeType)
    reply.header('Content-Length', String(asset.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    reply.header('Content-Disposition', `${asset.mimeType.startsWith('image/') ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(asset.name)}`)
    return reply.send(fs.createReadStream(asset.storagePath))
  })

  app.post('/api/v2/tasks/:taskId/archive', async (request, reply) => {
    return { task: await taskLifecycle.archiveTask(request.params.taskId) }
  })
  app.get('/api/v2/tasks/archived', async (request) => ({
    tasks: repository.listArchivedTasks(request.query.q).map((task) => ({
      ...publicTask(repository, task),
      project: repository.getProject(task.projectId),
    })),
  }))
  app.post('/api/v2/tasks/:taskId/restore', async (request, reply) => {
    const task = await taskLifecycle.restoreTask(request.params.taskId)
    return { task: publicTask(repository, task), project: repository.getProject(task.projectId) }
  })
  app.post('/api/v2/tasks/:taskId/environment/remove-worktree', async (request, reply) => {
    const input = RemoveWorktreeInputSchema.parse(request.body ?? {})
    return { environment: await environmentService.removeManagedWorktree(request.params.taskId, input) }
  })
  app.post('/api/v2/tasks/:taskId/environment/reconcile', async (request, reply) => {
    return { environment: await environmentService.reconcile(request.params.taskId) }
  })
  app.post('/api/v2/tasks/:taskId/environment/rebind', async (request, reply) => {
    const input = RebindEnvironmentInputSchema.parse(request.body ?? {})
    return { environment: await environmentService.rebind(request.params.taskId, input) }
  })
  app.post('/api/v2/tasks/:taskId/copy', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const raw = request.body || {}
    const slug = raw.slug || `${current.task.title.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`
    const result = await createTask(current.project, {
      providerId: current.agent.providerId,
      title: raw.title || current.task.title,
      executionKind: 'worktree',
      baseRef: raw.baseRef || current.project.defaultBranch || 'HEAD',
      branchName: raw.branchName || `codex/${slug}`,
      slug,
    })
    reply.code(201)
    return result
  })
  app.delete('/api/v2/tasks/:taskId', async (request, reply) => {
    await taskLifecycle.deleteTask(request.params.taskId)
    return reply.code(204).send()
  })

  app.get('/api/v2/events', (request, reply) => {
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin, (origin) => corsPolicy.allows(origin)))
    const writeTask = (agent) => sseWrite(raw, { type: 'task', task: repository.getTask(agent.taskId), agent })
    const unsubscribe = eventHub.subscribeAll((event) => {
      if (event.type === 'agent') writeTask(event.agent)
    })
    repository.listAllAgents().forEach(writeTask)
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 15000)
    heartbeat.unref?.()
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
  app.get('/api/v2/tasks/:taskId/events', (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    reply.hijack()
    const raw = reply.raw
    raw.writeHead(200, createSseHeaders(request.headers.origin, (origin) => corsPolicy.allows(origin)))
    const unsubscribe = eventHub.subscribe(agent.id, (event) => sseWrite(raw, event))
    const cursor = parseCursor(request.headers['last-event-id'] || request.query.cursor)
    const snapshot = timelineStore.fetch(request.params.taskId, { direction: cursor ? 'after' : 'tail', cursor })
    if (snapshot.reset) sseWrite(raw, { type: 'reset', timeline: snapshot })
    else snapshot.rows.forEach((row) => sseWrite(raw, { type: 'timeline', epoch: snapshot.epoch, row }))
    sseWrite(raw, { type: 'agent', agent: repository.getAgent(agent.id) })
    sseWrite(raw, { type: 'timeline-synced', sync: { status: 'current', turns: repository.listTurns(request.params.taskId, 1000) } })
    const control = agentManager.controlStates.get(agent.id)
    if (control) sseWrite(raw, { type: 'control', control })
    void agentManager.syncTimeline(agent.id).catch((error) => request.log.warn(error, 'Timeline 重连同步失败'))
    const heartbeat = setInterval(() => raw.write(': heartbeat\n\n'), 15000)
    heartbeat.unref?.()
    raw.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
