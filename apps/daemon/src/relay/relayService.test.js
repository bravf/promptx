import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import WebSocket from 'ws'

import { randomToken } from '../../../../packages/relay/src/crypto.js'
import { startRelayServer } from '../../../../packages/relay/src/server.js'
import { EncryptedRelayConnection } from '../../../web/src/lib/relayConnection.js'
import { RELAY_RESPONSE_WINDOW_BYTES } from '../../../../packages/relay/src/protocol.js'
import { cleanHeaders, RelayService } from './relayService.js'

test('Relay 内部转发剥离浏览器 Origin 和凭证头', () => {
  assert.deepEqual(cleanHeaders({
    origin: 'https://px.mushayu.com',
    authorization: 'Bearer secret',
    cookie: 'session=secret',
    'content-type': 'application/json',
  }), { 'content-type': 'application/json' })
})

async function waitFor(check, timeoutMs = 3_000) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const value = check()
    if (value) return value
    await delay(20)
  }
  throw new Error('waitFor timeout')
}

function startLocalApi() {
  const server = http.createServer((request, response) => {
    if (request.url === '/api/v2/test') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ ok: true, transport: request.headers['x-promptx-relay-request'] }))
      return
    }
    if (request.url === '/api/v2/events') {
      response.setHeader('content-type', 'text/event-stream')
      response.write('event: timeline\n')
      response.write('data: {"seq":1}\n\n')
      setTimeout(() => response.end('event: done\ndata: {}\n\n'), 20)
      return
    }
    if (request.url === '/api/v2/upload' && request.method === 'POST') {
      const chunks = []
      request.on('data', (chunk) => chunks.push(chunk))
      request.on('end', () => {
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({
          contentType: request.headers['content-type'],
          body: Buffer.concat(chunks).toString('utf8'),
        }))
      })
      return
    }
    if (request.url === '/api/v2/large') {
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ content: 'timeline-content\n'.repeat(80_000) }))
      return
    }
    if (request.url === '/api/v2/binary') {
      response.setHeader('content-type', 'application/octet-stream')
      response.end(Buffer.alloc(2 * 1024 * 1024, 157))
      return
    }
    if (request.url === '/api/v2/stall') return
    response.statusCode = 404
    response.end()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('daemon 与浏览器通过盲 Relay 完成 E2EE JSON、SSE 和 FormData 隧道', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-e2e-'))
  const webDir = path.join(tempDir, 'web')
  fs.mkdirSync(webDir)
  fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html>', 'utf8')
  const localApi = await startLocalApi()
  const relay = await startRelayServer({
    logger: false,
    webDistDir: webDir,
    config: { host: '127.0.0.1', port: 0, heartbeatIntervalMs: 60_000 },
  })
  const service = new RelayService({
    localBaseUrl: `http://127.0.0.1:${localApi.port}`,
    logger: false,
    configPath: path.join(tempDir, 'relay-config.json'),
    identityPath: path.join(tempDir, 'relay-identity.json'),
  })
  service.updateConfig({
    enabled: true,
    relayUrl: `ws://127.0.0.1:${relay.port}/relay/ws`,
    appUrl: `http://127.0.0.1:${relay.port}/`,
  })
  let client
  let timeoutClient
  try {
    await waitFor(() => service.getStatus().connected)
    client = new EncryptedRelayConnection(service.getOffer().offer, { WebSocketClass: WebSocket })

    let bodyEncoding = ''
    const handleResponseFrame = client.handleResponseFrame.bind(client)
    client.handleResponseFrame = (frame) => {
      if (frame.type === 'response.start') bodyEncoding = frame.bodyEncoding || ''
      handleResponseFrame(frame)
    }

    const unauthorized = new EncryptedRelayConnection({ ...service.getOffer().offer, pairingKeyB64: randomToken() }, { WebSocketClass: WebSocket })
    try { await assert.rejects(unauthorized.request('/api/v2/test')) } finally { unauthorized.close() }
    const jsonResponse = await client.request('/api/v2/test')
    assert.equal(jsonResponse.status, 200)
    assert.deepEqual(await jsonResponse.json(), { ok: true, transport: '1' })
    assert.equal(bodyEncoding, '', '已知小于 1KiB 的 JSON 不压缩')

    const streamResponse = await client.request('/api/v2/events')
    const streamText = await streamResponse.text()
    assert.match(streamText, /event: timeline/)
    assert.match(streamText, /event: done/)
    assert.equal(bodyEncoding, '', '实时事件流不压缩')

    const canceledStream = await client.request('/api/v2/events')
    await canceledStream.body.cancel()
    await delay(40)
    assert.equal(client.snapshot().pendingRequestCount, 0)
    assert.equal(client.snapshot().state, 'ready')

    const form = new FormData()
    form.append('file', new Blob(['private-file-content'], { type: 'text/plain' }), 'private.txt')
    const uploadResponse = await client.request('/api/v2/upload', { method: 'POST', body: form })
    const upload = await uploadResponse.json()
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/)
    assert.match(upload.body, /private-file-content/)

    const largeResponse = await client.request('/api/v2/large')
    const large = await largeResponse.json()
    assert.equal(bodyEncoding, 'gzip')
    assert.equal(large.content, 'timeline-content\n'.repeat(80_000))

    assert.equal(client.bodyFrameEncoding, 'binary-v1')
    const paused = await client.request('/api/v2/binary')
    await delay(100)
    assert.equal(client.pending.size, 1, '慢消费者暂停时等待接收额度')
    const record = [...client.pending.values()][0]
    assert.ok(record.receivedBytes <= RELAY_RESPONSE_WINDOW_BYTES)
    assert.ok(record.controller.desiredSize >= 0)
    const bytes = new Uint8Array(await paused.arrayBuffer())
    assert.equal(bytes.length, 2 * 1024 * 1024)
    assert.ok(bytes.every(byte => byte === 157))
    const canceled = await client.request('/api/v2/binary')
    await delay(50)
    await canceled.body.cancel()
    await delay(50)
    assert.equal(client.pending.size, 0)
    assert.ok([...service.channels.values()].every(channel => channel.requests.size === 0))

    const legacy = new EncryptedRelayConnection(service.getOffer().offer, { WebSocketClass: WebSocket, binaryFrames: false })
    try {
      const response = await legacy.request('/api/v2/binary')
      assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024)
      assert.equal(legacy.bodyFrameEncoding, '')
    } finally { legacy.close() }

    const channelMessage = service.handleChannelMessage.bind(service)
    service.handleChannelMessage = (channel, data, binary) => {
      if (!binary) {
        const frame = JSON.parse(data.toString())
        if (frame.type === 'e2ee.hello') {
          delete frame.acceptFrameEncodings
          data = Buffer.from(JSON.stringify(frame))
        }
      }
      channelMessage(channel, data, binary)
    }
    const fallback = new EncryptedRelayConnection(service.getOffer().offer, { WebSocketClass: WebSocket })
    try {
      const response = await fallback.request('/api/v2/binary')
      assert.equal((await response.arrayBuffer()).byteLength, 2 * 1024 * 1024)
      assert.equal(fallback.bodyFrameEncoding, '', '新客户端连接旧握手时退回原格式')
    } finally { fallback.close(); service.handleChannelMessage = channelMessage }

    timeoutClient = new EncryptedRelayConnection(service.getOffer().offer, {
      WebSocketClass: WebSocket,
      requestIdleTimeoutMs: 50,
    })
    await assert.rejects(
      timeoutClient.request('/api/v2/stall'),
      (error) => error.name === 'TimeoutError' && /响应超时/.test(error.message),
    )
  } finally {
    timeoutClient?.close()
    client?.close()
    service.stop()
    await relay.close()
    await new Promise((resolve) => localApi.server.close(resolve))
  }
})

test('重复 request.end 和已结束 requestId 不会重复执行，取消和过期释放缓冲', () => {
  const service = Object.create(RelayService.prototype)
  const channel = { requests: new Map(), requestIds: new Set(), bufferedBytes: 0 }
  const forwarded = [], errors = []
  service.forward = async (_channel, request) => forwarded.push(request)
  service.sendEncrypted = (_channel, frame) => errors.push(frame)
  const requestId = 'req_duplicate123456'
  const start = { type: 'request.start', requestId, method: 'POST', path: '/api/v2/test' }
  service.handleRequestFrame(channel, start)
  service.handleRequestFrame(channel, { type: 'request.body', requestId, chunk: Buffer.from('body').toString('base64') })
  assert.equal(channel.bufferedBytes, 4)
  service.handleRequestFrame(channel, { type: 'request.end', requestId })
  service.handleRequestFrame(channel, { type: 'request.end', requestId })
  assert.equal(forwarded.length, 1)
  service.handleRequestFrame(channel, { type: 'request.cancel', requestId })
  assert.equal(channel.bufferedBytes, 0)
  service.handleRequestFrame(channel, start)
  service.handleRequestFrame(channel, { type: 'request.end', requestId })
  assert.equal(forwarded.length, 1)
  const secondId = 'req_timeout123456789'
  service.handleRequestFrame(channel, { ...start, requestId: secondId })
  service.handleRequestFrame(channel, { type: 'request.body', requestId: secondId, chunk: Buffer.from('body').toString('base64') })
  service.expireRequest(channel, secondId)
  assert.equal(channel.bufferedBytes, 0)
  assert.equal(channel.requests.size, 0)
  assert.equal(errors.at(-1).code, 'request_timeout')
})

test('握手期间主动关闭客户端会拒绝等待者，不遗留悬挂 connect', async () => {
  const sockets = []
  class WaitingSocket extends EventTarget {
    static OPEN = 1
    constructor() { super(); sockets.push(this); this.readyState = 0 }
    close() { this.readyState = 3; queueMicrotask(() => this.dispatchEvent(new Event('close'))) }
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-close-'))
  const service = new RelayService({ configPath: path.join(root, 'config'), identityPath: path.join(root, 'identity') })
  const client = new EncryptedRelayConnection(service.getOffer().offer, { WebSocketClass: WaitingSocket })
  try {
    const connecting = client.connect()
    assert.equal(sockets.length, 1)
    client.close()
    await assert.rejects(connecting, /断开/)
    assert.equal(client.connectPromise, null)
  } finally { client.close(); service.stop(); fs.rmSync(root, { recursive: true, force: true }) }
})
