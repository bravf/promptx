import { EncryptedRelayConnection } from './relayConnection.js'
import { getConnectionOffer, hasConnectionOffer } from './relayOffer.js'

let relayConnection = null

function getRelayConnection() {
  if (!relayConnection && hasConnectionOffer()) relayConnection = new EncryptedRelayConnection(getConnectionOffer())
  return relayConnection
}

export function isRemoteTransport() {
  return hasConnectionOffer()
}

export function transportStatus() {
  return getRelayConnection()?.snapshot() || { state: 'local', error: '', connectedAt: '' }
}

export function subscribeTransportStatus(listener) {
  const connection = getRelayConnection()
  if (!connection) {
    listener(transportStatus())
    return () => {}
  }
  return connection.subscribe(listener)
}

export function reconnectTransport() {
  const connection = getRelayConnection()
  if (!connection) return Promise.resolve()
  connection.socket?.close(4001, 'manual_reconnect')
  return connection.connect()
}

export function transportFetch(url, options = {}) {
  const connection = getRelayConnection()
  if (connection) {
    const parsed = new URL(url, typeof window === 'undefined' ? 'http://localhost' : window.location.origin)
    return connection.request(`${parsed.pathname}${parsed.search}`, options)
  }
  return fetch(url, options)
}

export async function transportObjectUrl(url, options = {}) {
  const response = await transportFetch(url, options)
  if (!response.ok) throw new Error(`资源加载失败（${response.status}）`)
  return URL.createObjectURL(await response.blob())
}
