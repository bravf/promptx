import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeConnectionOffer,
  decodeBase64, encodeBase64,
  decryptPayload,
  deriveSharedKey,
  encodeConnectionOffer,
  encryptPayload,
  generateKeyPair,
  NonceReplayWindow,
  randomToken, SessionCipher, deriveSessionKeys, sessionTranscript,
} from './index.js'

test('Base64 原生与回退解码保持二进制、空内容和非法输入语义', t => {
  const bytes = Uint8Array.from({ length: 1024 }, (_, i) => i % 256)
  const encoded = encodeBase64(bytes)
  const original = Uint8Array.fromBase64
  t.after(() => {
    if (original === undefined) delete Uint8Array.fromBase64
    else Uint8Array.fromBase64 = original
  })
  for (const native of [undefined, value => {
    const binary = atob(value)
    return Uint8Array.from(binary, char => char.charCodeAt(0))
  }]) {
    Uint8Array.fromBase64 = native
    assert.deepEqual(new Uint8Array(decodeBase64(` ${encoded}\n`)), bytes)
    assert.equal(decodeBase64('').byteLength, 0)
    assert.throws(() => decodeBase64('***'))
  }
})

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

test('二进制与控制帧共享严格顺序，拒绝跨格式重放与篡改', () => {
  const key = new Uint8Array(32).fill(123)
  const sender = new SessionCipher(key, key), receiver = new SessionCipher(key, key)
  const a = sender.encrypt('control')
  const b = sender.encryptBinary(new Uint8Array([0, 128, 255]))
  const c = sender.encrypt('end')
  assert.equal(receiver.decrypt(a), 'control')
  assert.throws(() => receiver.decrypt(c), /顺序/)
  const modified = new Uint8Array(b).slice(); modified[modified.length - 1] ^= 1
  assert.throws(() => receiver.decrypt(modified), /认证失败/)
  assert.deepEqual(receiver.decrypt(b), new Uint8Array([0, 128, 255]))
  assert.throws(() => receiver.decrypt(b), /重放/)
  assert.equal(receiver.decrypt(c), 'end')
})

test('传输能力绑定到认证密钥，旧握手保持原派生方式', () => {
  const key = new Uint8Array(32).fill(1), pairing = randomToken(), challenge = randomToken()
  const hello = { clientPublicKeyB64: randomToken(), clientNonce: randomToken(), acceptBodyEncodings: [], acceptFrameEncodings: ['binary-v1'] }
  const caps = { bodyFrameEncoding: 'binary-v1', responseWindowBytes: 524288 }
  const base = sessionTranscript('test', hello, challenge)
  const bound = sessionTranscript('test', hello, challenge, caps)
  assert.notEqual(bound, base)
  assert.equal(base, sessionTranscript('test', { ...hello, acceptFrameEncodings: [] }, challenge))
  const a = deriveSessionKeys(key, pairing, bound)
  const b = deriveSessionKeys(key, pairing, sessionTranscript('test', hello, challenge, { ...caps, responseWindowBytes: 1 }))
  assert.notDeepEqual(a.clientToServer, b.clientToServer)
})
