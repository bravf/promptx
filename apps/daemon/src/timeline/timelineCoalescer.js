export class TimelineCoalescer {
  constructor(onFlush, windowMs = 60) {
    this.onFlush = onFlush
    this.windowMs = windowMs
    this.buffers = new Map()
  }

  push(agentId, payload) {
    const item = payload.item
    const key = item.type === 'tool_call'
      ? `tool:${payload.turnId || ''}:${item.callId}`
      : ['assistant_message', 'reasoning'].includes(item.type)
        ? `text:${payload.turnId || ''}:${item.type}:${item.messageId || ''}`
        : ''
    if (!key) {
      this.flush(agentId)
      this.onFlush(payload)
      return
    }
    let buffer = this.buffers.get(agentId)
    if (!buffer) {
      buffer = { entries: [], indexes: new Map(), timer: null }
      this.buffers.set(agentId, buffer)
    }
    const index = buffer.indexes.get(key)
    if (index !== undefined && item.type === 'tool_call') {
      buffer.entries[index] = payload
    } else if (index !== undefined) {
      const previous = buffer.entries[index]
      previous.item = { ...previous.item, text: `${previous.item.text}${item.text}` }
    } else {
      buffer.indexes.set(key, buffer.entries.length)
      buffer.entries.push({ ...payload, item: { ...item } })
    }
    if (item.type === 'tool_call' && ['completed', 'failed', 'canceled'].includes(item.status)) {
      this.flush(agentId)
      return
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => this.flush(agentId), this.windowMs)
      buffer.timer.unref?.()
    }
  }

  flush(agentId) {
    const buffer = this.buffers.get(agentId)
    if (!buffer) return
    if (buffer.timer) clearTimeout(buffer.timer)
    this.buffers.delete(agentId)
    buffer.entries.forEach(this.onFlush)
  }

  flushAll() {
    for (const agentId of this.buffers.keys()) this.flush(agentId)
  }
}
