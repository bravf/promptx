import { randomUUID } from 'node:crypto'
import { TimelineCoalescer } from '../timeline/timelineCoalescer.js'
import { DEFAULT_AGENT_TITLE, deriveAgentTitle } from './sessionTitle.js'
import { TimelineSyncCoordinator } from './history/timelineSyncCoordinator.js'
import { resolveBackgroundTaskOwnership } from './backgroundTaskOwnership.js'

function nowIso() {
  return new Date().toISOString()
}

export class AgentManager {
  constructor({ repository, timelineStore, providerRegistry, eventHub, assetsDir }) {
    this.repository = repository
    this.timelineStore = timelineStore
    this.providerRegistry = providerRegistry
    this.eventHub = eventHub
    this.runtimes = new Map()
    this.activeTurns = new Map()
    this.preparingTurns = new Set()
    this.exclusiveOperations = new Set()
    this.controlStates = new Map()
    this.toolOwners = new Map()
    this.toolOwnerSessions = new Set()
    this.coalescer = new TimelineCoalescer((payload) => this.commitTimeline(payload))
    this.timelineSync = new TimelineSyncCoordinator({
      assetsDir,
      repository,
      timelineStore,
      eventHub,
      getRuntime: (agent) => this.getRuntime(agent),
      getActiveTurnId: (agentId) => this.activeTurns.get(agentId)?.id || '',
    })
  }

  reconcileBackgroundTaskOwnership(agent) {
    const tasks = this.repository.getAgent(agent.id)?.backgroundTasks || []
    if (!tasks.length) return
    if (!this.toolOwnerSessions.has(agent.id)) {
      for (const row of this.repository.listTimelineRows(agent.taskId)) if (row.item.type === 'tool_call') this.toolOwners.set(`${agent.id}:${row.item.callId}`, row.turnId || null)
      this.toolOwnerSessions.add(agent.id)
    }
    const callTurns = new Map(tasks.map(task => [task.callId, this.toolOwners.get(`${agent.id}:${task.callId}`)]))
    let changed = false
    for (const resolved of resolveBackgroundTaskOwnership(tasks, callTurns)) {
      const saved = tasks.find(item => item.id === resolved.id)
      if (saved.originTurnId !== resolved.originTurnId || saved.parentTaskId !== resolved.parentTaskId) {
        this.repository.upsertProviderTask(agent.id, { id: resolved.id, originTurnId: resolved.originTurnId, ...(resolved.parentTaskId ? { parentTaskId: resolved.parentTaskId } : {}) })
        changed = true
      }
    }
    if (changed) this.eventHub.publish(agent.id, { type: 'agent', agent: this.repository.getAgent(agent.id) })
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
    runtime.on('capabilities', (capabilities) => {
      if (this.repository.getAgent(agent.id)) this.repository.updateAgent(agent.id, { capabilities })
    })
    runtime.on('backgroundTask', (task) => {
      if (this.runtimes.get(agent.id) !== runtime) return
      const previous = this.repository.getAgent(agent.id)?.backgroundTasks?.find(item => item.id === task.id)
      this.repository.upsertProviderTask(agent.id, { ...task, originTurnId: previous?.originTurnId || (agent.providerId !== 'claude' || task.parentCallId === null ? this.activeTurns.get(agent.id)?.id : null) || null })
      this.reconcileBackgroundTaskOwnership(agent)
      const updated = this.repository.getAgent(agent.id)
      if (updated.backgroundTasks.some(item => ['running', 'pending'].includes(item.status) && !item.ambient)) {
        this.repository.updateAgent(agent.id, { requiresAttention: false, attentionReason: null, attentionAt: null })
      } else if (!this.activeTurns.has(agent.id) && !task.ambient && previous?.status !== task.status) {
        const related = updated.backgroundTasks.filter(item => !item.ambient && item.originTurnId === previous?.originTurnId)
        const failed = related.some(item => ['failed', 'interrupted'].includes(item.status))
        if (failed || task.status === 'completed') this.repository.updateAgent(agent.id, {
          requiresAttention: true, attentionReason: failed ? 'error' : 'finished', attentionAt: nowIso(),
        })
      }
      this.eventHub.publish(agent.id, { type: 'agent', agent: this.repository.getAgent(agent.id) })
    })
    runtime.on('timeline', (item, context = {}) => {
      if (this.runtimes.get(agent.id) !== runtime) return
      const turn = this.activeTurns.get(agent.id)
      if (item.type === 'tool_call' && item.callId) {
        if (!this.toolOwnerSessions.has(agent.id)) {
          for (const row of this.repository.listTimelineRows(agent.taskId)) if (row.item.type === 'tool_call') this.toolOwners.set(`${agent.id}:${row.item.callId}`, row.turnId || null)
          this.toolOwnerSessions.add(agent.id)
        }
        const key = `${agent.id}:${item.callId}`
        if (!this.toolOwners.has(key)) {
          this.toolOwners.set(key, turn?.id || null)
          this.reconcileBackgroundTaskOwnership(agent)
        }
        const owner = this.toolOwners.get(key)
        if (owner !== turn?.id) { this.commitTimeline({ agentId: agent.id, turnId: owner, item }); return }
      }
      if (context.nativeTurnId && turn?.nativeTurnId && context.nativeTurnId !== turn.nativeTurnId) return
      if (turn) this.coalescer.push(agent.id, { agentId: agent.id, turnId: turn.id, item })
      else this.commitTimeline({ agentId: agent.id, turnId: null, item })
    })
    runtime.on('turnStarted', ({ nativeTurnId, autonomous = false } = {}) => {
      if (this.runtimes.get(agent.id) !== runtime) return
      const pending = this.activeTurns.get(agent.id)
      if (autonomous && pending && !pending.nativeTurnId) {
        this.finish(agent.id, 'failed', { error: new Error('后台自动续跑先于本次提交开始，请稍后重试。'), runId: pending.clientMessageId })
      }
      if (!this.activeTurns.has(agent.id) && autonomous) {
        const turn = this.repository.createTurn(agent.taskId, `autonomous:${nativeTurnId || randomUUID()}`)
        this.activeTurns.set(agent.id, turn)
        this.commitTimeline({ agentId: agent.id, turnId: turn.id, item: { type: 'system_notice', code: 'autonomous_turn', text: '后台任务触发自动续跑' } })
      }
      this.markStarted(agent.id, nativeTurnId)
    })
    runtime.on('turnCompleted', ({ usage, nativeTurnId, runId } = {}) => this.finish(agent.id, 'completed', { usage, nativeTurnId, runId, runtime }))
    runtime.on('turnFailed', (error) => this.finish(agent.id, 'failed', { error, nativeTurnId: error.nativeTurnId, runId: error.runId, runtime }))
    runtime.on('turnCanceled', ({ nativeTurnId, runId } = {}) => this.finish(agent.id, 'canceled', { nativeTurnId, runId, runtime }))
    runtime.on('runtimeExit', () => {
      if (this.runtimes.get(agent.id) !== runtime) return
      this.runtimes.delete(agent.id)
      if (this.activeTurns.has(agent.id)) this.finish(agent.id, 'failed', { error: new Error('Agent 运行时意外退出。') })
      else {
        const updated = this.repository.updateAgent(agent.id, { lifecycle: 'failed', lastError: 'Agent 运行时意外退出。', requiresAttention: true, attentionReason: 'error', attentionAt: nowIso() })
        this.eventHub.publish(agent.id, { type: 'agent', agent: updated })
      }
    })
    runtime.on('error', (error) => this.finish(agent.id, 'failed', { error, runtime }))
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
    if (this.isBusy(agentId, { includeBackground: false })) {
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
      if (this.activeTurns.has(agentId)) {
        const error = new Error('Agent 已开始自动续跑，请稍后重试。')
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
        if (result?.nativeTurnId && this.activeTurns.get(agentId)?.id === turn.id) this.markStarted(agentId, result.nativeTurnId)
        return this.repository.getTurn(turn.id)
      } catch (error) {
        this.finish(agentId, 'failed', { error, runId: input.clientMessageId })
        throw error
      }
    } finally {
      this.preparingTurns.delete(agentId)
      if (
        !this.activeTurns.has(agentId)
        && runtime
        && this.runtimes.get(agentId) === runtime
        && !runtime.backgroundTasks?.running.length
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

  async syncTimeline(agentId, options = {}) {
    const agent = this.repository.getAgent(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    return this.timelineSync.sync(agent, options)
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
        modelId: nextControl.currentModelId,
        config: { ...current.config, reasoningEffort: nextControl.currentReasoningEffort },
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
    this.repository.updateAgent(agentId, { lifecycle: 'running', lastActiveAt: nowIso(), requiresAttention: false, attentionReason: null, attentionAt: null })
    this.repository.updateTask(updated.taskId, { lastActiveAt: nowIso() })
    this.eventHub.publish(agentId, { type: 'turn', turn: updated })
    this.eventHub.publish(agentId, { type: 'agent', agent: this.repository.getAgent(agentId) })
  }

  finish(agentId, status, { usage = {}, error = null, nativeTurnId = '', runId = '', runtime: sourceRuntime = null } = {}) {
    const turn = this.activeTurns.get(agentId)
    if (!turn) return
    if (runId && turn.clientMessageId !== runId) return
    if (sourceRuntime && this.runtimes.get(agentId) !== sourceRuntime) return
    if (nativeTurnId && turn.nativeTurnId && turn.nativeTurnId !== nativeTurnId) return
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
    const backgroundTasks = this.repository.getAgent(agentId)?.backgroundTasks || []
    const hasBackground = backgroundTasks.some(task => ['running', 'pending'].includes(task.status) && !task.ambient)
    const requestTurn = this.repository.listTurns(turn.taskId).find(item => !item.clientMessageId.startsWith('autonomous:'))
    const hasBackgroundError = backgroundTasks.some(task => !task.ambient
      && ['failed', 'interrupted'].includes(task.status)
      && [turn.id, requestTurn?.id].includes(task.originTurnId))
    const attention = status === 'completed' && !hasBackground
      ? { requiresAttention: true, attentionReason: hasBackgroundError ? 'error' : 'finished', attentionAt: nowIso() }
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
    if (runtime && !runtime.backgroundTasks?.running.length
        && typeof runtime.releaseThreadWriter === 'function') {
      this.runtimes.delete(agentId)
      runtime.releaseThreadWriter()
    }
    this.timelineSync.confirm(agent, turn.id)
  }

  commitTimeline({ agentId, turnId, item }) {
    const agent = this.repository.getAgent(agentId)
    const row = this.timelineStore.append(agent.taskId, turnId, item)
    const state = this.repository.getTimelineState(agent.taskId)
    this.eventHub.publish(agentId, { type: 'timeline', epoch: state.epoch, row })
    return row
  }

  async cancel(agentId, { all = false } = {}) {
    const runtime = this.runtimes.get(agentId)
    if (!runtime) return false
    const errors = []
    if (all && runtime.stopBackgroundTasks) {
      try { await runtime.stopBackgroundTasks() } catch (error) { errors.push(error) }
    }
    const active = this.activeTurns.has(agentId)
    if (active) {
      try { await runtime.cancel() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, `部分任务停止失败：${errors.map(error => error.message).join('；')}`)
    return active || all
  }

  isBusy(agentId, { includeBackground = true } = {}) {
    const background = includeBackground && this.repository.getAgent?.(agentId)?.backgroundTasks?.some(task => !task.ambient && ['pending', 'running'].includes(task.status))
    return Boolean(background) || this.activeTurns.has(agentId) || this.preparingTurns.has(agentId) || this.exclusiveOperations.has(agentId)
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

  async shutdown() {
    this.coalescer.flushAll()
    this.toolOwners.clear()
    this.toolOwnerSessions.clear()
    for (const runtime of this.runtimes.values()) runtime.close()
    this.runtimes.clear()
    this.preparingTurns.clear()
    this.exclusiveOperations.clear()
    this.controlStates.clear()
    await this.timelineSync.shutdown()
  }
}
