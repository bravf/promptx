export const RELAY_PROTOCOL_VERSION = 3
export const RELAY_CHUNK_BYTES = 256 * 1024
export const RELAY_BODY_FRAME_ENCODING = 'binary-v1'
export const RELAY_RESPONSE_WINDOW_BYTES = 512 * 1024

export function encodeBodyFrame(type, requestId, value) {
  const kind = type === 'request.body' ? 1 : type === 'response.body' ? 2 : 0
  if (!kind || !/^req_[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error('Relay 正文帧头无效。')
  const id = new TextEncoder().encode(requestId)
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.byteLength > RELAY_CHUNK_BYTES) throw new Error('Relay 正文分块过大。')
  const frame = new Uint8Array(5 + id.length + bytes.length)
  frame.set([0x50, 0x58, 1, kind, id.length])
  frame.set(id, 5)
  frame.set(bytes, 5 + id.length)
  return frame
}

export function decodeBodyFrame(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value)
  if (bytes.length < 5 || bytes[0] !== 0x50 || bytes[1] !== 0x58 || bytes[2] !== 1 || ![1, 2].includes(bytes[3])) throw new Error('Relay 正文帧格式无效。')
  const offset = 5 + bytes[4]
  if (offset > bytes.length || bytes.length - offset > RELAY_CHUNK_BYTES) throw new Error('Relay 正文帧长度无效。')
  const requestId = new TextDecoder().decode(bytes.subarray(5, offset))
  if (!/^req_[A-Za-z0-9_-]{12,128}$/.test(requestId)) throw new Error('Relay 请求标识无效。')
  return { type: bytes[3] === 1 ? 'request.body' : 'response.body', requestId, bytes: bytes.subarray(offset) }
}

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
