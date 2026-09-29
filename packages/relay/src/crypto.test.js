import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeConnectionOffer,
  decryptPayload,
  deriveSharedKey,
  encodeConnectionOffer,
  encryptPayload,
  generateKeyPair,
  NonceReplayWindow,
  randomToken, SessionCipher, deriveSessionKeys, sessionTranscript,
} from './index.js'

test('双方可以派生相同密钥并加密文本与二进制', () => {
  const daemon = generateKeyPair()
  const client = generateKeyPair()
  const clientShared = deriveSharedKey(client.secretKey, daemon.publicKey)
  const daemonShared = deriveSharedKey(daemon.secretKey, client.publicKey)

  assert.deepEqual(clientShared, daemonShared)
  assert.equal(decryptPayload(daemonShared, encryptPayload(clientShared, 'hello')), 'hello')
  assert.deepEqual(new Uint8Array(decryptPayload(clientShared, encryptPayload(daemonShared, new Uint8Array([1, 2, 3])))), new Uint8Array([1, 2, 3]))
})

test('重复 nonce 会被拒绝', () => {
  const daemon = generateKeyPair()
  const client = generateKeyPair()
  const shared = deriveSharedKey(client.secretKey, daemon.publicKey)
  const frame = encryptPayload(shared, 'hello')
  const seen = new Set()
  assert.equal(decryptPayload(shared, frame, seen), 'hello')
  assert.throws(() => decryptPayload(shared, frame, seen), /重复加密帧/)
})

test('nonce 重放窗口保持固定容量并保留最近记录', () => {
  const seen = new NonceReplayWindow(2)
  seen.add('first').add('second').add('third')
  assert.equal(seen.size, 2)
  assert.equal(seen.has('first'), false)
  assert.equal(seen.has('second'), true)
  assert.equal(seen.has('third'), true)
})

test('Offer 使用 Base64URL JSON 往返', () => {
  const daemon = generateKeyPair()
  const offer = {
    v: 3,
    pairingKeyB64: randomToken(),
    serverId: 'srv_abcdefghijklmnopqrstuvwxyz',
    daemonPublicKeyB64: daemon.publicKeyB64,
    relay: { url: 'wss://px.mushayu.com/relay/ws' },
  }
  assert.deepEqual(decodeConnectionOffer(encodeConnectionOffer(offer)), offer)
})

test('拒绝低阶公钥，包括 0 和 1', () => {
  const { secretKey } = generateKeyPair()
  for (const firstByte of [0, 1]) {
    const key = new Uint8Array(32); key[0] = firstByte
    assert.throws(() => deriveSharedKey(secretKey, key), /低阶/)
  }
})

test('会话密钥绑定配对秘密、挑战、客户端及方向，拒绝重放和篡改', () => {
  const daemon = generateKeyPair(), client = generateKeyPair()
  const shared = deriveSharedKey(client.secretKey, daemon.publicKey)
  const pairing = randomToken()
  const hello = { clientPublicKeyB64: client.publicKeyB64, clientNonce: randomToken(), acceptBodyEncodings: ['gzip'] }
  const transcript = sessionTranscript('srv_test', hello, randomToken())
  const keys = deriveSessionKeys(shared, pairing, transcript)
  const sender = new SessionCipher(keys.clientToServer, keys.serverToClient)
  const receiver = new SessionCipher(keys.serverToClient, keys.clientToServer)
  const frame = sender.encrypt('private request')
  assert.equal(receiver.decrypt(frame), 'private request')
  assert.throws(() => receiver.decrypt(frame), /重放/)
  assert.throws(() => sender.decrypt(frame), /认证失败/)
  for (const other of [deriveSessionKeys(shared, randomToken(), transcript), deriveSessionKeys(shared, pairing, sessionTranscript('srv_test', hello, randomToken()))]) {
    assert.throws(() => new SessionCipher(other.serverToClient, other.clientToServer).decrypt(frame), /认证失败/)
  }
  const modified = new Uint8Array(sender.encrypt('second')); modified[modified.length - 1] ^= 1
  assert.throws(() => receiver.decrypt(modified), /认证失败/)
  assert.equal(receiver.received, 1)
})

test('旧配对链接明确要求重新配对', () => {
  const old = Buffer.from(JSON.stringify({ v: 2 })).toString('base64url')
  assert.throws(() => decodeConnectionOffer(old), /重新配对/)
})
