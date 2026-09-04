import {
  buildRelayWebSocketUrl,
  decodeBase64,
  decryptPayload,
  deriveSharedKey,
  encodeBase64,
  encryptPayload,
  generateKeyPair,
  importPublicKey,
  NonceReplayWindow,
  parseJsonFrame,
  splitBytes,
} from '@promptx/relay'

function createRequestId() {
  const value = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `req_${value.replaceAll('-', '')}`
}

const E2EE_HANDSHAKE_TIMEOUT_MS = 15_000

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
    this.socket = null
    this.sharedKey = null
    this.seenNonces = new NonceReplayWindow()
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
    this.seenNonces = new NonceReplayWindow()
    this.updateStatus({ state: this.reconnectAttempt ? 'reconnecting' : 'connecting', error: '' })
    this.connectPromise = new Promise((resolve, reject) => {
      const keyPair = generateKeyPair()
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
        if (this.socket !== socket || this.status.state === 'ready') return
        reject(error)
      }
      socket.addEventListener('open', () => {
        if (this.socket !== socket) return
        socket.send(JSON.stringify({ type: 'e2ee.hello', clientPublicKeyB64: keyPair.publicKeyB64 }))
      })
      socket.addEventListener('message', (event) => {
        if (this.socket !== socket) return
        if (!this.sharedKey) {
          const frame = typeof event.data === 'string' ? parseJsonFrame(event.data) : null
          if (frame?.type !== 'e2ee.ready' || frame.v !== 2) {
            socket.close(4003, 'invalid_e2ee_ready')
            failHandshake(new Error('Relay E2EE 握手失败。'))
            return
          }
          this.sharedKey = sharedKey
          clearTimeout(handshakeTimer)
          this.seenNonces = new NonceReplayWindow()
          this.reconnectAttempt = 0
          this.updateStatus({ state: 'ready', error: '', connectedAt: new Date().toISOString() })
          resolve()
          return
        }
        this.handleEncryptedMessage(event.data)
      })
      socket.addEventListener('error', () => {
        failHandshake(new Error('无法连接 PromptX Relay。'))
      })
      socket.addEventListener('close', () => {
        clearTimeout(handshakeTimer)
        if (this.socket !== socket) return
        const error = new Error('PromptX Relay 连接已断开。')
        failHandshake(error)
        this.socket = null
        this.sharedKey = null
        this.connectPromise = null
        this.failPending(error)
        this.updateStatus({ state: 'disconnected', error: error.message })
        this.scheduleReconnect()
      })
    }).finally(() => {
      if (this.status.state === 'ready') this.connectPromise = null
    })
    return this.connectPromise
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
      const plaintext = decryptPayload(this.sharedKey, payload, this.seenNonces)
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
    if (frame.type === 'response.start') {
      record.started = true
      const noBody = record.method === 'HEAD' || [204, 205, 304].includes(Number(frame.status))
      record.resolve(new Response(noBody ? null : record.stream, {
        status: Number(frame.status || 500),
        statusText: String(frame.statusText || ''),
        headers: frame.headers || {},
      }))
      return
    }
    if (frame.type === 'response.body') {
      record.controller.enqueue(new Uint8Array(decodeBase64(frame.chunk)))
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
    record.signal?.removeEventListener('abort', record.abort)
    this.pending.delete(record.requestId)
  }

  failPending(error) {
    for (const record of this.pending.values()) {
      if (record.started) record.controller.error(error)
      else record.reject(error)
      record.signal?.removeEventListener('abort', record.abort)
    }
    this.pending.clear()
  }

  sendFrame(frame) {
    if (!this.sharedKey || this.socket?.readyState !== this.WebSocketClass.OPEN) throw new Error('PromptX Relay 尚未连接。')
    this.socket.send(encryptPayload(this.sharedKey, JSON.stringify(frame)))
  }

  async request(path, options = {}) {
    await this.connect()
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    const requestId = createRequestId()
    const method = String(options.method || 'GET').toUpperCase()
    const headers = new Headers(options.headers || {})
    const body = await serializeBody(options.body, headers)
    if (options.signal?.aborted) throw new DOMException('The operation was aborted.', 'AbortError')
    let controller
    const stream = new ReadableStream({ start(value) { controller = value } })
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
    })
    try {
      this.sendFrame({ type: 'request.start', requestId, method, path, headers: headersToObject(headers) })
      for (const chunk of splitBytes(body)) {
        this.sendFrame({ type: 'request.body', requestId, chunk: encodeBase64(chunk) })
      }
      this.sendFrame({ type: 'request.end', requestId })
    } catch (error) {
      const record = this.pending.get(requestId)
      if (record) {
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
    this.connectPromise = null
    this.failPending(new Error('PromptX Relay 已关闭。'))
  }
}
