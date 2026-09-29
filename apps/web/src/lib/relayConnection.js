import {
  SessionCipher, deriveSessionKeys, sessionTranscript, randomToken,
  buildRelayWebSocketUrl,
  decodeBase64,
  deriveSharedKey,
  encodeBase64,
  generateKeyPair,
  importPublicKey,
  parseJsonFrame,
  splitBytes,
} from '@promptx/relay'

function createRequestId() {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `req_${value.replaceAll('-', '')}`
}

const E2EE_HANDSHAKE_TIMEOUT_MS = 15_000
const REQUEST_IDLE_TIMEOUT_MS = 30_000

async function serializeBody(body, headers) {
  if (body == null) return new Uint8Array()
  if (body instanceof FormData) {
    const encoded = new Response(body)
    if (!headers.has('content-type')) headers.set('content-type', encoded.headers.get('content-type'))
    return new Uint8Array(await encoded.arrayBuffer())
  }
  if (typeof body === 'string') return new TextEncoder().encode(body)
  if (body instanceof URLSearchParams) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8')
    return new TextEncoder().encode(body.toString())
  }
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer())
  if (body instanceof ArrayBuffer) return new Uint8Array(body)
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('远程请求暂不支持这种 Body 类型。')
}

function headersToObject(headers) {
  return Object.fromEntries([...headers.entries()].filter(([name]) => !['cookie', 'authorization', 'host'].includes(name.toLowerCase())))
}

export class EncryptedRelayConnection {
  constructor(offer, options = {}) {
    this.offer = offer
    this.WebSocketClass = options.WebSocketClass || globalThis.WebSocket
    this.DecompressionStreamClass = Object.hasOwn(options, 'DecompressionStreamClass')
      ? options.DecompressionStreamClass
      : globalThis.DecompressionStream
    this.requestIdleTimeoutMs = Number(options.requestIdleTimeoutMs) || REQUEST_IDLE_TIMEOUT_MS
    this.socket = null
    this.sharedKey = null
    this.cipher = null
    this.pending = new Map()
    this.connectPromise = null
    this.reconnectTimer = null
    this.reconnectAttempt = 0
    this.shouldReconnect = true
    this.listeners = new Set()
    this.status = { state: 'disconnected', error: '', connectedAt: '' }
  }

  snapshot() {
    return { ...this.status, pendingRequestCount: this.pending.size }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  updateStatus(patch) {
    Object.assign(this.status, patch)
    for (const listener of this.listeners) listener(this.snapshot())
  }

  async connect() {
    if (this.status.state === 'ready' && this.socket?.readyState === this.WebSocketClass.OPEN) return
    if (this.connectPromise) return this.connectPromise
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.sharedKey = null
    this.cipher = null
    this.updateStatus({ state: this.reconnectAttempt ? 'reconnecting' : 'connecting', error: '' })
    const connection = new Promise((resolve, reject) => {
      let handshakeSettled = false
      const keyPair = generateKeyPair()
      const hello = { type: 'e2ee.hello', v: 3, clientPublicKeyB64: keyPair.publicKeyB64, clientNonce: randomToken(), acceptBodyEncodings: this.DecompressionStreamClass ? ['gzip'] : [] }
      const sharedKey = deriveSharedKey(keyPair.secretKey, importPublicKey(this.offer.daemonPublicKeyB64))
      const url = buildRelayWebSocketUrl(this.offer.relay.url, {
        role: 'client',
        serverId: this.offer.serverId,
      })
      const socket = new this.WebSocketClass(url)
      const handshakeTimer = setTimeout(() => {
        failHandshake(new Error('等待本机 PromptX 响应超时。'))
        socket.close(4008, 'e2ee_handshake_timeout')
      }, E2EE_HANDSHAKE_TIMEOUT_MS)
      this.socket = socket
      socket.binaryType = 'arraybuffer'
      const failHandshake = (error) => {
        if (handshakeSettled) return
        handshakeSettled = true
        clearTimeout(handshakeTimer)
        reject(error)
      }
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return
        socket.send(JSON.stringify(hello))
      })
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return
        if (this.status.state !== 'ready') {
          try {
            if (!this.cipher) {
              const frame = typeof event.data === 'string' ? parseJsonFrame(event.data) : null
              if (frame?.type !== 'e2ee.challenge' || frame.v !== 3) throw new Error('远程协议已升级，请重新配对。')
              const keys = deriveSessionKeys(sharedKey, this.offer.pairingKeyB64, sessionTranscript(this.offer.serverId, hello, frame.challenge))
              this.cipher = new SessionCipher(keys.clientToServer, keys.serverToClient)
              socket.send(this.cipher.encrypt(JSON.stringify({ type: 'e2ee.auth' })))
              return
            }
            const ready = JSON.parse(this.cipher.decrypt(event.data))
            if (ready.type !== 'e2ee.ready' || ready.v !== 3) throw new Error('配对认证失败。')
            handshakeSettled = true
            this.sharedKey = sharedKey
            clearTimeout(handshakeTimer)
            this.reconnectAttempt = 0
            this.updateStatus({ state: 'ready', error: '', connectedAt: new Date().toISOString() })
            resolve()
          } catch (error) {
            failHandshake(error)
            socket.close(4003, 'invalid_pairing')
          }
          return
        }
        this.handleEncryptedMessage(event.data)
      })
      socket.addEventListener('error', () => {
        failHandshake(new Error('无法连接 PromptX Relay。'))
      })
      socket.addEventListener('close', () => {
        clearTimeout(handshakeTimer)
        const error = new Error('PromptX Relay 连接已断开。')
        failHandshake(error)
        if (this.socket !== socket) return
        this.socket = null
        this.sharedKey = null
        this.cipher = null
        this.connectPromise = null
        this.failPending(error)
        this.updateStatus({ state: 'disconnected', error: error.message })
        this.scheduleReconnect()
      })
    }).finally(() => {
      if (this.connectPromise === connection) this.connectPromise = null
    })
    this.connectPromise = connection
    return connection
  }

  scheduleReconnect() {
    if (!this.shouldReconnect || this.reconnectTimer) return
    this.reconnectAttempt += 1
    const wait = Math.min(15_000, 500 * (2 ** Math.min(this.reconnectAttempt - 1, 5)))
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect().catch(() => {})
    }, wait)
  }

  handleEncryptedMessage(payload) {
    try {
      if (typeof payload === 'string') throw new Error('Relay 返回了未加密业务数据。')
      const plaintext = this.cipher.decrypt(payload)
      if (typeof plaintext !== 'string') throw new Error('Relay 响应类型无效。')
      const frame = parseJsonFrame(plaintext)
      if (!frame) throw new Error('Relay 响应格式无效。')
      this.handleResponseFrame(frame)
    } catch (error) {
      this.updateStatus({ error: error.message })
      this.socket?.close(4003, 'invalid_encrypted_frame')
    }
  }

  handleResponseFrame(frame) {
    const record = this.pending.get(String(frame.requestId || ''))
    if (!record) return
    this.touchRecord(record)
    if (frame.type === 'response.start') {
      record.started = true
      const noBody = record.method === 'HEAD' || [204, 205, 304].includes(Number(frame.status))
      const bodyEncoding = String(frame.bodyEncoding || '')
      if (bodyEncoding && bodyEncoding !== 'gzip') {
        record.reject(new Error(`Relay 响应压缩格式不受支持：${bodyEncoding}`))
        this.finishRecord(record)
        return
      }
      if (bodyEncoding === 'gzip' && !this.DecompressionStreamClass) {
        record.reject(new Error('当前浏览器不支持 Relay 压缩响应。'))
        this.finishRecord(record)
        return
      }
      const body = bodyEncoding === 'gzip'
        ? record.stream.pipeThrough(new this.DecompressionStreamClass('gzip'))
        : record.stream
      const contentType = String(frame.headers?.['content-type'] || '')
      if (contentType.includes('text/event-stream')) {
        record.streaming = true
        clearTimeout(record.idleTimer)
        record.idleTimer = null
      }
      record.resolve(new Response(noBody ? null : body, {
        status: Number(frame.status || 500),
        statusText: String(frame.statusText || ''),
        headers: frame.headers || {},
      }))
      return
    }
    if (frame.type === 'response.body') {
      const chunk = new Uint8Array(decodeBase64(frame.chunk))
      if (chunk.byteLength > record.controller.desiredSize) {
        record.controller.error(new Error('远程响应消费过慢，已停止传输。'))
        this.sendFrame({ type: 'request.cancel', requestId: record.requestId })
        this.finishRecord(record)
        return
      }
      record.controller.enqueue(chunk)
      return
    }
    if (frame.type === 'response.end') {
      record.controller.close()
      this.finishRecord(record)
      return
    }
    if (frame.type === 'response.error') {
      const error = new Error(frame.message || '远程 PromptX 请求失败。')
      if (record.started) record.controller.error(error)
      else record.reject(error)
      this.finishRecord(record)
    }
  }

  finishRecord(record) {
    clearTimeout(record.idleTimer)
    record.signal?.removeEventListener('abort', record.abort)
    this.pending.delete(record.requestId)
  }

  touchRecord(record) {
    if (record.streaming) return
    clearTimeout(record.idleTimer)
    record.idleTimer = setTimeout(() => {
      if (!this.pending.has(record.requestId)) return
      try { this.sendFrame({ type: 'request.cancel', requestId: record.requestId }) } catch {}
      const error = new DOMException('等待本机 PromptX 响应超时。', 'TimeoutError')
      if (record.started) record.controller.error(error)
      else record.reject(error)
      this.finishRecord(record)
    }, this.requestIdleTimeoutMs)
  }

  failPending(error) {
    for (const record of this.pending.values()) {
      if (record.started) record.controller.error(error)
      else record.reject(error)
      clearTimeout(record.idleTimer)
      record.signal?.removeEventListener('abort', record.abort)
    }
    this.pending.clear()
  }

  sendFrame(frame) {
    if (!this.sharedKey || this.socket?.readyState !== this.WebSocketClass.OPEN) throw new Error('PromptX Relay 尚未连接。')
    this.socket.send(this.cipher.encrypt(JSON.stringify(frame)))
  }

  async request(path, options = {}) {
    await this.connect()
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const requestId = createRequestId()
    const method = String(options.method || 'GET').toUpperCase()
    const headers = new Headers(options.headers || {})
    if (this.pending.size >= 64) throw new Error('远程并发请求过多，请稍后重试。')
    const body = await serializeBody(options.body, headers)
    if (body.byteLength > 64 * 1024 * 1024) throw new Error('请求超过 64 MB 限制。')
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    let controller
    const stream = new ReadableStream({
      start(value) { controller = value },
      cancel: () => {
        const record = this.pending.get(requestId)
        if (!record) return
        try { this.sendFrame({ type: 'request.cancel', requestId }) } catch {}
        this.finishRecord(record)
      },
    }, { highWaterMark: 4 * 1024 * 1024, size: chunk => chunk.byteLength })
    const responsePromise = new Promise((resolve, reject) => {
      const record = {
        requestId,
        method,
        resolve,
        reject,
        stream,
        controller,
        started: false,
        signal: options.signal,
        abort: null,
        idleTimer: null,
        streaming: false,
      }
      record.abort = () => {
        try { this.sendFrame({ type: 'request.cancel', requestId }) } catch {}
        const error = new DOMException('The operation was aborted.', 'AbortError')
        if (record.started) controller.error(error)
        else reject(error)
        this.finishRecord(record)
      }
      options.signal?.addEventListener('abort', record.abort, { once: true })
      this.pending.set(requestId, record)
      this.touchRecord(record)
    })
    // 上传背压等待期间，取消可能先拒绝响应，先注册处理防止未处理 rejection。
    responsePromise.catch(() => {})
    try {
      this.sendFrame({ type: 'request.start', requestId, method, path, headers: headersToObject(headers) })
      for (const chunk of splitBytes(body)) {
        if (!this.pending.has(requestId) || options.signal?.aborted) throw new DOMException('已取消', 'AbortError')
        const started = Date.now()
        while (this.socket?.bufferedAmount > 512 * 1024) {
          if (options.signal?.aborted) throw new DOMException('已取消', 'AbortError')
          if (Date.now() - started > this.requestIdleTimeoutMs) throw new Error('远程发送超时。')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        this.sendFrame({ type: 'request.body', requestId, chunk: encodeBase64(chunk) })
      }
      if (this.pending.has(requestId)) this.sendFrame({ type: 'request.end', requestId })
    } catch (error) {
      const record = this.pending.get(requestId)
      if (record) {
        try { this.sendFrame({ type: 'request.cancel', requestId }) } catch {}
        record.reject(error)
        this.finishRecord(record)
      }
    }
    return responsePromise
  }

  close() {
    this.shouldReconnect = false
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    this.socket?.close(1000, 'client_closed')
    this.socket = null
    this.sharedKey = null
    this.cipher = null
    this.connectPromise = null
    this.failPending(new Error('PromptX Relay 已关闭。'))
  }
}
