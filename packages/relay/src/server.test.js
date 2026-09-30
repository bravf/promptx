import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

import WebSocket from 'ws'

import { readRelayServerConfig, startRelayServer } from './server.js'

import { generateSigningKeyPair, signingServerId, signChallenge, relayAuthTranscript } from './crypto.js'
const signing = generateSigningKeyPair()
const serverId = signingServerId(signing.publicKeyB64)

async function openSocket(url, authenticate = true) {
  const socket = await new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    socket.testMessages = []
    socket.testMessageWaiters = []
    socket.on('message', (data, isBinary) => {
      const message = { data, isBinary }
      const waiter = socket.testMessageWaiters.shift()
      if (waiter) waiter.resolve(message)
      else socket.testMessages.push(message)
    })
    socket.once('open', () => resolve(socket))
    socket.once('error', reject)
  })
  if (authenticate && new URL(url).searchParams.get('role') === 'server') {
    const challenge = await nextJson(socket)
    assert.equal(challenge.type, 'relay.challenge')
    socket.send(JSON.stringify({ type: 'relay.auth', publicKeyB64: signing.publicKeyB64, signature: signChallenge(signing.secretKeyB64, relayAuthTranscript(serverId, new URL(url).searchParams.get('connectionId'), challenge.challenge)) }))
    await delay(10)
  }
  return socket
}

function nextMessage(socket) {
  if (socket.testMessages.length) return Promise.resolve(socket.testMessages.shift())
  return new Promise((resolve, reject) => {
    const onClose = () => {
      cleanup()
      reject(new Error('socket closed before message'))
    }
    const cleanup = () => {
      socket.off('close', onClose)
      const index = socket.testMessageWaiters.findIndex((item) => item.resolve === resolve)
      if (index >= 0) socket.testMessageWaiters.splice(index, 1)
    }
    socket.testMessageWaiters.push({ resolve: (message) => { cleanup(); resolve(message) }, reject })
    socket.on('close', onClose)
  })
}

async function nextJson(socket) {
  const message = await nextMessage(socket)
  return JSON.parse(message.data.toString())
}

async function waitForJson(socket, type) {
  for (;;) {
    const frame = await nextJson(socket)
    if (frame.type === type) return frame
  }
}

async function startTestRelay(options = {}) {
  const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-web-'))
  fs.writeFileSync(path.join(webDistDir, 'index.html'), '<!doctype html><title>PromptX Relay</title>', 'utf8')
  fs.mkdirSync(path.join(webDistDir, 'assets'))
  fs.writeFileSync(path.join(webDistDir, 'assets', 'index-abcdefgh.js'), 'export const ready = true')
  fs.writeFileSync(path.join(webDistDir, 'media-preview-sw.js'), '// worker')
  return startRelayServer({
    logger: false,
    webDistDir,
    config: {
      host: '127.0.0.1',
      port: 0,
      heartbeatIntervalMs: 60_000,
      ...options,
    },
  })
}

test('Relay Server 配置允许随机端口且不包含租户和 Token', () => {
  const config = readRelayServerConfig({ host: '127.0.0.1', port: 0 })
  assert.equal(config.port, 0)
  assert.equal('tenants' in config, false)
  assert.equal('accessToken' in config, false)
  assert.equal('deviceToken' in config, false)
})

test('Relay 提供同一份 Web 应用和健康状态', async () => {
  const relay = await startTestRelay()
  try {
    const health = await fetch(`http://127.0.0.1:${relay.port}/health`).then((response) => response.json())
    assert.deepEqual(health, {
      ok: true,
      protocolVersion: 3,
      connectedDaemons: 0,
      connectedClients: 0,
    })
    const response = await fetch(`http://127.0.0.1:${relay.port}/`)
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    const html = await response.text()
    assert.match(html, /PromptX Relay/)
    for (const [file, cache] of [['assets/index-abcdefgh.js', 'public, max-age=31536000, immutable'], ['media-preview-sw.js', 'no-cache']]) {
      const asset = await fetch(`http://127.0.0.1:${relay.port}/${file}`)
      assert.equal(asset.status, 200)
      assert.equal(asset.headers.get('cache-control'), cache)
      await asset.text()
    }
  } finally {
    await relay.close()
  }
})

test('控制连接收到客户端 connectionId，数据连接双向原样转发文本和密文', async () => {
  const relay = await startTestRelay()
  const base = `ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}`
  let control
  let client
  let daemon
  try {
    control = await openSocket(`${base}&role=server`)
    assert.equal((await nextJson(control)).type, 'relay.ready')
    assert.deepEqual(await nextJson(control), { type: 'relay.sync', connectionIds: [] })

    const connectedPromise = waitForJson(control, 'relay.connected')
    client = await openSocket(`${base}&role=client`)
    const { connectionId } = await connectedPromise
    daemon = await openSocket(`${base}&role=server&connectionId=${connectionId}`)

    const clientText = nextMessage(daemon)
    client.send(JSON.stringify({ type: 'e2ee.hello', opaque: 'relay-does-not-parse-this' }))
    const receivedText = await clientText
    assert.equal(receivedText.isBinary, false)
    assert.match(receivedText.data.toString(), /relay-does-not-parse-this/)

    const ciphertext = Buffer.from([7, 11, 13, 17, 19, 23])
    const daemonBinary = nextMessage(daemon)
    client.send(ciphertext)
    const receivedCiphertext = await daemonBinary
    assert.equal(receivedCiphertext.isBinary, true)
    assert.deepEqual(Buffer.from(receivedCiphertext.data), ciphertext)

    const replyCiphertext = Buffer.from([29, 31, 37, 41])
    const clientBinary = nextMessage(client)
    daemon.send(replyCiphertext)
    const receivedReply = await clientBinary
    assert.equal(receivedReply.isBinary, true)
    assert.deepEqual(Buffer.from(receivedReply.data), replyCiphertext)
  } finally {
    control?.terminate()
    client?.terminate()
    daemon?.terminate()
    await relay.close()
  }
})

test('客户端先连接时会缓存握手帧，daemon 上线后通过 sync 接管', async () => {
  const relay = await startTestRelay()
  const base = `ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}`
  let control
  let client
  let daemon
  try {
    client = await openSocket(`${base}&role=client`)
    client.send('hello-before-daemon')
    await delay(20)

    control = await openSocket(`${base}&role=server`)
    assert.equal((await nextJson(control)).type, 'relay.ready')
    const sync = await nextJson(control)
    assert.equal(sync.type, 'relay.sync')
    assert.equal(sync.connectionIds.length, 1)

    const pendingMessage = new Promise(async (resolve, reject) => {
      try {
        daemon = await openSocket(`${base}&role=server&connectionId=${sync.connectionIds[0]}`)
        resolve(await nextMessage(daemon))
      } catch (error) {
        reject(error)
      }
    })
    const message = await pendingMessage
    assert.equal(message.data.toString(), 'hello-before-daemon')
    assert.equal(message.isBinary, false)
  } finally {
    control?.terminate()
    client?.terminate()
    daemon?.terminate()
    await relay.close()
  }
})

test('Relay 持续单向下行时不会把接收端误判为空闲连接', async () => {
  const relay = await startTestRelay({ heartbeatIntervalMs: 20, idleTimeoutMs: 70 })
  const base = `ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}`
  let control
  let client
  let daemon
  let sendTimer
  try {
    control = await openSocket(`${base}&role=server`)
    await nextJson(control)
    await nextJson(control)

    const connectedPromise = waitForJson(control, 'relay.connected')
    client = await openSocket(`${base}&role=client`)
    const { connectionId } = await connectedPromise
    daemon = await openSocket(`${base}&role=server&connectionId=${connectionId}`)

    sendTimer = setInterval(() => daemon.send('streaming-response'), 20)
    await delay(180)

    assert.equal(client.readyState, WebSocket.OPEN)
    assert.equal(daemon.readyState, WebSocket.OPEN)
  } finally {
    clearInterval(sendTimer)
    control?.terminate()
    client?.terminate()
    daemon?.terminate()
    await relay.close()
  }
})

test('未持有身份私钥的连接不能替换控制连接，旧签名不能重放', async () => {
  const relay = await startTestRelay()
  const base = `ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}&role=server`
  const sockets = []
  try {
    const control = await openSocket(base); sockets.push(control)
    await nextJson(control); await nextJson(control)
    const first = await openSocket(base, false); sockets.push(first)
    const challenge = await nextJson(first)
    const staleSignature = signChallenge(signing.secretKeyB64, relayAuthTranscript(serverId, '', challenge.challenge))
    first.terminate()
    const attacker = await openSocket(base, false); sockets.push(attacker)
    await nextJson(attacker)
    const closed = new Promise(resolve => attacker.once('close', resolve))
    attacker.send(JSON.stringify({ type: 'relay.auth', publicKeyB64: signing.publicKeyB64, signature: staleSignature }))
    assert.equal(await closed, 1008)
    assert.equal(control.readyState, WebSocket.OPEN)
    assert.equal(relay.controls.size, 1)
  } finally { sockets.forEach(socket => socket.terminate()); await relay.close() }
})

test('无人接管的客户端在超时后关闭，不遗留 WebSocket', async () => {
  const relay = await startTestRelay({ pendingTimeoutMs: 40 })
  let client
  try {
    client = await openSocket(`ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}&role=client`)
    const code = await new Promise(resolve => client.once('close', resolve))
    assert.equal(code, 1013)
    assert.equal(relay.connections.size, 0)
  } finally { client?.terminate(); await relay.close() }
})

test('数据连接也验证角色和 connectionId，控制连接的签名不能用于数据连接', async () => {
  const relay = await startTestRelay()
  const base = `ws://127.0.0.1:${relay.port}/relay/ws?v=3&serverId=${serverId}`
  const sockets = []
  try {
    const control = await openSocket(`${base}&role=server`); sockets.push(control)
    await nextJson(control); await nextJson(control)
    const connected = waitForJson(control, 'relay.connected')
    const client = await openSocket(`${base}&role=client`); sockets.push(client)
    const { connectionId } = await connected
    const attacker = await openSocket(`${base}&role=server&connectionId=${connectionId}`, false); sockets.push(attacker)
    const challenge = await nextJson(attacker)
    const closed = new Promise(resolve => attacker.once('close', resolve))
    attacker.send(JSON.stringify({ type: 'relay.auth', publicKeyB64: signing.publicKeyB64,
      signature: signChallenge(signing.secretKeyB64, relayAuthTranscript(serverId, '', challenge.challenge)) }))
    assert.equal(await closed, 1008)
    const daemon = await openSocket(`${base}&role=server&connectionId=${connectionId}`); sockets.push(daemon)
    const message = nextMessage(daemon)
    client.send('legitimate-data')
    assert.equal((await message).data.toString(), 'legitimate-data')
  } finally { sockets.forEach(socket => socket.terminate()); await relay.close() }
})
