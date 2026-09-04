import { JsonRpcProcess } from './jsonRpcProcess.js'
import { listClaudeHistorySessions } from './history/providers/claudeHistory.js'
import { listKimiHistorySessions } from './history/providers/kimiHistory.js'

function unixSecondsToIso(value) {
  if (!Number.isFinite(Number(value))) return ''
  return new Date(Number(value) * 1000).toISOString()
}

async function listCodexSessions() {
  const rpc = new JsonRpcProcess('codex', ['app-server', '--stdio'], { cwd: process.cwd() })
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'promptx-import', title: 'PromptX', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized', {})
    const sessions = []
    // Codex 当前版本只支持单次非分页查询；带 cursor 会返回 paginated_threads 错误。
    const page = await rpc.request('thread/list', { limit: 500 })
    for (const thread of page.data || []) {
      const preview = String(thread.preview || thread.name || '').trim()
      sessions.push({
        providerId: 'codex',
        providerHandleId: thread.id || thread.sessionId,
        cwd: thread.cwd || '',
        title: String(thread.name || preview || 'Codex 会话').slice(0, 80),
        firstPromptPreview: preview.slice(0, 160),
        lastPromptPreview: preview.slice(0, 160),
        lastActivityAt: unixSecondsToIso(thread.recencyAt || thread.updatedAt || thread.createdAt),
      })
    }
    return sessions
  } finally {
    rpc.close()
  }
}

function sessionKey(providerId, providerHandleId) {
  return `${providerId}:${providerHandleId}`
}

function activityTime(value) {
  const parsed = Date.parse(String(value || ''))
  return Number.isFinite(parsed) ? parsed : 0
}

export class SessionImportService {
  constructor({ repository, providerRegistry, agentManager }) {
    this.repository = repository
    this.providerRegistry = providerRegistry
    this.agentManager = agentManager
  }

  async list({ providerId = '', query = '', limit = 100 } = {}) {
    const providers = providerId ? [this.providerRegistry.get(providerId)] : this.providerRegistry.list()
    const workspaceList = this.repository.listWorkspaces()
    const tasks = providers.map(async (provider) => {
      if (provider.id === 'codex') return listCodexSessions()
      if (provider.id === 'claude') return listClaudeHistorySessions()
      if (provider.id === 'kimi') return listKimiHistorySessions(workspaceList)
      return []
    })
    const results = await Promise.allSettled(tasks)
    const imported = new Set(this.repository.listAllAgents(true).map((agent) => {
      const handle = agent.nativeHandle || {}
      return sessionKey(agent.providerId, handle.threadId || handle.sessionId)
    }))
    const normalizedQuery = String(query || '').trim().toLowerCase()
    return results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
      .filter((session) => session.providerHandleId && !imported.has(sessionKey(session.providerId, session.providerHandleId)))
      .filter((session) => !normalizedQuery || [session.title, session.cwd, session.providerHandleId, session.sessionId, session.firstPromptPreview, session.lastPromptPreview]
        .some((value) => String(value || '').toLowerCase().includes(normalizedQuery)))
      .sort((a, b) => activityTime(b.lastActivityAt) - activityTime(a.lastActivityAt))
      .slice(0, Math.min(500, Math.max(1, Number(limit) || 100)))
  }

  async import({ providerId, providerHandleId, cwd = '', title = '' } = {}) {
    const provider = this.providerRegistry.get(providerId)
    if (!providerHandleId) throw new Error('缺少原生会话 ID。')
    const existing = this.repository.findAgentByProviderHandle(provider.id, provider.id === 'codex'
      ? { threadId: providerHandleId }
      : { sessionId: providerHandleId })
    if (existing) return { agent: existing, imported: false }
    const sessions = await this.list({ providerId, limit: 500 })
    const session = sessions.find((item) => item.providerHandleId === providerHandleId)
    if (!session) throw new Error('找不到该 Provider 会话，可能已被删除或暂时不可用。')
    const requestedCwd = String(cwd || session.cwd || '').trim()
    if (!requestedCwd) throw new Error('无法确定该会话的工作目录，请先在 PromptX 中创建对应项目。')
    const workspace = this.repository.createWorkspace({ cwd: requestedCwd })
    const nativeHandle = provider.id === 'codex' ? { threadId: providerHandleId } : { sessionId: providerHandleId }
    let agent = this.repository.createAgent(workspace.id, {
      providerId: provider.id,
      title: String(title || session?.title || `${provider.label} 会话`).slice(0, 120),
      nativeHandle,
    }, provider.capabilities)
    try {
      agent = this.repository.updateAgent(agent.id, { lifecycle: 'ready' })
      await this.agentManager.syncTimeline(agent.id)
      return { agent: this.repository.getAgent(agent.id), imported: true, workspace: this.repository.getWorkspace(workspace.id) }
    } catch (error) {
      this.agentManager.close(agent.id)
      this.repository.deleteAgent(agent.id)
      throw error
    }
  }
}
