import { reconcileHistory } from './historyReconciler.js'
import { HISTORY_RECONCILER_VERSION } from './historySnapshot.js'

export class TimelineSyncCoordinator {
  constructor({
    repository,
    timelineStore,
    eventHub,
    getRuntime,
    getActiveTurnId,
    now = () => Date.now(),
    preserveTurnMs = 5_000,
  }) {
    this.repository = repository
    this.timelineStore = timelineStore
    this.eventHub = eventHub
    this.getRuntime = getRuntime
    this.getActiveTurnId = getActiveTurnId
    this.now = now
    this.preserveTurnMs = preserveTurnMs
    this.operations = new Map()
    this.preservedTurns = new Map()
  }

  sync(agent, { preserveTurnId = '' } = {}) {
    if (preserveTurnId) {
      const turns = this.preservedTurns.get(agent.id) || new Map()
      turns.set(preserveTurnId, this.now() + this.preserveTurnMs)
      this.preservedTurns.set(agent.id, turns)
    }
    const current = this.operations.get(agent.id)
    if (current) {
      if (preserveTurnId) current.preserveTurnIds.add(preserveTurnId)
      current.rerun = true
      return current.promise
    }
    const operation = {
      rerun: false,
      preserveTurnIds: new Set(preserveTurnId ? [preserveTurnId] : []),
      promise: null,
    }
    operation.promise = this.run(agent, operation).finally(() => {
      if (this.operations.get(agent.id) === operation) this.operations.delete(agent.id)
    })
    this.operations.set(agent.id, operation)
    return operation.promise
  }

  protectedTurnIds(agentId) {
    const turns = this.preservedTurns.get(agentId)
    if (!turns) return []
    const now = this.now()
    for (const [turnId, expiresAt] of turns) {
      if (expiresAt <= now) turns.delete(turnId)
    }
    if (!turns.size) this.preservedTurns.delete(agentId)
    return [...turns.keys()]
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

  publishSynced(agentId, taskId, result = {}) {
    const sync = {
      status: 'synced',
      changed: false,
      ...result,
      turns: this.repository.listTurns(taskId, 1000),
    }
    this.eventHub.publish(agentId, { type: 'timeline-synced', sync })
    return sync
  }

  async runOnce(agent, operation) {
    const beforeState = this.repository.getTimelineState(agent.taskId)
    const syncState = this.repository.getTimelineSyncState(agent.taskId)
    const runtime = this.getRuntime(agent)
    if (typeof runtime.readHistorySnapshot !== 'function') {
      return { status: 'unsupported', changed: false }
    }
    const knownRevision = syncState?.manifest?.reconcilerVersion === HISTORY_RECONCILER_VERSION
      ? syncState.manifest.revision || ''
      : ''
    const snapshot = await runtime.readHistorySnapshot({ knownRevision })
    if (!snapshot || snapshot.status === 'unsupported') return { status: 'unsupported', changed: false }
    if (snapshot.status === 'unavailable') return { status: 'unavailable', changed: false }
    if (snapshot.status === 'unchanged') {
      return this.publishSynced(agent.id, agent.taskId, { syncedAt: syncState?.syncedAt })
    }
    const expectedSourceIds = new Set([
      ...Object.values(agent.nativeHandle || {}).filter((value) => typeof value === 'string'),
      runtime.threadId,
      runtime.sessionId,
    ].filter(Boolean))
    if (expectedSourceIds.size && !expectedSourceIds.has(snapshot.sourceId)) {
      throw new Error('Provider 历史来源与当前 Agent 不一致。')
    }

    const plan = reconcileHistory({
      snapshot,
      localRows: this.repository.listTimelineRows(agent.taskId),
      localTurns: this.repository.listTurns(agent.taskId, 10000),
      syncState,
      activeTurnId: this.getActiveTurnId(agent.id),
      preserveTurnIds: [...new Set([...operation.preserveTurnIds, ...this.protectedTurnIds(agent.id)])],
    })
    if (plan.mode === 'noop') {
      return this.publishSynced(agent.id, agent.taskId, { syncedAt: syncState?.syncedAt })
    }

    const applied = this.repository.applyTimelineSync(agent.taskId, {
      ...plan,
      providerId: agent.providerId,
      sourceId: snapshot.sourceId,
      expectedNextSeq: beforeState.nextSeq,
    })
    if (applied.mode === 'replace') {
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
      changed: plan.changed,
      mode: applied.mode,
      syncedAt: applied.syncedAt,
    })
  }
}
