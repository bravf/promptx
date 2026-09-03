import { transportFetch } from './transport.js'

function parseEventBlock(block) {
  let type = 'message'
  let id = ''
  const data = []
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue
    const separator = line.indexOf(':')
    const field = separator >= 0 ? line.slice(0, separator) : line
    const value = separator >= 0 ? line.slice(separator + 1).replace(/^ /, '') : ''
    if (field === 'event') type = value || 'message'
    else if (field === 'id') id = value
    else if (field === 'data') data.push(value)
  }
  return data.length ? { type, id, data: data.join('\n') } : null
}

export class PromptxEventSource {
  constructor(path, options = {}) {
    this.path = path
    this.retryMs = options.retryMs || 1_000
    this.listeners = new Map()
    this.closed = false
    this.lastEventId = ''
    this.controller = null
    this.onmessage = null
    this.onerror = null
    this.run()
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type, listener) {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(event) {
    if (event.type === 'message') this.onmessage?.(event)
    for (const listener of this.listeners.get(event.type) || []) listener(event)
  }

  requestPath() {
    if (!this.lastEventId) return this.path
    const url = new URL(this.path, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    url.searchParams.set('cursor', this.lastEventId)
    return `${url.pathname}${url.search}`
  }

  async run() {
    while (!this.closed) {
      this.controller = new AbortController()
      try {
        const response = await transportFetch(this.requestPath(), {
          headers: {
            Accept: 'text/event-stream',
            ...(this.lastEventId ? { 'Last-Event-ID': this.lastEventId } : {}),
          },
          cache: 'no-store',
          signal: this.controller.signal,
        })
        if (!response.ok || !response.body) throw new Error(`事件流连接失败（${response.status}）`)
        const reader = response.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        while (!this.closed) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const parsed = parseEventBlock(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            if (parsed) {
              if (parsed.id) this.lastEventId = parsed.id
              this.dispatch({ type: parsed.type, data: parsed.data, lastEventId: parsed.id || this.lastEventId })
            }
            boundary = buffer.indexOf('\n\n')
          }
        }
      } catch (error) {
        if (!this.closed && error.name !== 'AbortError') this.onerror?.(error)
      } finally {
        this.controller = null
      }
      if (!this.closed) await new Promise((resolve) => setTimeout(resolve, this.retryMs))
    }
  }

  close() {
    this.closed = true
    this.controller?.abort()
    this.controller = null
  }
}

export function createEventSource(path, options) {
  return new PromptxEventSource(path, options)
}

export { parseEventBlock }
