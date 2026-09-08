import { randomUUID } from 'node:crypto'
import { TimelineCoalescer } from '../timeline/timelineCoalescer.js'
import { DEFAULT_AGENT_TITLE, deriveAgentTitle } from './sessionTitle.js'
import { TimelineSyncCoordinator } from './history/timelineSyncCoordinator.js'

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
    this.preparingTurns = new Set()
    this.exclusiveOperations = new Set()
    this.controlStates = new Map()
    this.coalescer = new TimelineCoalescer((payload) => this.commitTimeline(payload))
    this.timelineSync = new TimelineSyncCoordinator({
      repository,
      timelineStore,
      eventHub,
      getRuntime: (agent) => this.getRuntime(agent),
      getActiveTurnId: (agentId) => this.activeTurns.get(agentId)?.id || '',
    })
  }

  getRuntime(agent) {
    let runtime = this.runtimes.get(agent.id)
    if (runtime) return runtime
    const task = this.repository.getTask(agent.taskId)
    const environment = task && this.repository.getEnvironment(task.environmentId)
    if (!environment || ['missing', 'removed', 'unavailable'].includes(environment.status)) {
      throw new Error('当前会话的执行目录不可用。')
    }
    runtime = this.providerRegistry.get(agent.providerId).createRuntime({
      cwd: environment.cwd,
      nativeHandle: agent.nativeHandle,
      modelId: agent.modelId,
      config: agent.config,
    })
    runtime.on('handle', (nativeHandle) => this.repository.updateAgent(agent.id, {
      nativeHandle,
      lifecycle: this.activeTurns.has(agent.id) ? 'running' : 'ready',
    }))
    runtime.on('providerConfig', (providerConfig) => {
      const current = this.repository.getAgent(agent.id)
      if (current) this.repository.updateAgent(agent.id, { config: { ...current.config, ...providerConfig } })
    })
    runtime.on('controlState', (control) => {
      this.controlStates.set(agent.id, control)
      this.eventHub.publish(agent.id, { type: 'control', control })
    })
    runtime.on('timeline', (item) => {
      const turn = this.activeTurns.get(agent.id)
      if (turn) this.coalescer.push(agent.id, { agentId: agent.id, turnId: turn.id, item })
    })
    runtime.on('turnStarted', ({ nativeTurnId } = {}) => this.markStarted(agent.id, nativeTurnId))
    runtime.on('turnCompleted', ({ usage } = {}) => this.finish(agent.id, 'completed', { usage }))
    runtime.on('turnFailed', (error) => this.finish(agent.id, 'failed', { error }))
    runtime.on('turnCanceled', () => this.finish(agent.id, 'canceled'))
    runtime.on('runtimeExit', () => {
      if (this.runtimes.get(agent.id) === runtime) this.runtimes.delete(agent.id)
      if (this.activeTurns.has(agent.id)) this.finish(agent.id, 'failed', { error: new Error('Agent 运行时意外退出。') })
    })
    runtime.on('error', (error) => this.finish(agent.id, 'failed', { error }))
    this.runtimes.set(agent.id, runtime)
    return runtime
  }

  async startTurn(agentId, input) {
    let agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    if (agent.archivedAt) throw new Error('已归档的 Agent 不能发送消息。')
    const task = this.repository.getTask(agent.taskId)
    const project = task && this.repository.getProject(task.projectId)
    if (!task || task.lifecycle !== 'active' || project?.lifecycle !== 'active') {
      const error = new Error('请先恢复工作区和会话。')
      error.statusCode = 409
      error.code = 'task_archived'
      throw error
    }
    const existing = this.repository.getTurnByClientMessage(agent.taskId, input.clientMessageId)
    if (existing) return existing
    if (this.isBusy(agentId)) {
      const error = new Error('Agent 正在运行，请等待当前任务完成后再发送。')
      error.statusCode = 409
      throw error
    }
    const providerContent = input.input.content.map((block) => {
      if (block.type === 'text') return block
      const asset = this.repository.getAsset(block.assetId)
      if (!asset || asset.taskId !== agent.taskId) throw new Error(`附件不存在或不属于当前会话：${block.name}`)
      if (block.type === 'image' && !asset.mimeType.startsWith('image/')) throw new Error(`附件不是图片：${asset.name}`)
      return {
        ...block,
        name: asset.name,
        mimeType: asset.mimeType,
        size: asset.size,
        absolutePath: asset.storagePath,
      }
    })
    let runtime = null
    this.preparingTurns.add(agentId)
    try {
      runtime = this.getRuntime(agent)
      if (typeof runtime.prepareTurn === 'function') await runtime.prepareTurn()

      const currentAgent = this.repository.getAgent(agentId)
      if (!currentAgent) {
        const error = new Error('Agent 不存在。')
        error.statusCode = 404
        throw error
      }
      if (currentAgent.archivedAt || this.runtimes.get(agentId) !== runtime) {
        const error = new Error('Agent 状态已变化，请确认后重新发送。')
        error.statusCode = 409
        throw error
      }
      agent = currentAgent

      const timelineContent = providerContent.map(({ absolutePath, ...block }) => block)
      const isFirstTurn = !this.repository.hasTurns(agent.taskId)
      const patch = {}
      if (isFirstTurn && agent.title === DEFAULT_AGENT_TITLE) {
        const title = deriveAgentTitle(input.input.content)
        if (title) patch.title = title
      }
      if (agent.requiresAttention) {
        patch.requiresAttention = false
        patch.attentionReason = null
        patch.attentionAt = null
      }
      if (Object.keys(patch).length) {
        if (patch.title) this.repository.updateTask(agent.taskId, { title: patch.title })
        delete patch.title
        agent = this.repository.updateAgent(agent.id, patch)
        this.eventHub.publish(agent.id, { type: 'agent', agent })
      }
      const turn = this.repository.createTurn(agent.taskId, input.clientMessageId)
      this.activeTurns.set(agentId, turn)
      this.commitTimeline({
        agentId,
        turnId: turn.id,
        item: { type: 'user_message', clientMessageId: input.clientMessageId, content: timelineContent },
      })
      this.markStarted(agentId)
      try {
        const result = await runtime.startTurn(providerContent, input.clientMessageId)
        if (result?.nativeTurnId) this.markStarted(agentId, result.nativeTurnId)
        return this.repository.getTurn(turn.id)
      } catch (error) {
        this.finish(agentId, 'failed', { error })
        throw error
      }
    } finally {
      this.preparingTurns.delete(agentId)
      if (
        !this.activeTurns.has(agentId)
        && runtime
        && this.runtimes.get(agentId) === runtime
        && typeof runtime.releaseThreadWriter === 'function'
      ) {
        this.runtimes.delete(agentId)
        runtime.releaseThreadWriter()
      }
    }
  }

  async getControlState(agentId) {
    const agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    const control = await this.getRuntime(agent).getControlState()
    this.controlStates.set(agentId, control)
    return control
  }

  async syncTimeline(agentId) {
    const agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    return this.timelineSync.sync(agent)
  }

  async updateSettings(agentId, input) {
    const agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    if (this.isBusy(agentId)) {
      const error = new Error('Agent 运行期间不能切换模型或思考强度。')
      error.statusCode = 409
      throw error
    }
    const control = await this.getControlState(agentId)
    const modelId = input.modelId || agent.modelId || control.currentModelId
    const selectedModel = control.models.find((model) => model.id === modelId)
    if (input.modelId && !selectedModel) {
      const error = new Error(`当前 Agent 不支持模型：${input.modelId}`)
      error.statusCode = 400
      throw error
    }
    const availableEfforts = selectedModel?.reasoningEfforts?.length
      ? selectedModel.reasoningEfforts
      : control.reasoningEfforts
    let reasoningEffort = input.reasoningEffort || agent.config.reasoningEffort || control.currentReasoningEffort
    if (input.modelId && !availableEfforts.some((effort) => effort.id === reasoningEffort)) {
      reasoningEffort = selectedModel?.defaultReasoningEffort || availableEfforts[0]?.id || ''
    }
    if (input.reasoningEffort && !availableEfforts.some((effort) => effort.id === input.reasoningEffort)) {
      const error = new Error(`当前模型不支持思考强度：${input.reasoningEffort}`)
      error.statusCode = 400
      throw error
    }
    const runtime = this.runtimes.get(agentId)
    if (typeof runtime?.updateSettings === 'function') {
      const nextControl = await runtime.updateSettings({ modelId, reasoningEffort })
      const current = this.repository.getAgent(agentId)
      const updated = this.repository.updateAgent(agentId, {
        modelId,
        config: { ...current.config, reasoningEffort },
      })
      this.controlStates.set(agentId, nextControl)
      this.eventHub.publish(agentId, { type: 'agent', agent: updated })
      return { agent: updated, control: nextControl }
    }
    const updated = this.repository.updateAgent(agentId, {
      modelId,
      config: { ...agent.config, reasoningEffort },
    })
    this.runtimes.delete(agentId)
    runtime?.close()
    this.controlStates.delete(agentId)
    this.eventHub.publish(agentId, { type: 'agent', agent: updated })
    const nextControl = await this.getControlState(agentId)
    return { agent: this.repository.getAgent(agentId), control: nextControl }
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
    this.repository.updateTask(updated.taskId, { lastActiveAt: nowIso() })
    this.eventHub.publish(agentId, { type: 'turn', turn: updated })
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
    const attention = status === 'completed'
      ? { requiresAttention: true, attentionReason: 'finished', attentionAt: nowIso() }
      : status === 'failed'
        ? { requiresAttention: true, attentionReason: 'error', attentionAt: nowIso() }
        : {}
    const agent = this.repository.updateAgent(agentId, {
      lifecycle: 'ready',
      lastError: message,
      lastActiveAt: nowIso(),
      ...attention,
    })
    this.repository.updateTask(agent.taskId, { lastActiveAt: nowIso() })
    this.eventHub.publish(agentId, { type: 'turn', turn: updated })
    this.eventHub.publish(agentId, { type: 'agent', agent })
    const runtime = this.runtimes.get(agentId)
    if (runtime && typeof runtime.releaseThreadWriter === 'function') {
      this.runtimes.delete(agentId)
      runtime.releaseThreadWriter()
    }
    void this.timelineSync.sync(agent).catch(() => {})
  }

  commitTimeline({ agentId, turnId, item }) {
    const agent = this.repository.getAgent(agentId)
    const row = this.timelineStore.append(agent.taskId, turnId, item)
    const state = this.repository.getTimelineState(agent.taskId)
    this.eventHub.publish(agentId, { type: 'timeline', epoch: state.epoch, row })
    return row
  }

  async cancel(agentId) {
    const runtime = this.runtimes.get(agentId)
    if (!runtime || !this.activeTurns.has(agentId)) return false
    await runtime.cancel()
    return true
  }

  isBusy(agentId) {
    return this.activeTurns.has(agentId) || this.preparingTurns.has(agentId) || this.exclusiveOperations.has(agentId)
  }

  async runExclusive(agentId, callback) {
    if (this.isBusy(agentId)) {
      const error = new Error('Agent 正在运行，请等待当前任务完成后再操作。')
      error.statusCode = 409
      error.code = 'task_running'
      throw error
    }
    this.exclusiveOperations.add(agentId)
    try {
      return await callback()
    } finally {
      this.exclusiveOperations.delete(agentId)
    }
  }

  async interruptAndRunExclusive(agentIds, callback) {
    const ids = [...new Set([agentIds].flat().filter(Boolean))]
    if (ids.some((id) => this.exclusiveOperations.has(id))) {
      const error = new Error('会话正在执行其他操作，请稍后再试。')
      error.statusCode = 409
      error.code = 'task_busy'
      throw error
    }
    ids.forEach((id) => this.exclusiveOperations.add(id))
    try {
      for (const id of ids) {
        await this.cancel(id).catch(() => {})
        if (this.activeTurns.has(id)) this.finish(id, 'canceled')
        this.close(id)
      }
      return await callback()
    } finally {
      ids.forEach((id) => this.exclusiveOperations.delete(id))
    }
  }

  close(agentId) {
    this.runtimes.get(agentId)?.close()
    this.runtimes.delete(agentId)
    this.controlStates.delete(agentId)
    return this.repository.updateAgent(agentId, { lifecycle: 'ready' })
  }

  shutdown() {
    this.coalescer.flushAll()
    for (const runtime of this.runtimes.values()) runtime.close()
    this.runtimes.clear()
    this.preparingTurns.clear()
    this.exclusiveOperations.clear()
    this.controlStates.clear()
  }
}
