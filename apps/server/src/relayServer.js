import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

import fastifyStatic from '@fastify/static'
import Fastify from 'fastify'
import { WebSocketServer, WebSocket } from 'ws'

import { serverRootDir } from './appPaths.js'

const DEFAULT_RELAY_PORT = 3030
const DEFAULT_RELAY_HOST = '0.0.0.0'
const DEFAULT_MAX_FRAME_BYTES = 512 * 1024
const DEFAULT_MAX_CLIENTS_PER_SERVER = 16
const DEFAULT_MAX_TOTAL_CLIENTS = 5_000
const DEFAULT_PENDING_BYTES = 1024 * 1024
const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000
const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000
const DEFAULT_PENDING_TIMEOUT_MS = 30_000
const DEFAULT_CONNECTIONS_PER_MINUTE = 120

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : fallback
}

function readRelayServerConfig(overrides = {}) {
  const rawPort = overrides.port ?? process.env.PROMPTX_RELAY_PORT ?? process.env.PORT ?? DEFAULT_RELAY_PORT
  const parsedPort = Number(rawPort)
  return {
    host: String(overrides.host || process.env.PROMPTX_RELAY_HOST || process.env.HOST || DEFAULT_RELAY_HOST).trim() || DEFAULT_RELAY_HOST,
    port: Number.isInteger(parsedPort) && parsedPort >= 0 ? parsedPort : DEFAULT_RELAY_PORT,
    maxFrameBytes: positiveInteger(overrides.maxFrameBytes ?? process.env.PROMPTX_RELAY_MAX_FRAME_BYTES, DEFAULT_MAX_FRAME_BYTES),
    maxClientsPerServer: positiveInteger(overrides.maxClientsPerServer ?? process.env.PROMPTX_RELAY_MAX_CLIENTS_PER_SERVER, DEFAULT_MAX_CLIENTS_PER_SERVER),
    maxTotalClients: positiveInteger(overrides.maxTotalClients ?? process.env.PROMPTX_RELAY_MAX_TOTAL_CLIENTS, DEFAULT_MAX_TOTAL_CLIENTS),
    maxPendingBytes: positiveInteger(overrides.maxPendingBytes ?? process.env.PROMPTX_RELAY_MAX_PENDING_BYTES, DEFAULT_PENDING_BYTES),
    heartbeatIntervalMs: positiveInteger(overrides.heartbeatIntervalMs ?? process.env.PROMPTX_RELAY_HEARTBEAT_INTERVAL_MS, DEFAULT_HEARTBEAT_INTERVAL_MS),
    idleTimeoutMs: positiveInteger(overrides.idleTimeoutMs ?? process.env.PROMPTX_RELAY_IDLE_TIMEOUT_MS, DEFAULT_IDLE_TIMEOUT_MS),
    pendingTimeoutMs: positiveInteger(overrides.pendingTimeoutMs ?? process.env.PROMPTX_RELAY_PENDING_TIMEOUT_MS, DEFAULT_PENDING_TIMEOUT_MS),
    connectionsPerMinute: positiveInteger(overrides.connectionsPerMinute ?? process.env.PROMPTX_RELAY_CONNECTIONS_PER_MINUTE, DEFAULT_CONNECTIONS_PER_MINUTE),
  }
}

function getWebDistRoot() {
  return path.resolve(serverRootDir, '..', 'web', 'dist')
}

function validServerId(value) {
  return /^srv_[A-Za-z0-9_-]{20,}$/.test(String(value || ''))
}

function validConnectionId(value) {
  return /^conn_[A-Za-z0-9_-]{16,}$/.test(String(value || ''))
}

function createConnectionId() {
  return `conn_${crypto.randomBytes(18).toString('base64url')}`
}

function sendJson(socket, frame) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame))
}

function parseSocketRequest(request) {
  const url = new URL(request.url || '/', 'http://relay.local')
  return {
    pathname: url.pathname,
    version: url.searchParams.get('v'),
    role: url.searchParams.get('role'),
    serverId: url.searchParams.get('serverId') || '',
    connectionId: url.searchParams.get('connectionId') || '',
  }
}

async function startRelayServer(options = {}) {
  const config = readRelayServerConfig(options.config)
  const app = Fastify({ logger: options.logger ?? true })
  const webDistDir = path.resolve(options.webDistDir || getWebDistRoot())
  const controls = new Map()
  const connections = new Map()
  const connectionAttempts = new Map()
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: config.maxFrameBytes })

  function connectionsForServer(serverId) {
    return [...connections.values()].filter((record) => record.serverId === serverId)
  }

  function notifyControl(serverId, frame) {
    sendJson(controls.get(serverId)?.socket, frame)
  }

  function removeConnection(record, source, code = 1000, reason = 'connection_closed') {
    if (connections.get(record.connectionId) !== record) return
    connections.delete(record.connectionId)
    clearTimeout(record.pendingTimer)
    notifyControl(record.serverId, { type: 'relay.disconnected', connectionId: record.connectionId })
    const peer = source === 'client' ? record.serverSocket : record.clientSocket
    if (peer?.readyState === WebSocket.OPEN || peer?.readyState === WebSocket.CONNECTING) {
      try { peer.close(code, reason) } catch {}
    }
    record.pendingFrames.length = 0
    record.pendingBytes = 0
  }

  function attachLiveness(socket, record = null) {
    socket.isAlive = true
    socket.lastActivityAt = Date.now()
    socket.on('pong', () => {
      socket.isAlive = true
    })
  }

  function forward(record, target, data, isBinary, sourceSocket) {
    record.lastActivityAt = Date.now()
    sourceSocket.lastActivityAt = record.lastActivityAt
    if (target?.readyState === WebSocket.OPEN) {
      target.send(data, { binary: isBinary })
      return true
    }
    return false
  }

  function attachClient(socket, serverId) {
    if (connections.size >= config.maxTotalClients) {
      socket.close(1013, 'relay_capacity_reached')
      return
    }
    if (connectionsForServer(serverId).length >= config.maxClientsPerServer) {
      socket.close(1013, 'server_client_limit')
      return
    }
    let connectionId = createConnectionId()
    while (connections.has(connectionId)) connectionId = createConnectionId()
    const record = {
      serverId,
      connectionId,
      clientSocket: socket,
      serverSocket: null,
      pendingFrames: [],
      pendingBytes: 0,
      connectedAt: Date.now(),
      lastActivityAt: Date.now(),
      pendingTimer: null,
    }
    record.pendingTimer = setTimeout(() => {
      if (!record.serverSocket) removeConnection(record, 'client', 1013, 'daemon_connect_timeout')
    }, config.pendingTimeoutMs)
    record.pendingTimer.unref?.()
    connections.set(connectionId, record)
    attachLiveness(socket, record)
    socket.on('message', (data, isBinary) => {
      if (forward(record, record.serverSocket, data, isBinary, socket)) return
      const bytes = data.byteLength ?? data.length ?? 0
      if (record.pendingBytes + bytes > config.maxPendingBytes) {
        removeConnection(record, 'client', 1009, 'pending_buffer_exceeded')
        return
      }
      record.pendingFrames.push({ data: Buffer.from(data), isBinary })
      record.pendingBytes += bytes
    })
    socket.on('close', (code, reason) => removeConnection(record, 'client', code, reason.toString() || 'client_closed'))
    socket.on('error', () => removeConnection(record, 'client', 1011, 'client_error'))
    notifyControl(serverId, { type: 'relay.connected', connectionId })
  }

  function attachServerData(socket, serverId, connectionId) {
    const record = connections.get(connectionId)
    if (!record || record.serverId !== serverId) {
      socket.close(1008, 'unknown_connection')
      return
    }
    if (record.serverSocket && record.serverSocket !== socket) {
      try { record.serverSocket.close(1012, 'server_connection_replaced') } catch {}
    }
    record.serverSocket = socket
    clearTimeout(record.pendingTimer)
    record.pendingTimer = null
    attachLiveness(socket, record)
    socket.on('message', (data, isBinary) => {
      forward(record, record.clientSocket, data, isBinary, socket)
    })
    socket.on('close', (code, reason) => {
      if (record.serverSocket === socket) removeConnection(record, 'server', code, reason.toString() || 'server_closed')
    })
    socket.on('error', () => {
      if (record.serverSocket === socket) removeConnection(record, 'server', 1011, 'server_error')
    })
    for (const frame of record.pendingFrames) {
      if (socket.readyState !== WebSocket.OPEN) break
      socket.send(frame.data, { binary: frame.isBinary })
    }
    record.pendingFrames.length = 0
    record.pendingBytes = 0
  }

  function attachControl(socket, serverId) {
    const previous = controls.get(serverId)
    if (previous?.socket && previous.socket !== socket) {
      try { previous.socket.close(1012, 'control_replaced') } catch {}
    }
    const control = { serverId, socket, connectedAt: Date.now() }
    socket.isControl = true
    controls.set(serverId, control)
    attachLiveness(socket)
    socket.on('message', (data, isBinary) => {
      socket.lastActivityAt = Date.now()
      if (isBinary) return
      try {
        const frame = JSON.parse(data.toString())
        if (frame?.type === 'relay.pong') socket.isAlive = true
      } catch {}
    })
    socket.on('close', () => {
      if (controls.get(serverId) === control) controls.delete(serverId)
    })
    socket.on('error', () => {
      if (controls.get(serverId) === control) controls.delete(serverId)
    })
    sendJson(socket, { type: 'relay.ready', v: 2 })
    sendJson(socket, {
      type: 'relay.sync',
      connectionIds: connectionsForServer(serverId).map((record) => record.connectionId),
    })
  }

  wsServer.on('connection', (socket, request) => {
    const params = parseSocketRequest(request)
    if (params.version !== '2' || !validServerId(params.serverId)) {
      socket.close(1008, 'invalid_relay_parameters')
      return
    }
    if (params.role === 'client' && !params.connectionId) {
      attachClient(socket, params.serverId)
      return
    }
    if (params.role === 'server' && !params.connectionId) {
      attachControl(socket, params.serverId)
      return
    }
    if (params.role === 'server' && validConnectionId(params.connectionId)) {
      attachServerData(socket, params.serverId, params.connectionId)
      return
    }
    socket.close(1008, 'invalid_relay_role')
  })

  app.get('/health', async () => ({
    ok: true,
    protocolVersion: 2,
    connectedDaemons: controls.size,
    connectedClients: connections.size,
  }))

  if (fs.existsSync(path.join(webDistDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDistDir, wildcard: false })
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/relay/') || request.url.startsWith('/api/')) {
        return reply.code(404).send({ error: 'not_found', message: '请使用 PromptX 设置中生成的完整远程访问链接。' })
      }
      return reply.sendFile('index.html')
    })
  }

  app.server.on('upgrade', (request, socket, head) => {
    const { pathname } = parseSocketRequest(request)
    if (pathname !== '/relay/ws') {
      socket.destroy()
      return
    }
    const forwardedIp = String(request.headers['x-forwarded-for'] || '').split(',')[0].trim()
    const clientIp = forwardedIp || request.socket.remoteAddress || 'unknown'
    const now = Date.now()
    const attempt = connectionAttempts.get(clientIp)
    const current = !attempt || now - attempt.windowStartedAt >= 60_000
      ? { windowStartedAt: now, count: 1 }
      : { ...attempt, count: attempt.count + 1 }
    connectionAttempts.set(clientIp, current)
    if (current.count > config.connectionsPerMinute) {
      socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      socket.destroy()
      return
    }
    wsServer.handleUpgrade(request, socket, head, (ws) => wsServer.emit('connection', ws, request))
  })

  const heartbeatTimer = setInterval(() => {
    const now = Date.now()
    for (const socket of wsServer.clients) {
      if (!socket.isAlive || (!socket.isControl && now - Number(socket.lastActivityAt || now) > config.idleTimeoutMs)) {
        socket.terminate()
        continue
      }
      socket.isAlive = false
      try { socket.ping() } catch { socket.terminate() }
    }
    for (const control of controls.values()) sendJson(control.socket, { type: 'relay.ping' })
    for (const [clientIp, attempt] of connectionAttempts) {
      if (now - attempt.windowStartedAt >= 120_000) connectionAttempts.delete(clientIp)
    }
  }, config.heartbeatIntervalMs)
  heartbeatTimer.unref?.()

  await app.listen({ host: config.host, port: config.port })
  const address = app.server.address()
  const port = typeof address === 'object' && address ? address.port : config.port
  app.log.info({ host: config.host, port }, '[relay] PromptX E2EE Relay 已启动')

  return {
    app,
    config,
    port,
    controls,
    connections,
    async close() {
      clearInterval(heartbeatTimer)
      for (const socket of wsServer.clients) socket.terminate()
      await new Promise((resolve) => wsServer.close(() => resolve()))
      await app.close()
    },
  }
}

export {
  createConnectionId,
  parseSocketRequest,
  readRelayServerConfig,
  startRelayServer,
  validConnectionId,
  validServerId,
}
