export const RELAY_PROTOCOL_VERSION = 2
export const RELAY_CHUNK_BYTES = 256 * 1024

export function buildRelayWebSocketUrl(relayUrl, parameters = {}) {
  const url = new URL(String(relayUrl || '').trim())
  url.searchParams.set('v', String(RELAY_PROTOCOL_VERSION))
  url.searchParams.set('role', parameters.role)
  url.searchParams.set('serverId', parameters.serverId)
  if (parameters.connectionId) url.searchParams.set('connectionId', parameters.connectionId)
  return url.toString()
}

export function splitBytes(value, chunkBytes = RELAY_CHUNK_BYTES) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  const result = []
  for (let offset = 0; offset < bytes.byteLength; offset += chunkBytes) {
    result.push(bytes.subarray(offset, Math.min(bytes.byteLength, offset + chunkBytes)))
  }
  return result
}

export function parseJsonFrame(value) {
  try {
    const parsed = JSON.parse(typeof value === 'string' ? value : new TextDecoder().decode(value))
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
