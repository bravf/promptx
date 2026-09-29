export class TimelineCoalescer {
  constructor(onFlush, windowMs = 60, onError = console.error) {
    this.onFlush = onFlush
    this.onError = onError
    this.windowMs = windowMs
    this.buffers = new Map()
  }

  push(agentId, payload) {
    const item = payload.item
    const key = item.type === 'tool_call'
      ? `tool:${payload.turnId || ''}:${item.callId}`
      : ['assistant_message', 'reasoning'].includes(item.type)
        ? `text:${payload.turnId || ''}:${item.type}:${item.messageId || ''}:${item.phase || ''}`
        : ''
    if (!key) {
      this.flush(agentId)
      this.onFlush(payload)
      return
    }
    let buffer = this.buffers.get(agentId)
    if (!buffer) {
      buffer = { entries: [], lastKey: null, timer: null }
      this.buffers.set(agentId, buffer)
    }
    // 只合并相邻事件，避免把工具后的文本移动到工具之前。
    const index = buffer.lastKey === key ? buffer.entries.length - 1 : undefined
    buffer.lastKey = key
    if (index !== undefined && item.type === 'tool_call') {
      const previous = buffer.entries[index]
      const detail = { ...previous.item.detail, ...item.detail }
      if (item.detail?.outputDelta !== undefined) detail.outputDelta = `${previous.item.detail?.outputDelta || ''}${item.detail.outputDelta}`
      else if (item.detail?.aggregatedOutput !== undefined) delete detail.outputDelta
      buffer.entries[index] = { ...payload, item: { ...previous.item, ...item, detail } }
    } else if (index !== undefined) {
      const previous = buffer.entries[index]
      previous.item = { ...previous.item, text: `${previous.item.text}${item.text}` }
    } else {
      buffer.entries.push({ ...payload, item: { ...item } })
    }
    if (item.type === 'tool_call' && ['completed', 'failed', 'canceled'].includes(item.status)) {
      this.flush(agentId)
      return
    }
    if (!buffer.timer) {
      buffer.timer = setTimeout(() => {
        buffer.timer = null
        try { this.flush(agentId) } catch (error) { this.onError(error, agentId) }
      }, this.windowMs)
      buffer.timer.unref?.()
    }
  }

  flush(agentId) {
    const buffer = this.buffers.get(agentId)
    if (!buffer) return
    if (buffer.timer) clearTimeout(buffer.timer)
    buffer.timer = null
    while (buffer.entries.length) {
      this.onFlush(buffer.entries[0])
      buffer.entries.shift()
    }
    this.buffers.delete(agentId)
  }

  flushAll() {
    for (const agentId of this.buffers.keys()) this.flush(agentId)
  }
}
