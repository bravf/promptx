export class EventHub {
  constructor() {
    this.listeners = new Map()
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

  publish(agentId, event) {
    for (const listener of this.listeners.get(agentId) || []) listener(event)
  }
}
