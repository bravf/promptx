import nacl from 'tweetnacl'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

const TEXT_PAYLOAD = 1
const BINARY_PAYLOAD = 2
const NONCE_BYTES = nacl.box.nonceLength
const PUBLIC_KEY_BYTES = nacl.box.publicKeyLength
const SECRET_KEY_BYTES = nacl.box.secretKeyLength

function bytesToBase64(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return globalThis.btoa(binary)
}

function base64ToBytes(value) {
  const normalized = String(value || '').trim()
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(normalized)
  const binary = globalThis.atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toArrayBuffer(bytes) {
  const result = new Uint8Array(bytes.byteLength)
  result.set(bytes)
  return result.buffer
}

function normalizeBytes(value) {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
  throw new TypeError('Expected binary data.')
}

function importKey(value, expectedBytes, label) {
  const bytes = base64ToBytes(value)
  if (bytes.byteLength !== expectedBytes) {
    throw new Error(`${label} 长度无效。`)
  }
  return bytes
}

export function generateKeyPair() {
  const pair = nacl.box.keyPair()
  return {
    publicKey: pair.publicKey,
    secretKey: pair.secretKey,
    publicKeyB64: bytesToBase64(pair.publicKey),
    secretKeyB64: bytesToBase64(pair.secretKey),
  }
}

export function importPublicKey(value) {
  return importKey(value, PUBLIC_KEY_BYTES, 'Curve25519 公钥')
}

export function importSecretKey(value) {
  return importKey(value, SECRET_KEY_BYTES, 'Curve25519 私钥')
}

export function deriveSharedKey(secretKey, peerPublicKey) {
  const secret = normalizeBytes(secretKey)
  const publicKey = normalizeBytes(peerPublicKey)
  if (secret.byteLength !== SECRET_KEY_BYTES || publicKey.byteLength !== PUBLIC_KEY_BYTES) {
    throw new Error('Curve25519 密钥长度无效。')
  }
  const rawShared = nacl.scalarMult(secret, publicKey)
  if (rawShared.every(byte => byte === 0)) throw new Error('拒绝低阶 Curve25519 公钥。')
  const sharedKey = nacl.box.before(publicKey, secret)
  if (!sharedKey?.byteLength) throw new Error('无法派生共享密钥。')
  return sharedKey
}

export class NonceReplayWindow {
  constructor(maxSize = 16_384) {
    this.maxSize = Math.max(1, Number(maxSize) || 16_384)
    this.values = new Set()
  }

  get size() {
    return this.values.size
  }

  has(value) {
    return this.values.has(value)
  }

  add(value) {
    if (this.values.has(value)) return this
    this.values.add(value)
    while (this.values.size > this.maxSize) this.values.delete(this.values.values().next().value)
    return this
  }
}

export function encryptPayload(sharedKey, payload) {
  const key = normalizeBytes(sharedKey)
  const isText = typeof payload === 'string'
  const content = isText ? new TextEncoder().encode(payload) : normalizeBytes(payload)
  const plaintext = new Uint8Array(content.byteLength + 1)
  plaintext[0] = isText ? TEXT_PAYLOAD : BINARY_PAYLOAD
  plaintext.set(content, 1)
  const nonce = nacl.randomBytes(NONCE_BYTES)
  const ciphertext = nacl.box.after(plaintext, nonce, key)
  const bundle = new Uint8Array(nonce.byteLength + ciphertext.byteLength)
  bundle.set(nonce, 0)
  bundle.set(ciphertext, nonce.byteLength)
  return toArrayBuffer(bundle)
}

export function decryptPayload(sharedKey, payload, seenNonces = null) {
  const bytes = normalizeBytes(payload)
  if (bytes.byteLength <= NONCE_BYTES) throw new Error('加密帧长度无效。')
  const nonce = bytes.subarray(0, NONCE_BYTES)
  const nonceKey = seenNonces ? bytesToBase64(nonce) : ''
  if (seenNonces?.has(nonceKey)) throw new Error('检测到重复加密帧。')
  const plaintext = nacl.box.open.after(bytes.subarray(NONCE_BYTES), nonce, normalizeBytes(sharedKey))
  if (!plaintext?.byteLength) throw new Error('加密帧认证失败。')
  if (seenNonces) seenNonces.add(nonceKey)
  const content = plaintext.subarray(1)
  if (plaintext[0] === TEXT_PAYLOAD) return new TextDecoder().decode(content)
  if (plaintext[0] === BINARY_PAYLOAD) return toArrayBuffer(content)
  throw new Error('加密帧类型无效。')
}

export function encodeBase64(bytes) {
  return bytesToBase64(normalizeBytes(bytes))
}

export function decodeBase64(value) {
  return toArrayBuffer(base64ToBytes(value))
}

export function generateSigningKeyPair() {
  const pair = nacl.sign.keyPair()
  return { publicKeyB64: encodeBase64(pair.publicKey), secretKeyB64: encodeBase64(pair.secretKey) }
}
export function signingServerId(publicKeyB64) {
  const key = importKey(publicKeyB64, 32, '身份公钥')
  return `srv_${encodeBase64(key).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')}`
}
export function signChallenge(secretKeyB64, transcript) {
  return encodeBase64(nacl.sign.detached(new TextEncoder().encode(transcript), importKey(secretKeyB64, 64, '身份私钥')))
}
export function verifyChallenge(publicKeyB64, transcript, signatureB64) {
  try { return nacl.sign.detached.verify(new TextEncoder().encode(transcript), importKey(signatureB64, 64, '签名'), importKey(publicKeyB64, 32, '身份公钥')) } catch { return false }
}
export function randomToken() { return encodeBase64(nacl.randomBytes(32)) }
export function validateToken(value) { return importKey(value, 32, '配对密钥/挑战') }
export function relayAuthTranscript(serverId, connectionId, challenge) {
  return JSON.stringify(['promptx-relay-auth', 3, serverId, connectionId || '', challenge])
}
export function sessionTranscript(serverId, hello, challenge, capabilities = null) {
  validateToken(hello.clientNonce)
  validateToken(challenge)
  const transcript = ['promptx-session', 3, serverId, hello.clientPublicKeyB64, hello.clientNonce, challenge, hello.acceptBodyEncodings || []]
  if (capabilities) transcript.push(hello.acceptFrameEncodings || [], capabilities)
  return JSON.stringify(transcript)
}
export function deriveSessionKeys(sharedKey, pairingKeyB64, transcript) {
  const shared = normalizeBytes(sharedKey)
  if (shared.byteLength !== 32) throw new Error('共享密钥长度无效。')
  const pair = validateToken(pairingKeyB64)
  const inputKey = new Uint8Array(64)
  inputKey.set(shared); inputKey.set(pair, 32)
  const salt = sha256(new TextEncoder().encode(transcript))
  const derive = direction => hkdf(sha256, inputKey, salt, new TextEncoder().encode(`promptx-v3:${direction}`), 32)
  return { clientToServer: derive('client-to-server'), serverToClient: derive('server-to-client') }
}

export class SessionCipher {
  constructor(sendKey, receiveKey) { this.sendKey = sendKey; this.receiveKey = receiveKey; this.sent = 0; this.received = 0 }
  encrypt(payload) {
    if (!Number.isSafeInteger(this.sent + 1)) throw new Error('会话序号耗尽。')
    return encryptPayload(this.sendKey, JSON.stringify({ seq: ++this.sent, payload }))
  }
  encryptBinary(payload) {
    if (!Number.isSafeInteger(this.sent + 1)) throw new Error('会话序号耗尽。')
    const bytes = normalizeBytes(payload)
    const frame = new Uint8Array(8 + bytes.byteLength)
    new DataView(frame.buffer).setFloat64(0, ++this.sent)
    frame.set(bytes, 8)
    return encryptPayload(this.sendKey, frame)
  }
  decrypt(bytes) {
    const payload = decryptPayload(this.receiveKey, bytes)
    let frame
    if (typeof payload === 'string') frame = JSON.parse(payload)
    else {
      if (payload.byteLength < 8) throw new Error('会话二进制帧无效。')
      frame = { seq: new DataView(payload).getFloat64(0), payload: new Uint8Array(payload, 8) }
    }
    if (!Number.isSafeInteger(frame.seq) || frame.seq !== this.received + 1) throw new Error('会话帧重放或顺序无效。')
    this.received = frame.seq
    return frame.payload
  }
}
