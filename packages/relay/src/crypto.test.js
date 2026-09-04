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
    v: 2,
    serverId: 'srv_abcdefghijklmnopqrstuvwxyz',
    daemonPublicKeyB64: daemon.publicKeyB64,
    relay: { url: 'wss://px.mushayu.com/relay/ws' },
  }
  assert.deepEqual(decodeConnectionOffer(encodeConnectionOffer(offer)), offer)
})
