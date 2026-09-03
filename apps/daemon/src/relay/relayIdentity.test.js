import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { importPublicKey, importSecretKey } from '../../../../packages/relay/src/index.js'
import { loadOrCreateRelayIdentity, resetRelayIdentity } from './relayIdentity.js'

test('Relay 身份持久化、权限收紧，重置后旧身份失效', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-relay-identity-'))
  const filePath = path.join(directory, 'identity.json')
  const first = loadOrCreateRelayIdentity(filePath)
  const restored = loadOrCreateRelayIdentity(filePath)

  assert.deepEqual(restored, first)
  assert.match(first.serverId, /^srv_[A-Za-z0-9_-]{20,}$/)
  assert.equal(importPublicKey(first.publicKeyB64).byteLength, 32)
  assert.equal(importSecretKey(first.secretKeyB64).byteLength, 32)
  if (process.platform !== 'win32') assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)

  const reset = resetRelayIdentity(filePath)
  assert.notEqual(reset.serverId, first.serverId)
  assert.notEqual(reset.publicKeyB64, first.publicKeyB64)
  assert.notEqual(reset.secretKeyB64, first.secretKeyB64)
})
