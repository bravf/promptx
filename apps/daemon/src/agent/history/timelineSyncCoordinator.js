import { reconcileHistory } from './historyReconciler.js'

export class TimelineSyncCoordinator {
  constructor({ repository, timelineStore, eventHub, getRuntime, getActiveTurnId }) {
    this.repository = repository
    this.timelineStore = timelineStore
    this.eventHub = eventHub
    this.getRuntime = getRuntime
    this.getActiveTurnId = getActiveTurnId
    this.operations = new Map()
  }

  sync(agent) {
    const current = this.operations.get(agent.id)
    if (current) {
      current.rerun = true
      return current.promise
    }
    const operation = { rerun: false, promise: null }
    operation.promise = this.run(agent, operation).finally(() => {
      if (this.operations.get(agent.id) === operation) this.operations.delete(agent.id)
    })
    this.operations.set(agent.id, operation)
    return operation.promise
  }

  async run(agent, operation) {
    let result
    do {
      operation.rerun = false
      try {
        result = await this.runOnce(agent)
      } catch (error) {
        if (error.code !== 'TIMELINE_SYNC_STALE') throw error
        operation.rerun = true
      }
    } while (operation.rerun)
    return result
  }

  async runOnce(agent) {
    const beforeState = this.repository.getTimelineState(agent.id)
    const syncState = this.repository.getTimelineSyncState(agent.id)
    const runtime = this.getRuntime(agent)
    if (typeof runtime.readHistorySnapshot !== 'function') {
      return { status: 'unsupported', changed: false }
    }
    const snapshot = await runtime.readHistorySnapshot({ knownRevision: syncState?.manifest?.revision || '' })
    if (!snapshot || snapshot.status === 'unsupported') return { status: 'unsupported', changed: false }
    if (snapshot.status === 'unavailable') return { status: 'unavailable', changed: false }
    if (snapshot.status === 'unchanged') return { status: 'synced', changed: false }
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
      localRows: this.repository.listTimelineRows(agent.id),
      localTurns: this.repository.listTurns(agent.id, 10000),
      syncState,
      activeTurnId: this.getActiveTurnId(agent.id),
    })
    if (plan.mode === 'noop') return { status: 'synced', changed: false }

    const applied = this.repository.applyTimelineSync(agent.id, {
      ...plan,
      providerId: agent.providerId,
      sourceId: snapshot.sourceId,
      expectedNextSeq: beforeState.nextSeq,
    })
    if (applied.mode === 'replace') {
      this.eventHub.publish(agent.id, {
        type: 'reset',
        timeline: this.timelineStore.fetch(agent.id, { direction: 'tail', limit: 300 }),
      })
    } else {
      for (const row of applied.rows) {
        this.eventHub.publish(agent.id, { type: 'timeline', epoch: applied.epoch, row })
      }
    }
    const turns = this.repository.listTurns(agent.id, 1000)
    const result = { status: 'synced', changed: plan.changed, mode: applied.mode, syncedAt: applied.syncedAt, turns }
    this.eventHub.publish(agent.id, { type: 'timeline-synced', sync: result })
    return result
  }
}
