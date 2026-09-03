import nacl from 'tweetnacl'

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
  const binary = globalThis.atob(normalized)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
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
  const sharedKey = nacl.box.before(publicKey, secret)
  if (!sharedKey?.byteLength) throw new Error('无法派生共享密钥。')
  return sharedKey
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
