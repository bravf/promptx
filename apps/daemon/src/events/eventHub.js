export class EventHub {
  constructor() {
    this.listeners = new Map()
    this.globalListeners = new Set()
  }

  subscribe(agentId, listener) {
    const listeners = this.listeners.get(agentId) || new Set()
    listeners.add(listener)
    this.listeners.set(agentId, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.listeners.delete(agentId)
    }
  }

  subscribeAll(listener) {
    this.globalListeners.add(listener)
    return () => this.globalListeners.delete(listener)
  }

  publish(agentId, event) {
    for (const listener of this.listeners.get(agentId) || []) listener(event)
    for (const listener of this.globalListeners) listener(event)
  }
}
