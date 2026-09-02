import { randomUUID } from 'node:crypto'
import { TimelineCoalescer } from '../timeline/timelineCoalescer.js'

function nowIso() {
  return new Date().toISOString()
}

export class AgentManager {
  constructor({ repository, timelineStore, providerRegistry, eventHub }) {
    this.repository = repository
    this.timelineStore = timelineStore
    this.providerRegistry = providerRegistry
    this.eventHub = eventHub
    this.runtimes = new Map()
    this.activeTurns = new Map()
    this.coalescer = new TimelineCoalescer((payload) => this.commitTimeline(payload))
  }

  getRuntime(agent) {
    let runtime = this.runtimes.get(agent.id)
    if (runtime) return runtime
    const workspace = this.repository.getWorkspace(agent.workspaceId)
    runtime = this.providerRegistry.get(agent.providerId).createRuntime({
      cwd: workspace.cwd,
      nativeHandle: agent.nativeHandle,
      modelId: agent.modelId,
      config: agent.config,
    })
    runtime.on('handle', (nativeHandle) => this.repository.updateAgent(agent.id, {
      nativeHandle,
      lifecycle: this.activeTurns.has(agent.id) ? 'running' : 'ready',
    }))
    runtime.on('timeline', (item) => {
      const turn = this.activeTurns.get(agent.id)
      if (turn) this.coalescer.push(agent.id, { agentId: agent.id, turnId: turn.id, item })
    })
    runtime.on('turnStarted', ({ nativeTurnId } = {}) => this.markStarted(agent.id, nativeTurnId))
    runtime.on('turnCompleted', ({ usage } = {}) => this.finish(agent.id, 'completed', { usage }))
    runtime.on('turnFailed', (error) => this.finish(agent.id, 'failed', { error }))
    runtime.on('turnCanceled', () => this.finish(agent.id, 'canceled'))
    runtime.on('runtimeExit', () => {
      this.runtimes.delete(agent.id)
      if (this.activeTurns.has(agent.id)) this.finish(agent.id, 'failed', { error: new Error('Agent 运行时意外退出。') })
    })
    runtime.on('error', (error) => this.finish(agent.id, 'failed', { error }))
    this.runtimes.set(agent.id, runtime)
    return runtime
  }

  async startTurn(agentId, input) {
    const agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    if (agent.archivedAt) throw new Error('已归档的 Agent 不能发送消息。')
    const existing = this.repository.getTurnByClientMessage(agentId, input.clientMessageId)
    if (existing) return existing
    const turn = this.repository.createTurn(agentId, input.clientMessageId)
    this.activeTurns.set(agentId, turn)
    this.commitTimeline({
      agentId,
      turnId: turn.id,
      item: { type: 'user_message', clientMessageId: input.clientMessageId, content: input.input.content },
    })
    this.markStarted(agentId)
    try {
      const result = await this.getRuntime(agent).startTurn(input.input.content, input.clientMessageId)
      if (result?.nativeTurnId) this.markStarted(agentId, result.nativeTurnId)
      return this.repository.getTurn(turn.id)
    } catch (error) {
      this.finish(agentId, 'failed', { error })
      throw error
    }
  }

  markStarted(agentId, nativeTurnId = '') {
    const turn = this.activeTurns.get(agentId)
    if (!turn) return
    const updated = this.repository.updateTurn(turn.id, {
      status: 'running',
      nativeTurnId: nativeTurnId || turn.nativeTurnId,
      startedAt: turn.startedAt || nowIso(),
    })
    this.activeTurns.set(agentId, updated)
    this.repository.updateAgent(agentId, { lifecycle: 'running', lastActiveAt: nowIso() })
    this.eventHub.publish(agentId, { type: 'agent', agent: this.repository.getAgent(agentId) })
  }

  finish(agentId, status, { usage = {}, error = null } = {}) {
    const turn = this.activeTurns.get(agentId)
    if (!turn) return
    this.coalescer.flush(agentId)
    const message = error?.message || ''
    const updated = this.repository.updateTurn(turn.id, {
      status,
      usage,
      errorMessage: message,
      finishedAt: nowIso(),
    })
    if (status === 'failed') {
      this.commitTimeline({ agentId, turnId: turn.id, item: { type: 'error', code: 'provider_error', message } })
    }
    this.activeTurns.delete(agentId)
    const agent = this.repository.updateAgent(agentId, { lifecycle: 'ready', lastError: message, lastActiveAt: nowIso() })
    this.eventHub.publish(agentId, { type: 'turn', turn: updated })
    this.eventHub.publish(agentId, { type: 'agent', agent })
  }

  commitTimeline({ agentId, turnId, item }) {
    const row = this.timelineStore.append(agentId, turnId, item)
    const state = this.repository.getTimelineState(agentId)
    this.eventHub.publish(agentId, { type: 'timeline', epoch: state.epoch, row })
    return row
  }

  async cancel(agentId) {
    const runtime = this.runtimes.get(agentId)
    if (!runtime || !this.activeTurns.has(agentId)) return false
    await runtime.cancel()
    return true
  }

  close(agentId) {
    this.runtimes.get(agentId)?.close()
    this.runtimes.delete(agentId)
    return this.repository.updateAgent(agentId, { lifecycle: 'ready' })
  }

  shutdown() {
    this.coalescer.flushAll()
    for (const runtime of this.runtimes.values()) runtime.close()
    this.runtimes.clear()
  }
}
