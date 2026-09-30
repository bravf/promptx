import { ToolDetailStore } from '../timeline/toolDetailStore.js'
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
  TaskEventSubscriptionsSchema,
} from '../../../../packages/protocol/src/index.js'
import { DATABASE_VERSION } from '../db/database.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
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

function sseWriteRaw(raw, text) {
  if (raw.destroyed || raw.writableEnded) return
  if (raw.writableLength + Buffer.byteLength(text) > 4 * 1024 * 1024) {
    raw.destroy()
    return
  }
  raw.write(text)
}

function sseWrite(raw, event) {
  sseWriteRaw(raw, `${event.type === 'timeline' ? `id: ${event.epoch}:${event.row.seq}\n` : ''}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
}

function initializeSse(request, reply, corsPolicy) {
  reply.hijack()
  const raw = reply.raw
  const unsubscribes = []
  const heartbeat = setInterval(() => sseWriteRaw(raw, ': heartbeat\n\n'), 15000)
  heartbeat.unref?.()
  raw.once('error', () => raw.destroy())
  raw.once('close', () => {
    clearInterval(heartbeat)
    unsubscribes.forEach(unsubscribe => unsubscribe())
  })
  raw.writeHead(200, createSseHeaders(request.headers.origin, origin => corsPolicy.allows(origin)))
  return { raw, unsubscribes }
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

function stateRevision(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
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
  const toolDetailStore = new ToolDetailStore(repository)
  let directoryPickerOpen = false

  function presentEvent(event) {
    if (!event || typeof event !== 'object') return event
    if (event.type === 'timeline' && event.row) return { ...event, row: timelineStore.presentRow(event.row) }
    if (event.type === 'reset' && event.timeline) {
      return { ...event, timeline: { ...event.timeline, rows: event.timeline.rows.map((row) => timelineStore.presentRow(row)) } }
    }
    if (event.type === 'timeline-synced' && event.sync?.timeline) {
      return { ...event, sync: { ...event.sync, timeline: { ...event.sync.timeline, rows: event.sync.timeline.rows.map((row) => timelineStore.presentRow(row)) } } }
    }
    return event
  }

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
  app.get('/api/v2/workbench', async () => ({
    projects: repository.listProjects().map(project => ({ ...project, tasks: repository.listTasks(project.id).map(task => publicTask(repository, task)) })),
  }))
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
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const control = await agentManager.getControlState(agent.id)
    return { control, revision: stateRevision(control) }
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
    const turns = repository.listTurns(request.params.taskId, limit)
    return { turns, revision: stateRevision(turns) }
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
    return agent ? { canceled: await agentManager.cancel(agent.id, { all: request.body?.all === true }) } : reply.code(404).send({ error: 'agent_not_found' })
  })
  app.post('/api/v2/tasks/:taskId/attention/clear', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const updated = repository.clearAgentAttention(agent.id)
    eventHub.publish(agent.id, { type: 'agent', agent: updated })
    return { agent: updated }
  })
  app.get('/api/v2/tasks/:taskId/tool-calls/detail', async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return toolDetailStore.read(request.params.taskId, request.query)
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
      mode: request.query.mode || 'presented',
      maxBytes: request.query.maxBytes,
      cursor: parseCursor(request.query.cursor),
    }) }
  })
  app.post('/api/v2/tasks/:taskId/timeline/sync', async (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const sync = await agentManager.syncTimeline(agent.id, { force: true })
    return { sync: presentEvent({ type: 'timeline-synced', sync }).sync }
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
  // 本机生成图片可能位于 /tmp 等工作区外目录，仅开放已有的限大小栅格图片预览。
  app.get('/api/v2/tasks/:taskId/local-image/content', async (request, reply) => {
    if (!taskContext(repository, request.params.taskId)) return reply.code(404).send({ error: 'task_not_found' })
    const requestedPath = String(request.query.path || '')
    if (!path.isAbsolute(requestedPath)) throw badRequest('图片路径必须是本机绝对路径。')
    let realPath
    try {
      realPath = fs.realpathSync(requestedPath)
    } catch (cause) {
      if (['ENOENT', 'ENOTDIR'].includes(cause.code)) return reply.code(404).send({ error: 'image_not_found', message: '图片不存在或已被清理。' })
      throw cause
    }
    const file = openWorkspaceFileStream(path.dirname(realPath), path.basename(realPath))
    reply.header('Content-Type', file.mimeType)
    reply.header('Content-Length', String(file.size))
    reply.header('Cache-Control', 'no-store')
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream)
  })
  app.get('/api/v2/tasks/:taskId/file/content', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const file = openWorkspaceFileStream(current.environment.cwd, request.query.path || '', { allowVideo: true, allowAudio: true, range: request.headers.range })
    reply.code(file.statusCode)
    reply.header('Accept-Ranges', 'bytes')
    reply.header('Cache-Control', 'no-store')
    if (file.contentRange) reply.header('Content-Range', file.contentRange)
    reply.header('Content-Type', file.mimeType)
    reply.header('Content-Length', String(file.size))
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('Content-Security-Policy', "default-src 'none'; sandbox")
    return reply.send(file.stream || '')
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
    const { raw, unsubscribes } = initializeSse(request, reply, corsPolicy)
    const writeTask = (agent) => sseWrite(raw, { type: 'task', task: repository.getTask(agent.taskId), agent })
    unsubscribes.push(eventHub.subscribeAll((event) => {
      if (event.type === 'agent') writeTask(event.agent)
    }))
    try { repository.listAllAgents().forEach(writeTask) } catch { raw.destroy() }
  })
  app.post('/api/v2/task-events', (request, reply) => {
    const { subscriptions } = TaskEventSubscriptionsSchema.parse(request.body)
    const { raw, unsubscribes } = initializeSse(request, reply, corsPolicy)
    try {
      for (const subscription of subscriptions) {
        let turnsRevision = subscription.turnsRevision
        let controlRevision = subscription.controlRevision
        const write = event => {
          if (event.type === 'turn') turnsRevision = ''
          if (event.type === 'timeline-synced' && event.sync?.turns) {
            const revision = stateRevision(event.sync.turns)
            const { turns, ...sync } = event.sync
            event = { ...event, sync: { ...sync, turnsRevision: revision, ...(revision !== turnsRevision ? { turns } : {}) } }
            turnsRevision = revision
          }
          if (event.type === 'control') {
            const revision = stateRevision(event.control)
            if (revision === controlRevision) return
            controlRevision = revision
            event = { ...event, revision }
          }
          sseWrite(raw, { type: 'task-event', subscriptionId: subscription.id, event: presentEvent(event) })
        }
        const agent = repository.getTaskAgent(subscription.taskId)
        if (!agent) { write({ type: 'unavailable' }); continue }
        unsubscribes.push(eventHub.subscribe(agent.id, write))
        if (subscription.snapshot) {
          let cursor = parseCursor(subscription.cursor)
          let snapshot
          do {
            snapshot = timelineStore.fetch(subscription.taskId, { direction: cursor ? 'after' : 'tail', cursor, mode: 'presented' })
            if (snapshot.reset) write({ type: 'reset', timeline: snapshot })
            else snapshot.rows.forEach(row => write({ type: 'timeline', epoch: snapshot.epoch, row }))
            cursor = { epoch: snapshot.epoch, seq: snapshot.rows.at(-1)?.seq || 0 }
          } while (snapshot.hasNewer && snapshot.rows.length)
          write({ type: 'agent', agent: repository.getAgent(agent.id) })
          write({ type: 'timeline-synced', sync: { status: 'current', turns: repository.listTurns(subscription.taskId, 1000) } })
          const control = agentManager.controlStates.get(agent.id)
          if (control) write({ type: 'control', control })
          void agentManager.syncTimeline(agent.id).catch(error => request.log.warn(error, 'Timeline 重连同步失败'))
        }
        write({ type: 'ready' })
      }
    } catch { raw.destroy() }
  })
  app.get('/api/v2/tasks/:taskId/events', (request, reply) => {
    const agent = repository.getTaskAgent(request.params.taskId)
    if (!agent) return reply.code(404).send({ error: 'agent_not_found' })
    const { raw, unsubscribes } = initializeSse(request, reply, corsPolicy)
    unsubscribes.push(eventHub.subscribe(agent.id, (event) => sseWrite(raw, presentEvent(event))))
    try {
      const cursor = parseCursor(request.headers['last-event-id'] || request.query.cursor)
      const snapshot = timelineStore.fetch(request.params.taskId, { direction: cursor ? 'after' : 'tail', cursor, mode: 'presented' })
      if (snapshot.reset) sseWrite(raw, { type: 'reset', timeline: snapshot })
      else snapshot.rows.forEach((row) => sseWrite(raw, { type: 'timeline', epoch: snapshot.epoch, row }))
      sseWrite(raw, { type: 'agent', agent: repository.getAgent(agent.id) })
      sseWrite(raw, { type: 'timeline-synced', sync: { status: 'current', turns: repository.listTurns(request.params.taskId, 1000) } })
      const control = agentManager.controlStates.get(agent.id)
      if (control) sseWrite(raw, { type: 'control', control })
      void agentManager.syncTimeline(agent.id).catch((error) => request.log.warn(error, 'Timeline 重连同步失败'))
    } catch { raw.destroy() }
  })
}
