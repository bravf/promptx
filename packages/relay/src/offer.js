const OFFER_VERSION = 2
const OFFER_PREFIX = '#offer='

function bytesToBase64Url(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlToBytes(value) {
  const base64 = String(value || '').replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = globalThis.atob(padded)
  return Uint8Array.from(binary, (character) => character.charCodeAt(0))
}

export function validateConnectionOffer(input) {
  if (!input || input.v !== OFFER_VERSION) throw new Error('不支持的 Relay Offer 版本。')
  const serverId = String(input.serverId || '').trim()
  const daemonPublicKeyB64 = String(input.daemonPublicKeyB64 || '').trim()
  const relayUrl = String(input.relay?.url || '').trim()
  if (!/^srv_[A-Za-z0-9_-]{20,}$/.test(serverId)) throw new Error('Relay serverId 无效。')
  if (!daemonPublicKeyB64) throw new Error('Relay daemon 公钥缺失。')
  let parsedRelayUrl
  try {
    parsedRelayUrl = new URL(relayUrl)
  } catch {
    throw new Error('Relay WebSocket 地址无效。')
  }
  if (!['ws:', 'wss:'].includes(parsedRelayUrl.protocol)) throw new Error('Relay 地址必须使用 ws 或 wss。')
  return {
    v: OFFER_VERSION,
    serverId,
    daemonPublicKeyB64,
    relay: { url: parsedRelayUrl.toString() },
  }
}

export function encodeConnectionOffer(offer) {
  const json = JSON.stringify(validateConnectionOffer(offer))
  return bytesToBase64Url(new TextEncoder().encode(json))
}

export function decodeConnectionOffer(encoded) {
  try {
    return validateConnectionOffer(JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded))))
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Relay')) throw error
    throw new Error('Relay Offer 无法解析。')
  }
}

export function createConnectionOfferUrl(appUrl, offer) {
  const base = new URL(String(appUrl || '').trim())
  base.hash = `offer=${encodeConnectionOffer(offer)}`
  return base.toString()
}

export function parseConnectionOfferUrl(input) {
  const url = new URL(String(input || '').trim())
  if (!url.hash.startsWith(OFFER_PREFIX)) return null
  return decodeConnectionOffer(url.hash.slice(OFFER_PREFIX.length))
}

export { OFFER_VERSION }
