import { createEventSource } from './eventSource.js'
import { getApiBase } from './request.js'

export function createTaskEventPool({ connect = createEventSource, url = () => `${getApiBase()}/api/v2/task-events` } = {}) {
  const subscriptions = new Map()
  let stream = null, scheduled = false, sequence = 0

  function reconnect() {
    if (scheduled) return
    scheduled = true
    queueMicrotask(() => {
      scheduled = false
      stream?.close()
      stream = null
      if (!subscriptions.size) return
      const next = connect(url(), {
        requestOptions: () => ({
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscriptions: [...subscriptions.values()].map(({ id, taskId, cursor, snapshot, turnsRevision, controlRevision }) => ({ id, taskId, cursor, snapshot, turnsRevision, controlRevision })) }),
        }),
      })
      stream = next
      next.addEventListener('task-event', message => {
        if (stream !== next) return
        const { subscriptionId, event } = JSON.parse(message.data)
        const subscription = subscriptions.get(subscriptionId)
        if (!subscription) return
        if (event.type === 'timeline') subscription.cursor = `${event.epoch}:${event.row.seq}`
        if (event.type === 'turn') subscription.turnsRevision = ''
        if (event.sync?.turnsRevision) subscription.turnsRevision = event.sync.turnsRevision
        if (event.type === 'control') subscription.controlRevision = event.revision || ''
        const timeline = event.type === 'reset' ? event.timeline : event.sync?.timeline
        if (timeline) subscription.cursor = `${timeline.epoch}:${timeline.rows.at(-1)?.seq || 0}`
        const notification = { type: event.type, data: JSON.stringify(event), lastEventId: subscription.cursor }
        for (const listener of subscription.listeners.get(event.type) || []) listener(notification)
      })
    })
  }

  return function subscribe(taskId, cursor = '', { snapshot = true, turnsRevision = '', controlRevision = '' } = {}) {
    const id = String(++sequence)
    const listeners = new Map()
    subscriptions.set(id, { id, taskId, cursor, snapshot, turnsRevision, controlRevision, listeners })
    reconnect()
    return {
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, new Set())
        listeners.get(type).add(listener)
      },
      close() {
        if (!subscriptions.delete(id)) return
        listeners.clear()
        reconnect()
      },
    }
  }
}

export const createTaskEventSource = createTaskEventPool()
