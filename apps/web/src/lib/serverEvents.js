import { getApiBase } from './request.js'

const STREAM_URL = `${getApiBase()}/api/events/stream`
const listeners = new Set()

let eventSource = null
let reconnectTimer = null

function clearReconnectTimer() {
  if (reconnectTimer) {
    window.clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
}

function closeEventSource() {
  if (eventSource) {
    eventSource.close()
    eventSource = null
  }
}

function notifyListeners(payload) {
  listeners.forEach((listener) => {
    try {
      listener(payload)
    } catch {
      // Ignore listener failures to avoid breaking the shared stream.
    }
  })
}

function ensureServerEventStream() {
  if (typeof window === 'undefined' || typeof window.EventSource === 'undefined') {
    return
  }

  if (eventSource || !listeners.size) {
    return
  }

  clearReconnectTimer()
  eventSource = new window.EventSource(STREAM_URL)

  eventSource.onmessage = (event) => {
    try {
      const payload = JSON.parse(String(event.data || '{}'))
      if (!payload?.type) {
        return
      }
      notifyListeners(payload)
    } catch {
      // Ignore malformed server event payloads.
    }
  }

  eventSource.onerror = () => {
    closeEventSource()
    if (!listeners.size) {
      return
    }

    clearReconnectTimer()
    reconnectTimer = window.setTimeout(() => {
      ensureServerEventStream()
    }, 1500)
  }
}

export function subscribeServerEvents(listener) {
  if (typeof listener !== 'function') {
    return () => {}
  }

  listeners.add(listener)
  ensureServerEventStream()

  return () => {
    listeners.delete(listener)
    if (listeners.size) {
      return
    }

    clearReconnectTimer()
    closeEventSource()
  }
}
