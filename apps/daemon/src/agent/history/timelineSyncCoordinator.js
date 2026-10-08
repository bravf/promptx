import { resolveBackgroundTaskOwnership } from '../backgroundTaskOwnership.js'
import { reconcileHistory } from './historyReconciler.js'
import { materializeHistoryImages } from './historyImages.js'
import { assertHistorySnapshot, HISTORY_RECONCILER_VERSION } from './historySnapshot.js'

const DEFAULT_CONFIRM_RETRY_DELAYS = [500, 1_000, 2_000, 5_000]
const DEFAULT_SYNC_FRESHNESS_MS = 1_000

export class TimelineSyncCoordinator {
  constructor({
    repository,
    assetsDir,
    timelineStore,
    eventHub,
    getRuntime,
    getActiveTurnId,
    onSynced = () => {},
    confirmRetryDelays = DEFAULT_CONFIRM_RETRY_DELAYS,
    syncFreshnessMs = DEFAULT_SYNC_FRESHNESS_MS,
  }) {
    this.repository = repository
    this.assetsDir = assetsDir
    this.timelineStore = timelineStore
    this.eventHub = eventHub
    this.getRuntime = getRuntime
    this.getActiveTurnId = getActiveTurnId
    this.onSynced = onSynced
    this.confirmRetryDelays = confirmRetryDelays
    this.syncFreshnessMs = syncFreshnessMs
    this.operations = new Map()
    this.confirmTimers = new Map()
    this.lastSyncAt = new Map()
    this.closed = false
  }

  sync(agent, { confirmTurnId = '', force = false } = {}) {
    const current = this.operations.get(agent.id)
    if (current) {
      if (confirmTurnId) current.checkedTurnIds.add(confirmTurnId)
      if (confirmTurnId) current.rerun = true
      return current.promise
    }
    if (!force && !confirmTurnId && Date.now() - (this.lastSyncAt.get(agent.id) || 0) < this.syncFreshnessMs) {
      return Promise.resolve(this.publishSynced(agent.id, agent.taskId, { status: 'current' }))
    }
    const operation = {
      rerun: false,
      checkedTurnIds: new Set(confirmTurnId ? [confirmTurnId] : []),
      promise: null,
    }
    operation.promise = this.run(agent, operation).then((result) => {
      this.lastSyncAt.set(agent.id, Date.now())
      return result
    }).finally(() => {
      if (this.operations.get(agent.id) === operation) this.operations.delete(agent.id)
    })
    this.operations.set(agent.id, operation)
    return operation.promise
  }

  confirm(agent, turnId) {
    if (this.closed) return
    const key = `${agent.id}:${turnId}`
    const previous = this.confirmTimers.get(key)
    if (previous) clearTimeout(previous)
    this.confirmTimers.delete(key)
    void this.runConfirmation(agent, turnId, key, 0)
  }

  async runConfirmation(agent, turnId, key, attempt) {
    let result
    try {
      result = await this.sync(agent, { confirmTurnId: turnId })
    } catch (error) {
      result = { status: 'error', error: error.message }
    }
    if (this.closed) return
    const turn = this.repository.getTurn?.(turnId)
    if (!turn || turn.historyState === 'confirmed') {
      this.confirmTimers.delete(key)
      return
    }
    if (result?.status === 'unsupported' || attempt >= this.confirmRetryDelays.length) {
      const historyState = result?.status === 'unavailable' || result?.status === 'unsupported' ? 'unavailable' : 'pending'
      const updated = this.repository.updateTurnHistoryState?.(turnId, historyState)
      this.eventHub.publish(agent.id, {
        type: 'timeline-sync-warning',
        sync: { status: result?.status || 'error', turn: updated || turn, error: result?.error || '' },
      })
      this.confirmTimers.delete(key)
      return
    }
    const timer = setTimeout(() => {
      this.confirmTimers.delete(key)
      void this.runConfirmation(agent, turnId, key, attempt + 1)
    }, this.confirmRetryDelays[attempt])
    timer.unref?.()
    this.confirmTimers.set(key, timer)
  }

  async shutdown() {
    this.closed = true
    for (const timer of this.confirmTimers.values()) clearTimeout(timer)
    this.confirmTimers.clear()
    this.lastSyncAt.clear()
    await Promise.allSettled([...this.operations.values()].map((operation) => operation.promise))
  }

  async run(agent, operation) {
    let result
    do {
      operation.rerun = false
      try {
        result = await this.runOnce(agent, operation)
      } catch (error) {
        if (error.code !== 'TIMELINE_SYNC_STALE') throw error
        operation.rerun = true
      }
    } while (operation.rerun)
    return result
  }

  publishSynced(agentId, taskId, result = {}, { includeTimeline = false } = {}) {
    const state = this.repository.getTimelineState(taskId)
    const sync = {
      status: 'synced',
      changed: false,
      ...result,
      epoch: state?.epoch || '',
      revision: state ? `${state.epoch}:${Math.max(0, state.nextSeq - 1)}` : '',
      turns: this.repository.listTurns(taskId, 1000),
      ...(includeTimeline ? { timeline: this.timelineStore.fetch(taskId, { direction: 'tail', limit: 300 }) } : {}),
    }
    this.eventHub.publish(agentId, { type: 'timeline-synced', sync })
    this.onSynced(agentId)
    return sync
  }

  mergeBackgroundTasks(agent, runtime, tasks = [], toolOwners = []) {
    if (!tasks.length && !toolOwners.length) return
    const savedTasks = this.repository.getAgent?.(agent.id)?.backgroundTasks || []
    const turns = this.repository.listTurns(agent.taskId, 10000)
    const rows = this.repository.listTimelineRows(agent.taskId)
    const ownership = new Map(toolOwners.map(owner => [owner.callId, owner]))
    const incoming = new Map(tasks.map(task => [task.id, { ...task, ...ownership.get(task.callId) }]))
    for (const saved of savedTasks) {
      if (!incoming.has(saved.id) && ownership.has(saved.callId)) incoming.set(saved.id, { ...saved, ...ownership.get(saved.callId) })
    }
    for (const task of incoming.values()) {
      const saved = savedTasks.find(item => item.id === task.id)
      const live = runtime.backgroundTasks?.tasks.get(task.id)
      const call = rows.find(row => row.turnId && row.item.type === 'tool_call' && (
        (task.callId && row.item.callId === task.callId)
        || row.item.detail?.agentThreadId === task.id
        || row.item.detail?.receiverThreadIds?.includes(task.id)
      ))
      const source = turns.find(turn => task.originSourceTurnId && [turn.providerPromptId, turn.nativeTurnId].includes(task.originSourceTurnId))
      const originTurnId = call?.turnId || source?.id || saved?.originTurnId || null
      const parent = { ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}), ...(task.parentCallId ? { parentCallId: task.parentCallId } : {}) }
      if (live) {
        if (originTurnId !== saved?.originTurnId || Object.keys(parent).length) this.repository.upsertProviderTask?.(agent.id, { id: task.id, originTurnId, ...parent })
        continue
      }
      const patch = { ...task, originTurnId }
      if (!task.summary?.trim() && saved?.summary) delete patch.summary
      if (saved && ['completed', 'failed', 'canceled'].includes(saved.status)
        && ['interrupted', 'running', 'pending'].includes(task.status)) patch.status = saved.status
      this.repository.upsertProviderTask?.(agent.id, patch)
    }
    const merged = this.repository.getAgent?.(agent.id)?.backgroundTasks || []
    const callTurns = new Map(rows.filter(row => row.item.type === 'tool_call' && row.turnId).map(row => [row.item.callId, row.turnId]))
    for (const task of resolveBackgroundTaskOwnership(merged, callTurns)) {
      const previous = merged.find(item => item.id === task.id)
      if (task.originTurnId !== previous.originTurnId || task.parentTaskId !== previous.parentTaskId) this.repository.upsertProviderTask?.(agent.id, { id: task.id, originTurnId: task.originTurnId, ...(task.parentTaskId ? { parentTaskId: task.parentTaskId } : {}) })
    }
    this.eventHub.publish(agent.id, { type: 'agent', agent: this.repository.getAgent?.(agent.id) })
  }

  async runOnce(agent, operation) {
    if (this.getActiveTurnId?.(agent.id)) return this.publishSynced(agent.id, agent.taskId, { status: 'running' })
    const beforeState = this.repository.getTimelineState(agent.taskId)
    const syncState = this.repository.getTimelineSyncState(agent.taskId)
    const runtime = this.getRuntime(agent)
    // 新建但尚未发送消息的会话没有 Provider 历史，不代表不支持同步。
    const hasNativeSource = Boolean(agent.nativeHandle?.threadId || agent.nativeHandle?.sessionId || runtime.threadId || runtime.sessionId)
    if (!hasNativeSource && !syncState && beforeState?.nextSeq === 1
      && !operation.checkedTurnIds.size && !this.repository.listTurns(agent.taskId, 1).length) {
      return this.publishSynced(agent.id, agent.taskId)
    }
    if (typeof runtime.readHistorySnapshot !== 'function') {
      return this.publishSynced(agent.id, agent.taskId, { status: 'unsupported' })
    }
    const forceRead = operation.checkedTurnIds.size > 0
      && [...operation.checkedTurnIds].some((id) => this.repository.getTurn?.(id)?.historyState !== 'confirmed')
    const knownRevision = !forceRead && syncState?.manifest?.reconcilerVersion === HISTORY_RECONCILER_VERSION
      ? syncState.manifest.revision || ''
      : ''
    const cursor = syncState?.manifest?.reconcilerVersion === HISTORY_RECONCILER_VERSION
      ? Number(syncState.manifest.cursor) || 0
      : 0
    const rawSnapshot = await runtime.readHistorySnapshot({ knownRevision, cursor })
    const snapshot = rawSnapshot?.status ? rawSnapshot : assertHistorySnapshot(rawSnapshot)
    if (!snapshot || snapshot.status === 'unsupported') {
      return this.publishSynced(agent.id, agent.taskId, { status: 'unsupported' })
    }
    if (snapshot.status === 'unavailable') {
      return this.publishSynced(agent.id, agent.taskId, { status: 'unavailable' })
    }
    if (snapshot.status === 'unchanged') {
      if (snapshot.sourceId && [agent.nativeHandle?.sessionId, runtime.sessionId].includes(snapshot.sourceId)) {
        this.mergeBackgroundTasks(agent, runtime, snapshot.backgroundTasks, snapshot.backgroundToolOwners)
      }
      return this.publishSynced(agent.id, agent.taskId, { syncedAt: syncState?.syncedAt })
    }
    const expectedSourceIds = new Set([
      ...Object.values(agent.nativeHandle || {}).filter((value) => typeof value === 'string'),
      runtime.threadId,
      runtime.sessionId,
    ].filter(Boolean))
    if (expectedSourceIds.size && !expectedSourceIds.has(snapshot.sourceId)) {
      const error = new Error('Provider 历史来源与当前 Agent 不一致。')
      error.code = 'HISTORY_SOURCE_CONFLICT'
      throw error
    }

    if (agent.providerId === 'codex') {
      await materializeHistoryImages(snapshot, { taskId: agent.taskId, assetsDir: this.assetsDir, repository: this.repository })
    }
    const checkedTurnIds = [...operation.checkedTurnIds]
    const plan = reconcileHistory({
      snapshot,
      getAsset: id => this.repository.getAsset(id),
      localRows: this.repository.listTimelineRows(agent.taskId),
      localTurns: this.repository.listTurns(agent.taskId, 10000),
      syncState,
      checkedTurnIds,
    })
    if (plan.mode === 'noop') {
      this.mergeBackgroundTasks(agent, runtime, snapshot.backgroundTasks, snapshot.backgroundToolOwners)
      return this.publishSynced(agent.id, agent.taskId, { syncedAt: syncState?.syncedAt })
    }
    const applied = this.repository.applyTimelineSync(agent.taskId, {
      ...plan,
      providerId: agent.providerId,
      sourceId: snapshot.sourceId,
      expectedNextSeq: beforeState.nextSeq,
    })
    this.mergeBackgroundTasks(agent, runtime, snapshot.backgroundTasks, snapshot.backgroundToolOwners)
    const timelineChanged = applied.mode === 'rebuild' || applied.rows.length > 0 || applied.updatedRows > 0
    if (applied.mode === 'rebuild' || applied.updatedRows > 0) {
      this.eventHub.publish(agent.id, {
        type: 'reset',
        timeline: this.timelineStore.fetch(agent.taskId, { direction: 'tail', limit: 300 }),
      })
    } else {
      for (const row of applied.rows) {
        this.eventHub.publish(agent.id, { type: 'timeline', epoch: applied.epoch, row })
      }
    }
    return this.publishSynced(agent.id, agent.taskId, {
      changed: plan.changed || timelineChanged || applied.updatedTurns > 0,
      mode: applied.mode,
      syncedAt: applied.syncedAt,
      confirmedTurnIds: plan.confirmedTurnIds,
    }, { includeTimeline: timelineChanged })
  }
}
