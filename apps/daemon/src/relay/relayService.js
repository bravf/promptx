import fs from 'node:fs'
import path from 'node:path'
import WebSocket from 'ws'
import { resolveDaemonPaths } from '../db/database.js'

const excludedHeaders = new Set(['connection', 'content-length', 'host', 'keep-alive', 'transfer-encoding', 'upgrade'])

function cleanHeaders(input = {}) {
  const result = {}
  const entries = typeof input.entries === 'function' ? [...input.entries()] : Object.entries(input)
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase()
    if (!excludedHeaders.has(normalized) && value != null) result[normalized] = String(value)
  }
  return result
}

function normalizeConfig(input = {}) {
  const relayUrl = String(input.relayUrl || '').trim()
  const deviceId = String(input.deviceId || '').trim()
  const deviceToken = String(input.deviceToken || '').trim()
  const requested = typeof input.enabled === 'boolean' ? input.enabled : !['0', 'false', 'off'].includes(String(input.enabled || '').toLowerCase())
  return { relayUrl, deviceId, deviceToken, enabled: Boolean(requested && relayUrl && deviceId && deviceToken) }
}

export class RelayService {
  constructor({ localBaseUrl, logger = console }) {
    this.localBaseUrl = localBaseUrl
    this.logger = logger
    this.socket = null
    this.retryTimer = null
    this.stopped = true
    this.requests = new Map()
    this.configPath = path.join(resolveDaemonPaths().dataDir, 'relay-config-v2.json')
    this.config = this.readConfig()
    this.status = {
      enabled: this.config.enabled,
      connected: false,
      relayUrl: this.config.relayUrl,
      deviceId: this.config.deviceId,
      lastConnectedAt: '',
      lastDisconnectedAt: '',
      lastError: '',
      reconnectCount: 0,
    }
  }

  readConfig() {
    let stored = {}
    try { stored = JSON.parse(fs.readFileSync(this.configPath, 'utf8')) } catch {}
    return normalizeConfig({
      ...stored,
      ...(process.env.PROMPTX_RELAY_URL ? { relayUrl: process.env.PROMPTX_RELAY_URL } : {}),
      ...(process.env.PROMPTX_RELAY_DEVICE_ID ? { deviceId: process.env.PROMPTX_RELAY_DEVICE_ID } : {}),
      ...(process.env.PROMPTX_RELAY_DEVICE_TOKEN ? { deviceToken: process.env.PROMPTX_RELAY_DEVICE_TOKEN } : {}),
      ...(process.env.PROMPTX_RELAY_ENABLED ? { enabled: process.env.PROMPTX_RELAY_ENABLED } : {}),
    })
  }

  getConfig() {
    return { ...this.config }
  }

  getStatus() {
    return { ...this.status, pendingRequestCount: this.requests.size, socketReadyState: this.socket?.readyState ?? WebSocket.CLOSED }
  }

  updateConfig(input) {
    this.config = normalizeConfig(input)
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`)
    Object.assign(this.status, { enabled: this.config.enabled, relayUrl: this.config.relayUrl, deviceId: this.config.deviceId, lastError: '' })
    this.stop()
    this.start()
    return this.getConfig()
  }

  start() {
    this.stopped = false
    if (this.config.enabled) this.connect()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    this.retryTimer = null
    for (const request of this.requests.values()) request.controller?.abort()
    this.requests.clear()
    this.socket?.close()
    this.socket = null
    this.status.connected = false
  }

  reconnect() {
    this.stop()
    this.start()
  }

  websocketUrl() {
    const url = new URL(this.config.relayUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    url.pathname = '/relay/connect'
    url.search = ''
    return url.toString()
  }

  connect() {
    if (this.stopped || !this.config.enabled || this.socket) return
    const socket = new WebSocket(this.websocketUrl())
    this.socket = socket
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', deviceId: this.config.deviceId, deviceToken: this.config.deviceToken, version: '2.0.0' })))
    socket.on('message', (data, binary) => {
      if (binary) return
      try { this.handleFrame(JSON.parse(data.toString())) } catch {}
    })
    socket.on('ping', () => { this.status.lastHeartbeatAt = new Date().toISOString() })
    socket.on('pong', () => { this.status.lastHeartbeatAt = new Date().toISOString() })
    socket.on('error', (error) => { this.status.lastError = error.message })
    socket.on('close', (code, reason) => {
      if (this.socket !== socket) return
      this.socket = null
      Object.assign(this.status, { connected: false, lastDisconnectedAt: new Date().toISOString(), lastCloseCode: code, lastCloseReason: reason.toString() })
      this.scheduleReconnect()
    })
  }

  scheduleReconnect() {
    if (this.stopped || !this.config.enabled || this.retryTimer) return
    this.status.reconnectCount += 1
    const timeout = Math.min(30000, 1000 * (2 ** Math.min(this.status.reconnectCount - 1, 5)))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, timeout)
    this.retryTimer.unref?.()
  }

  send(frame) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(frame))
  }

  handleFrame(frame) {
    if (frame.type === 'hello.ack') {
      Object.assign(this.status, { connected: true, lastConnectedAt: new Date().toISOString(), lastHeartbeatAt: new Date().toISOString(), lastError: '', reconnectCount: 0 })
      return
    }
    if (frame.type === 'request.start') {
      this.requests.set(frame.requestId, { ...frame, method: String(frame.method || 'GET').toUpperCase(), body: [], controller: null })
    } else if (frame.type === 'request.body') {
      this.requests.get(frame.requestId)?.body.push(Buffer.from(String(frame.chunk || ''), 'base64'))
    } else if (frame.type === 'request.end') {
      const request = this.requests.get(frame.requestId)
      if (request) this.forward(request)
    } else if (frame.type === 'request.cancel') {
      this.requests.get(frame.requestId)?.controller?.abort()
    }
  }

  async forward(request) {
    const controller = new AbortController()
    request.controller = controller
    try {
      const body = Buffer.concat(request.body)
      const response = await fetch(new URL(request.path || '/', this.localBaseUrl), {
        method: request.method,
        headers: { ...cleanHeaders(request.headers), 'x-promptx-relay-request': '1' },
        body: ['GET', 'HEAD'].includes(request.method) || !body.length ? undefined : body,
        signal: controller.signal,
      })
      this.send({ type: 'response.start', requestId: request.requestId, status: response.status, statusText: response.statusText, headers: cleanHeaders(response.headers) })
      if (response.body) {
        for await (const chunk of response.body) this.send({ type: 'response.body', requestId: request.requestId, chunk: Buffer.from(chunk).toString('base64') })
      }
      this.send({ type: 'response.end', requestId: request.requestId })
    } catch (error) {
      this.send({ type: 'response.error', requestId: request.requestId, code: 'relay_local_request_failed', message: error.message })
    } finally {
      this.requests.delete(request.requestId)
    }
  }
}

export function registerRelayRoutes(app, relay) {
  app.get('/api/v2/relay/config', async () => ({ config: relay.getConfig(), relay: relay.getStatus() }))
  app.put('/api/v2/relay/config', async (request) => ({ config: relay.updateConfig(request.body || {}), relay: relay.getStatus() }))
  app.get('/api/v2/relay/status', async () => ({ relay: relay.getStatus() }))
  app.post('/api/v2/relay/reconnect', async () => { relay.reconnect(); return { ok: true, relay: relay.getStatus() } })
}
