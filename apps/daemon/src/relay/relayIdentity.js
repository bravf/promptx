import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { generateKeyPair, importPublicKey, importSecretKey } from '../../../../packages/relay/src/index.js'

const IDENTITY_VERSION = 2

function createServerId() {
  return `srv_${crypto.randomBytes(24).toString('base64url')}`
}

function validateIdentity(input) {
  if (!input || input.v !== IDENTITY_VERSION) throw new Error('Relay 身份版本无效。')
  const serverId = String(input.serverId || '').trim()
  if (!/^srv_[A-Za-z0-9_-]{20,}$/.test(serverId)) throw new Error('Relay serverId 无效。')
  importPublicKey(input.publicKeyB64)
  importSecretKey(input.secretKeyB64)
  return {
    v: IDENTITY_VERSION,
    serverId,
    publicKeyB64: String(input.publicKeyB64),
    secretKeyB64: String(input.secretKeyB64),
    createdAt: String(input.createdAt || new Date().toISOString()),
  }
}

export function generateRelayIdentity() {
  const keyPair = generateKeyPair()
  return {
    v: IDENTITY_VERSION,
    serverId: createServerId(),
    publicKeyB64: keyPair.publicKeyB64,
    secretKeyB64: keyPair.secretKeyB64,
    createdAt: new Date().toISOString(),
  }
}

export function writeRelayIdentity(filePath, identity) {
  const normalized = validateIdentity(identity)
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  fs.writeFileSync(temporaryPath, `${JSON.stringify(normalized, null, 2)}\n`, { mode: 0o600 })
  fs.chmodSync(temporaryPath, 0o600)
  fs.renameSync(temporaryPath, filePath)
  fs.chmodSync(filePath, 0o600)
  return normalized
}

export function loadOrCreateRelayIdentity(filePath) {
  try {
    const identity = validateIdentity(JSON.parse(fs.readFileSync(filePath, 'utf8')))
    fs.chmodSync(filePath, 0o600)
    return identity
  } catch {
    return writeRelayIdentity(filePath, generateRelayIdentity())
  }
}

export function resetRelayIdentity(filePath) {
  return writeRelayIdentity(filePath, generateRelayIdentity())
}

export function publicRelayIdentity(identity) {
  return {
    v: identity.v,
    serverId: identity.serverId,
    publicKeyB64: identity.publicKeyB64,
    createdAt: identity.createdAt,
  }
}
