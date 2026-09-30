// 会话与媒体使用独立的加密连接，避免媒体发送队列阻塞会话事件。
export function createRelayTransportPool({ getOffer, createConnection, idleMs = 30_000 }) {
  let offer = null, control = null, media = null

  function closeMedia(state) {
    if (!state) return
    state.closed = true
    clearTimeout(state.timer)
    state.connection.close()
    if (media === state) media = null
  }

  function clear() {
    control?.close()
    closeMedia(media)
    control = null
  }

  function getControl() {
    const next = getOffer()
    if (next !== offer) { clear(); offer = next }
    if (!offer) return null
    return control ||= createConnection(offer)
  }

  async function request(path, options = {}) {
    const connection = getControl()
    if (!connection) return null
    if (!/\/(?:file\/content|local-image\/content|assets\/[^/]+\/content)(?:\?|$)/.test(path)) return connection.request(path, options)
    if (!media) {
      const connection = createConnection(offer)
      connection.shouldReconnect = false
      media = { connection, active: 0, timer: null, closed: false }
    }
    const current = media
    clearTimeout(current.timer)
    current.active += 1
    let finished = false
    let reader = null
    let bodyController = null
    const finish = () => {
      if (finished) return
      finished = true
      options.signal?.removeEventListener('abort', abort)
      current.active -= 1
      if (current.active || current.closed) return
      current.timer = setTimeout(() => closeMedia(current), idleMs)
      current.timer.unref?.()
    }
    const abort = () => {
      const reason = options.signal.reason || new DOMException('请求已取消', 'AbortError')
      bodyController?.error(reason)
      void reader?.cancel(reason).catch(() => {})
      finish()
    }
    options.signal?.addEventListener('abort', abort, { once: true })
    try {
      const response = await current.connection.request(path, options)
      if (options.signal?.aborted) {
        await response.body?.cancel(options.signal.reason)
        throw options.signal.reason || new DOMException('请求已取消', 'AbortError')
      }
      if (!response.body) { finish(); return response }
      reader = response.body.getReader()
      const body = new ReadableStream({
        start(controller) { bodyController = controller },
        async pull(controller) {
          try {
            const { value, done } = await reader.read()
            if (done) { controller.close(); finish() }
            else controller.enqueue(value)
          } catch (error) { controller.error(error); finish() }
        },
        async cancel(reason) {
          try { await reader.cancel(reason) } finally { finish() }
        },
      })
      return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers })
    } catch (error) { finish(); throw error }
  }

  return { getControl, request, close: clear }
}
