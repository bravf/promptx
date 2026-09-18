import fs from 'node:fs'
import { repositoryContext, defaultBranch } from '../environments/worktreeService.js'

function sessionKey(providerId, providerHandleId) {
  return `${providerId}:${providerHandleId}`
}

function activityTime(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export class SessionImportService {
  constructor({ repository, providerRegistry, agentManager, historyLoaders = {}, cacheTtlMs = 5_000 }) {
    this.repository = repository
    this.providerRegistry = providerRegistry
    this.agentManager = agentManager
    this.cacheTtlMs = cacheTtlMs
    this.cache = new Map()
    this.historyLoaders = historyLoaders
  }

  loadProvider(provider, projectList) {
    const now = Date.now()
    const cached = this.cache.get(provider.id)
    if (cached && cached.expiresAt > now) return cached.promise
    const loader = this.historyLoaders[provider.id] || provider.listHistorySessions
    const directories = projectList.map((project) => ({ cwd: project.repositoryRoot }))
    const promise = Promise.resolve().then(() => loader ? loader(directories) : [])
    this.cache.set(provider.id, { expiresAt: now + this.cacheTtlMs, promise })
    return promise
  }

  async list({ providerId = '', query = '', limit = 100 } = {}) {
    const providers = providerId
      ? [this.providerRegistry.get(providerId)]
      : this.providerRegistry.list().map((item) => this.providerRegistry.get(item.id))
    const projectList = this.repository.listProjects()
    const tasks = providers.map((provider) => this.loadProvider(provider, projectList))
    const results = await Promise.allSettled(tasks)
    const imported = new Set(this.repository.listAllAgents(true).map((agent) => {
      const handle = agent.nativeHandle || {}
      return sessionKey(agent.providerId, handle.threadId || handle.sessionId)
    }))
    const normalizedQuery = String(query || '').trim().toLowerCase()
    const sessions = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((session) => session.providerHandleId && !imported.has(sessionKey(session.providerId, session.providerHandleId)))
      .filter((session) => !normalizedQuery || [session.title, session.cwd, session.providerHandleId, session.sessionId, session.firstPromptPreview, session.lastPromptPreview]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)))
      .sort((a, b) => activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
    const errors = results.flatMap((result, index) => result.status === 'rejected' ? [{
      providerId: providers[index].id,
      providerLabel: providers[index].label,
      message: result.reason?.message || '扫描失败',
    }] : [])
    return { sessions, errors }
  }

  async import({ providerId, providerHandleId, cwd = '', title = '' } = {}) {
    const provider = this.providerRegistry.get(providerId)
    if (!providerHandleId) throw new Error('缺少原生会话 ID。')
    const existing = this.repository.findAgentByProviderHandle(provider.id, provider.id === 'codex'
      ? { threadId: providerHandleId }
      : { sessionId: providerHandleId })
    if (existing) return { agent: existing, imported: false }
    const { sessions } = await this.list({ providerId, limit: 500 })
    const session = sessions.find((item) => item.providerHandleId === providerHandleId)
    if (!session) throw new Error('找不到该 Provider 会话，可能已被删除或暂时不可用。')
    const requestedCwd = String(cwd || session.cwd || '').trim()
    if (!requestedCwd) throw new Error('无法确定该会话的工作目录，请先在 PromptX 中创建对应项目。')
    let project = null
    let projectCreated = false
    let gitContext = null
    try {
      gitContext = await repositoryContext(requestedCwd)
      const root = gitContext.repositoryRoot
      project = this.repository.getProjectByRoot(root)
      if (!project) {
        project = this.repository.createProject({ repositoryRoot: root, displayName: root.split(/[\\/]/).pop(), defaultBranch: await defaultBranch(root) })
        projectCreated = true
      }
    } catch {
      project = this.repository.getProjectByRoot(requestedCwd)
      if (!project) {
        project = this.repository.createProject({ repositoryRoot: requestedCwd, displayName: requestedCwd.split(/[\\/]/).pop() })
        projectCreated = true
      }
    }
    const environment = this.repository.createEnvironment({
      kind: gitContext?.isWorktree ? 'worktree' : 'local',
      cwd: requestedCwd,
      repositoryRoot: project.repositoryRoot,
      branchName: gitContext?.branchName || '',
      worktreePath: gitContext?.isWorktree ? gitContext.checkoutRoot : null,
      ownership: 'external',
      status: fs.existsSync(requestedCwd) ? 'ready' : 'unavailable',
    })
    const task = this.repository.createTask({ projectId: project.id, environmentId: environment.id, providerId: provider.id, title: String(title || session?.title || `${provider.label} 会话`).slice(0, 120) })
    const nativeHandle = provider.id === 'codex' ? { threadId: providerHandleId } : { sessionId: providerHandleId }
    let agent = null
    try {
      agent = this.repository.createAgent(task.id, {
        providerId: provider.id,
        nativeHandle,
      }, provider.capabilities)
      agent = this.repository.updateAgent(agent.id, { lifecycle: 'ready' })
      if (environment.status !== 'unavailable') {
        const sync = await this.agentManager.syncTimeline(agent.id, { force: true })
        if (sync.status !== 'synced') {
          throw new Error(sync.status === 'unsupported' ? '该 Provider 不支持导入历史记录。' : 'Provider 历史记录暂时不可用。')
        }
        if (!this.repository.hasTurns(task.id)) throw new Error('Provider 会话中没有可导入的完整 Turn。')
      }
      return { agent: this.repository.getAgent(agent.id), imported: true, project, task: this.repository.getTask(task.id), environment }
    } catch (error) {
      if (agent) this.agentManager.close(agent.id)
      this.repository.deleteTask(task.id)
      this.repository.deleteEnvironment(environment.id)
      if (projectCreated && this.repository.listTasks(project.id, true).length === 0) this.repository.deleteProject(project.id)
      throw error
    }
  }
}
