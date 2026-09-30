import { EncryptedRelayConnection } from './relayConnection.js'
import { getConnectionOffer, hasConnectionOffer } from './relayOffer.js'
import { createRelayTransportPool } from './relayTransportPool.js'

const pool = createRelayTransportPool({ getOffer: getConnectionOffer, createConnection: offer => new EncryptedRelayConnection(offer) })

function getRelayConnection() {
  return pool.getControl()
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
    return pool.request(`${parsed.pathname}${parsed.search}`, options)
  }
  return fetch(url, options)
}

export async function transportObjectUrl(url, options = {}) {
  const response = await transportFetch(url, options)
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(typeof detail?.message === 'string' ? detail.message : `资源加载失败（${response.status}）`)
  }
  return URL.createObjectURL(await response.blob())
}
