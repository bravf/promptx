import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { createGzip } from 'node:zlib'
import WebSocket from 'ws'

import {
  buildRelayWebSocketUrl,
  createConnectionOfferUrl,
  decryptPayload,
  deriveSharedKey,
  encryptPayload,
  importPublicKey,
  importSecretKey,
  NonceReplayWindow,
  parseJsonFrame,
  RELAY_CHUNK_BYTES,
  splitBytes,
} from '../../../../packages/relay/src/index.js'
import { resolveDaemonPaths } from '../db/database.js'
import {
  loadOrCreateRelayIdentity,
  publicRelayIdentity,
  resetRelayIdentity,
} from './relayIdentity.js'

const DEFAULT_RELAY_URL = 'wss://px.mushayu.com/relay/ws'
const DEFAULT_APP_URL = 'https://px.mushayu.com/'
const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_TIMEOUT_MS = 60_000
const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024
const E2EE_HANDSHAKE_TIMEOUT_MS = 15_000
const excludedHeaders = new Set([
  'authorization',
  'connection',
  'content-length',
  'content-encoding',
  'cookie',
  'host',
  'keep-alive',
  'origin',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function cleanHeaders(input = {}) {
  const result = {}
  const entries = typeof input.entries === 'function' ? [...input.entries()] : Object.entries(input)
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase()
    if (!excludedHeaders.has(normalized) && value != null) result[normalized] = String(value)
  }
  return result
}

function booleanValue(value, fallback = true) {
  if (typeof value === 'boolean') return value
  if (value == null || value === '') return fallback
  return !['0', 'false', 'off', 'no'].includes(String(value).toLowerCase())
}

function invalidConfig(message) {
  const error = new Error(message)
  error.statusCode = 400
  return error
}

function normalizeWebSocketUrl(value) {
  let url
  try {
    url = new URL(String(value || DEFAULT_RELAY_URL).trim())
  } catch {
    throw invalidConfig('Relay 地址格式无效。')
  }
  if (url.protocol === 'https:') url.protocol = 'wss:'
  if (url.protocol === 'http:') url.protocol = 'ws:'
  if (!['ws:', 'wss:'].includes(url.protocol)) throw invalidConfig('Relay 地址必须使用 ws 或 wss。')
  return url.toString()
}

function normalizeAppUrl(value) {
  let url
  try {
    url = new URL(String(value || DEFAULT_APP_URL).trim())
  } catch {
    throw invalidConfig('公网 Web 地址格式无效。')
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw invalidConfig('公网 Web 地址必须使用 http 或 https。')
  return url.toString()
}

function normalizeConfig(input = {}, previous = {}) {
  return {
    enabled: booleanValue(input.enabled, previous.enabled ?? true),
    relayUrl: normalizeWebSocketUrl(input.relayUrl ?? previous.relayUrl ?? DEFAULT_RELAY_URL),
    appUrl: normalizeAppUrl(input.appUrl ?? previous.appUrl ?? DEFAULT_APP_URL),
  }
}

function safeRequestUrl(localBaseUrl, requestPath) {
  const rawPath = String(requestPath || '')
  if (!rawPath.startsWith('/api/v2/') || rawPath.startsWith('//')) {
    throw new Error('Relay 只允许访问 PromptX V2 API。')
  }
  const base = new URL(localBaseUrl)
  const target = new URL(rawPath, base)
  if (target.origin !== base.origin) throw new Error('Relay 请求目标无效。')
  return target
}

function isCompressibleResponse(response) {
  const contentType = String(response.headers.get('content-type') || '').toLowerCase()
  if (contentType.includes('text/event-stream')) return false
  return contentType.startsWith('text/')
    || contentType.includes('json')
    || contentType.includes('javascript')
    || contentType.includes('xml')
    || contentType.includes('svg')
}

export class RelayService {
  constructor({
    localBaseUrl,
    logger = console,
    configPath = path.join(resolveDaemonPaths().dataDir, 'relay-config-v2.json'),
    identityPath = path.join(resolveDaemonPaths().dataDir, 'relay-identity-v2.json'),
  }) {
    this.localBaseUrl = localBaseUrl
    this.logger = logger
    this.configPath = configPath
    this.identityPath = identityPath
    this.identity = loadOrCreateRelayIdentity(identityPath)
    this.config = this.readConfig()
    this.controlSocket = null
    this.channels = new Map()
    this.retryTimer = null
    this.restartTimer = null
    this.heartbeatTimer = null
    this.stopped = true
    this.status = {
      enabled: this.config.enabled,
      connected: false,
      relayUrl: this.config.relayUrl,
      serverId: this.identity.serverId,
      activeClientCount: 0,
      lastConnectedAt: '',
      lastDisconnectedAt: '',
      lastHeartbeatAt: '',
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
      ...(process.env.PROMPTX_RELAY_APP_URL ? { appUrl: process.env.PROMPTX_RELAY_APP_URL } : {}),
      ...(process.env.PROMPTX_RELAY_ENABLED ? { enabled: process.env.PROMPTX_RELAY_ENABLED } : {}),
    })
  }

  getConfig() {
    return { ...this.config }
  }

  getOffer() {
    const offer = {
      v: 2,
      serverId: this.identity.serverId,
      daemonPublicKeyB64: this.identity.publicKeyB64,
      relay: { url: this.config.relayUrl },
    }
    return { offer, url: createConnectionOfferUrl(this.config.appUrl, offer) }
  }

  getStatus() {
    return {
      ...this.status,
      activeClientCount: this.channels.size,
      controlReadyState: this.controlSocket?.readyState ?? WebSocket.CLOSED,
      identity: publicRelayIdentity(this.identity),
    }
  }

  updateConfig(input = {}) {
    this.config = normalizeConfig(input, this.config)
    fs.mkdirSync(path.dirname(this.configPath), { recursive: true })
    fs.writeFileSync(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`, { mode: 0o600 })
    Object.assign(this.status, {
      enabled: this.config.enabled,
      relayUrl: this.config.relayUrl,
      lastError: '',
    })
    this.scheduleRestart()
    return this.getConfig()
  }

  resetIdentity() {
    this.identity = resetRelayIdentity(this.identityPath)
    this.status.serverId = this.identity.serverId
    this.scheduleRestart()
    return publicRelayIdentity(this.identity)
  }

  start() {
    this.stopped = false
    if (this.config.enabled) this.connectControl()
  }

  stop() {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.restartTimer)
    clearInterval(this.heartbeatTimer)
    this.retryTimer = null
    this.restartTimer = null
    this.heartbeatTimer = null
    const controlSocket = this.controlSocket
    this.controlSocket = null
    controlSocket?.close()
    for (const channel of this.channels.values()) this.closeChannel(channel, 1001, 'relay_stopped')
    this.channels.clear()
    this.status.connected = false
    this.status.activeClientCount = 0
  }

  reconnect() {
    this.stop()
    this.start()
  }

  scheduleRestart() {
    clearTimeout(this.restartTimer)
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      this.reconnect()
    }, 100)
    this.restartTimer.unref?.()
  }

  controlUrl() {
    return buildRelayWebSocketUrl(this.config.relayUrl, {
      role: 'server',
      serverId: this.identity.serverId,
    })
  }

  dataUrl(connectionId) {
    return buildRelayWebSocketUrl(this.config.relayUrl, {
      role: 'server',
      serverId: this.identity.serverId,
      connectionId,
    })
  }

  connectControl() {
    if (this.stopped || !this.config.enabled || this.controlSocket) return
    let socket
    try {
      socket = new WebSocket(this.controlUrl(), { maxPayload: 64 * 1024 })
    } catch (error) {
      this.status.lastError = error.message
      this.scheduleReconnect()
      return
    }
    this.controlSocket = socket
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      const frame = parseJsonFrame(data.toString())
      if (frame) this.handleControlFrame(frame)
    })
    socket.on('pong', () => { this.status.lastHeartbeatAt = new Date().toISOString() })
    socket.on('error', (error) => { this.status.lastError = error.message })
    socket.on('close', (code, reason) => {
      if (this.controlSocket !== socket) return
      this.controlSocket = null
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
      Object.assign(this.status, {
        connected: false,
        lastDisconnectedAt: new Date().toISOString(),
        lastCloseCode: code,
        lastCloseReason: reason.toString(),
      })
      this.scheduleReconnect()
    })
  }

  handleControlFrame(frame) {
    if (frame.type === 'relay.ready') {
      const now = new Date().toISOString()
      Object.assign(this.status, {
        connected: true,
        lastConnectedAt: now,
        lastHeartbeatAt: now,
        lastError: '',
        reconnectCount: 0,
      })
      this.startHeartbeat()
      return
    }
    if (frame.type === 'relay.ping') {
      this.sendControl({ type: 'relay.pong' })
      this.status.lastHeartbeatAt = new Date().toISOString()
      return
    }
    if (frame.type === 'relay.connected') {
      this.openChannel(frame.connectionId)
      return
    }
    if (frame.type === 'relay.sync') {
      for (const connectionId of frame.connectionIds || []) this.openChannel(connectionId)
      return
    }
    if (frame.type === 'relay.disconnected') {
      const channel = this.channels.get(String(frame.connectionId || ''))
      if (channel) this.closeChannel(channel, 1000, 'client_disconnected')
    }
  }

  sendControl(frame) {
    if (this.controlSocket?.readyState === WebSocket.OPEN) {
      this.controlSocket.send(JSON.stringify(frame))
    }
  }

  startHeartbeat() {
    clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      const lastHeartbeat = Date.parse(this.status.lastHeartbeatAt || '')
      if (lastHeartbeat && Date.now() - lastHeartbeat > HEARTBEAT_TIMEOUT_MS) {
        this.controlSocket?.terminate()
        return
      }
      if (this.controlSocket?.readyState === WebSocket.OPEN) this.controlSocket.ping()
    }, HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref?.()
  }

  scheduleReconnect() {
    if (this.stopped || !this.config.enabled || this.retryTimer) return
    this.status.reconnectCount += 1
    const timeout = Math.min(30_000, 1_000 * (2 ** Math.min(this.status.reconnectCount - 1, 5)))
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      this.connectControl()
    }, timeout)
    this.retryTimer.unref?.()
  }

  openChannel(rawConnectionId) {
    const connectionId = String(rawConnectionId || '').trim()
    if (!/^conn_[A-Za-z0-9_-]{16,}$/.test(connectionId) || this.channels.has(connectionId)) return
    let socket
    try {
      socket = new WebSocket(this.dataUrl(connectionId), { maxPayload: 512 * 1024 })
    } catch (error) {
      this.status.lastError = error.message
      return
    }
    const channel = {
      connectionId,
      socket,
      sharedKey: null,
      seenNonces: new NonceReplayWindow(),
      requests: new Map(),
      acceptedBodyEncodings: new Set(),
      handshakeTimer: null,
    }
    this.channels.set(connectionId, channel)
    this.status.activeClientCount = this.channels.size
    socket.on('open', () => {
      channel.handshakeTimer = setTimeout(() => {
        if (!channel.sharedKey) this.closeChannel(channel, 1008, 'e2ee_handshake_timeout')
      }, E2EE_HANDSHAKE_TIMEOUT_MS)
      channel.handshakeTimer.unref?.()
    })
    socket.on('message', (data, isBinary) => this.handleChannelMessage(channel, data, isBinary))
    socket.on('error', (error) => { this.status.lastError = error.message })
    socket.on('close', () => {
      if (this.channels.get(connectionId) !== channel) return
      this.abortChannelRequests(channel)
      this.channels.delete(connectionId)
      this.status.activeClientCount = this.channels.size
    })
  }

  handleChannelMessage(channel, data, isBinary) {
    if (!channel.sharedKey) {
      if (isBinary) return this.closeChannel(channel, 1008, 'e2ee_handshake_required')
      const hello = parseJsonFrame(data.toString())
      if (hello?.type !== 'e2ee.hello') return this.closeChannel(channel, 1008, 'invalid_e2ee_hello')
      try {
        channel.acceptedBodyEncodings = new Set(
          (Array.isArray(hello.acceptBodyEncodings) ? hello.acceptBodyEncodings : [])
            .map((value) => String(value).toLowerCase())
            .filter((value) => value === 'gzip'),
        )
        channel.sharedKey = deriveSharedKey(
          importSecretKey(this.identity.secretKeyB64),
          importPublicKey(hello.clientPublicKeyB64),
        )
        clearTimeout(channel.handshakeTimer)
        channel.handshakeTimer = null
        channel.socket.send(JSON.stringify({ type: 'e2ee.ready', v: 2 }))
      } catch {
        this.closeChannel(channel, 1008, 'invalid_client_key')
      }
      return
    }
    if (!isBinary) return this.closeChannel(channel, 1008, 'unencrypted_frame')
    try {
      const plaintext = decryptPayload(channel.sharedKey, data, channel.seenNonces)
      if (typeof plaintext !== 'string') throw new Error('不支持的 Relay 业务帧。')
      const frame = parseJsonFrame(plaintext)
      if (!frame) throw new Error('Relay 业务帧格式无效。')
      this.handleRequestFrame(channel, frame)
    } catch (error) {
      this.status.lastError = error.message
      this.closeChannel(channel, 1008, 'invalid_encrypted_frame')
    }
  }

  handleRequestFrame(channel, frame) {
    const requestId = String(frame.requestId || '')
    if (!/^req_[A-Za-z0-9_-]{12,}$/.test(requestId)) return
    if (frame.type === 'request.start') {
      if (channel.requests.has(requestId)) return
      channel.requests.set(requestId, {
        requestId,
        method: String(frame.method || 'GET').toUpperCase(),
        path: String(frame.path || ''),
        headers: cleanHeaders(frame.headers),
        body: [],
        bodyBytes: 0,
        controller: null,
      })
      return
    }
    const request = channel.requests.get(requestId)
    if (!request) return
    if (frame.type === 'request.body') {
      const chunk = Buffer.from(String(frame.chunk || ''), 'base64')
      request.bodyBytes += chunk.byteLength
      if (request.bodyBytes > MAX_REQUEST_BODY_BYTES) {
        this.sendEncrypted(channel, {
          type: 'response.error',
          requestId,
          code: 'relay_request_too_large',
          message: '远程请求内容超过 64 MB 限制。',
        })
        channel.requests.delete(requestId)
        return
      }
      request.body.push(chunk)
    } else if (frame.type === 'request.end') {
      this.forward(channel, request)
    } else if (frame.type === 'request.cancel') {
      request.controller?.abort()
      channel.requests.delete(requestId)
    }
  }

  sendEncrypted(channel, frame) {
    if (!channel.sharedKey || channel.socket.readyState !== WebSocket.OPEN) return
    const encrypted = encryptPayload(channel.sharedKey, JSON.stringify(frame))
    channel.socket.send(Buffer.from(encrypted))
  }

  async forward(channel, request) {
    const controller = new AbortController()
    request.controller = controller
    try {
      const body = Buffer.concat(request.body)
      const response = await fetch(safeRequestUrl(this.localBaseUrl, request.path), {
        method: request.method,
        headers: { ...request.headers, 'x-promptx-relay-request': '1' },
        body: ['GET', 'HEAD'].includes(request.method) || !body.length ? undefined : body,
        signal: controller.signal,
      })
      const bodyEncoding = channel.acceptedBodyEncodings.has('gzip') && isCompressibleResponse(response)
        ? 'gzip'
        : ''
      this.sendEncrypted(channel, {
        type: 'response.start',
        requestId: request.requestId,
        status: response.status,
        statusText: response.statusText,
        headers: cleanHeaders(response.headers),
        ...(bodyEncoding ? { bodyEncoding } : {}),
      })
      if (response.body) {
        const responseBody = bodyEncoding
          ? Readable.fromWeb(response.body).pipe(createGzip({ chunkSize: RELAY_CHUNK_BYTES }))
          : response.body
        for await (const chunk of responseBody) {
          for (const part of splitBytes(chunk)) {
            this.sendEncrypted(channel, {
              type: 'response.body',
              requestId: request.requestId,
              chunk: Buffer.from(part).toString('base64'),
            })
          }
        }
      }
      this.sendEncrypted(channel, { type: 'response.end', requestId: request.requestId })
    } catch (error) {
      if (error.name !== 'AbortError') {
        this.sendEncrypted(channel, {
          type: 'response.error',
          requestId: request.requestId,
          code: 'relay_local_request_failed',
          message: error.message,
        })
      }
    } finally {
      channel.requests.delete(request.requestId)
    }
  }

  abortChannelRequests(channel) {
    for (const request of channel.requests.values()) request.controller?.abort()
    channel.requests.clear()
  }

  closeChannel(channel, code, reason) {
    clearTimeout(channel.handshakeTimer)
    this.abortChannelRequests(channel)
    if (this.channels.get(channel.connectionId) === channel) this.channels.delete(channel.connectionId)
    this.status.activeClientCount = this.channels.size
    try { channel.socket.close(code, reason) } catch {}
  }
}

export function registerRelayRoutes(app, relay) {
  const snapshot = () => ({
    config: relay.getConfig(),
    relay: relay.getStatus(),
    pairing: relay.getOffer(),
  })
  app.get('/api/v2/relay/config', async () => snapshot())
  app.put('/api/v2/relay/config', async (request) => {
    relay.updateConfig(request.body || {})
    return snapshot()
  })
  app.get('/api/v2/relay/status', async () => ({ relay: relay.getStatus() }))
  app.post('/api/v2/relay/reconnect', async () => {
    relay.scheduleRestart()
    return { ok: true, ...snapshot() }
  })
  app.post('/api/v2/relay/identity/reset', async () => {
    relay.resetIdentity()
    return { ok: true, ...snapshot() }
  })
}

export { cleanHeaders, normalizeConfig, safeRequestUrl }
