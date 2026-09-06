import {
  CreateProjectInputSchema,
  CreateTaskInputSchema,
  CreateTurnInputSchema,
  UpdateAgentSettingsInputSchema,
  UpdateProjectInputSchema,
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
import { repositoryRoot, defaultBranch, addWorktree, removeWorktree, listCommits, runGit } from '../environments/worktreeService.js'
import { reconcileEnvironment } from '../environments/environmentReconcile.js'

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
  if (typeof value !== 'string' || !value.trim()) throw badRequest('请提供有效的目录路径。')
  let requested
  let stat
  try {
    requested = fs.realpathSync(path.resolve(value.trim()))
    stat = fs.statSync(requested)
  } catch {
    throw badRequest('工作区路径不存在或无法访问。')
  }
  if (!stat.isDirectory()) throw badRequest('工作区路径不是目录。')
  return requested
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
  const { repository, timelineStore, providerRegistry, agentManager, sessionImport, eventHub, assetsDir, corsPolicy } = context

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

  app.get('/api/v2/health', async () => ({ ok: true, version: 3 }))
  app.get('/api/v2/providers', async () => ({ providers: providerRegistry.list() }))
  app.get('/api/v2/directories/search', async (request) => searchDirectories({
    query: request.query.q,
    limit: request.query.limit,
  }))
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
  app.delete('/api/v2/projects/:projectId', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    for (const task of repository.listTasks(project.id, true)) {
      const agent = repository.getTaskAgent(task.id)
      if (agent) {
        await agentManager.cancel(agent.id).catch(() => {})
        agentManager.close(agent.id)
      }
      const assets = repository.listTaskAssets(task.id)
      const environment = repository.getEnvironment(task.environmentId)
      repository.deleteTask(task.id)
      repository.deleteEnvironment(environment?.id)
      removeStoredAssets(assets)
      fs.rmSync(path.join(assetsDir, task.id), { recursive: true, force: true })
    }
    repository.deleteProject(project.id)
    return reply.code(204).send()
  })
  app.get('/api/v2/projects/:projectId/tasks', async (request, reply) => {
    if (!repository.getProject(request.params.projectId)) {
      return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    }
    return { tasks: repository.listTasks(request.params.projectId).map((task) => publicTask(repository, task)) }
  })
  app.post('/api/v2/projects/:projectId/tasks', async (request, reply) => {
    const project = repository.getProject(request.params.projectId)
    if (!project) return reply.code(404).send({ error: 'project_not_found', message: '工作区不存在。' })
    const result = await createTask(project, request.body || {})
    reply.code(201)
    return result
  })

  app.get('/api/v2/tasks/:taskId', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    return current || reply.code(404).send({ error: 'task_not_found', message: '会话不存在。' })
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
    return agent ? { sync: await agentManager.syncTimeline(agent.id) } : reply.code(404).send({ error: 'agent_not_found' })
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
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const message = String(request.body?.message || '').trim()
    if (!message || message.length > 200) return reply.code(400).send({ error: 'invalid_commit_message' })
    const status = await getWorkspaceGitStatus(current.environment.cwd)
    if (!status.files?.length) return reply.code(409).send({ error: 'worktree_clean' })
    await runGit(current.environment.cwd, ['add', '--all'])
    await runGit(current.environment.cwd, ['commit', '-m', message])
    return { commits: await listCommits(current.environment.cwd, 1) }
  })
  app.post('/api/v2/tasks/:taskId/git/push', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const branchName = await defaultBranch(current.environment.cwd)
    if (branchName === 'HEAD') return reply.code(409).send({ error: 'branch_required', message: '请先切换到要推送的分支。' })
    await runGit(current.environment.cwd, ['push', '-u', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`])
    return { pushed: true, branchName }
  })
  app.post('/api/v2/tasks/:taskId/git/merge', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    if (current.environment.kind !== 'worktree' || !current.environment.branchName) {
      return reply.code(409).send({ error: 'worktree_required' })
    }
    const target = String(request.body?.targetBranch || current.project.defaultBranch || '').trim()
    if (!target) return reply.code(400).send({ error: 'target_branch_required' })
    const sourceStatus = await getWorkspaceGitStatus(current.environment.cwd)
    if (sourceStatus.files?.length) return reply.code(409).send({ error: 'worktree_dirty', message: '请先提交会话工作区中的修改，再执行合并。', git: sourceStatus })
    const rootStatus = await getWorkspaceGitStatus(current.project.repositoryRoot)
    if (rootStatus.files?.length) return reply.code(409).send({ error: 'project_dirty', git: rootStatus })
    await runGit(current.project.repositoryRoot, ['checkout', target])
    await runGit(current.project.repositoryRoot, ['merge', '--no-ff', current.environment.branchName, '-m', request.body?.message || `Merge ${current.environment.branchName}`])
    if (request.body?.archive !== false) repository.archiveTask(current.task.id)
    return { merged: true, targetBranch: target, task: repository.getTask(current.task.id) }
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
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    await agentManager.cancel(current.agent.id).catch(() => {})
    agentManager.close(current.agent.id)
    return { task: repository.archiveTask(current.task.id) }
  })
  app.post('/api/v2/tasks/:taskId/environment/reconcile', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const updated = await reconcileEnvironment(current.environment)
    return { environment: repository.updateEnvironment(current.environment.id, { status: updated.status }) }
  })
  app.post('/api/v2/tasks/:taskId/environment/rebind', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    const cwd = resolveDirectoryPath(request.body?.cwd)
    return { environment: repository.rebindEnvironment(current.environment.id, {
      cwd,
      repositoryRoot: request.body?.repositoryRoot === undefined
        ? current.environment.repositoryRoot
        : resolveDirectoryPath(request.body.repositoryRoot),
      kind: 'local',
      ownership: 'external',
    }) }
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
      baseRef: raw.baseRef || current.environment.baseRef || current.project.defaultBranch || 'HEAD',
      branchName: raw.branchName || `codex/${slug}`,
      slug,
    })
    reply.code(201)
    return result
  })
  app.delete('/api/v2/tasks/:taskId', async (request, reply) => {
    const current = taskContext(repository, request.params.taskId)
    if (!current) return reply.code(404).send({ error: 'task_not_found' })
    if (['running', 'stopping'].includes(current.agent.lifecycle)) return reply.code(409).send({ error: 'task_running' })
    const options = request.body || {}
    if (options.deleteWorktree) {
      if (current.environment.kind !== 'worktree' || current.environment.ownership !== 'promptx') {
        return reply.code(409).send({ error: 'worktree_not_owned' })
      }
      const git = await getWorkspaceGitStatus(current.environment.cwd)
      if ((git.files?.length || git.ahead || 0) && !options.force) return reply.code(409).send({ error: 'worktree_dirty', git })
      await removeWorktree(current.environment.repositoryRoot, current.environment.worktreePath || current.environment.cwd, Boolean(options.force))
    }
    agentManager.close(current.agent.id)
    const assets = repository.listTaskAssets(current.task.id)
    repository.deleteTask(current.task.id)
    repository.deleteEnvironment(current.environment.id)
    removeStoredAssets(assets)
    fs.rmSync(path.join(assetsDir, current.task.id), { recursive: true, force: true })
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
