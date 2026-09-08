import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import WebSocket from 'ws'

import { startRelayServer } from '../../../../packages/relay/src/server.js'
import { EncryptedRelayConnection } from '../../../web/src/lib/relayConnection.js'
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

    const jsonResponse = await client.request('/api/v2/test')
    assert.equal(jsonResponse.status, 200)
    assert.deepEqual(await jsonResponse.json(), { ok: true, transport: '1' })

    const streamResponse = await client.request('/api/v2/events')
    const streamText = await streamResponse.text()
    assert.match(streamText, /event: timeline/)
    assert.match(streamText, /event: done/)

    const form = new FormData()
    form.append('file', new Blob(['private-file-content'], { type: 'text/plain' }), 'private.txt')
    const uploadResponse = await client.request('/api/v2/upload', { method: 'POST', body: form })
    const upload = await uploadResponse.json()
    assert.match(upload.contentType, /^multipart\/form-data; boundary=/)
    assert.match(upload.body, /private-file-content/)

    let bodyEncoding = ''
    const handleResponseFrame = client.handleResponseFrame.bind(client)
    client.handleResponseFrame = (frame) => {
      if (frame.type === 'response.start') bodyEncoding = frame.bodyEncoding || ''
      handleResponseFrame(frame)
    }
    const largeResponse = await client.request('/api/v2/large')
    const large = await largeResponse.json()
    assert.equal(bodyEncoding, 'gzip')
    assert.equal(large.content, 'timeline-content\n'.repeat(80_000))

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
