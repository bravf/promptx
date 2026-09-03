import { decodeConnectionOffer } from '@promptx/relay'

const STORAGE_KEY = 'promptx.relay.offer.v2'

function readStoredOffer() {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(STORAGE_KEY)
    return value ? decodeConnectionOffer(value) : null
  } catch {
    return null
  }
}

function consumeLocationOffer() {
  if (typeof window === 'undefined' || !window.location.hash.startsWith('#offer=')) return null
  const encoded = window.location.hash.slice('#offer='.length)
  const offer = decodeConnectionOffer(encoded)
  window.localStorage.setItem(STORAGE_KEY, encoded)
  const cleanUrl = `${window.location.pathname}${window.location.search}`
  window.history.replaceState(window.history.state, '', cleanUrl)
  return offer
}

let activeOffer = null
try {
  activeOffer = consumeLocationOffer() || readStoredOffer()
} catch {
  activeOffer = readStoredOffer()
}

export function getConnectionOffer() {
  return activeOffer
}

export function setConnectionOffer(encoded) {
  const offer = decodeConnectionOffer(encoded)
  if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, encoded)
  activeOffer = offer
  return offer
}

export function clearConnectionOffer() {
  if (typeof window !== 'undefined') window.localStorage.removeItem(STORAGE_KEY)
  activeOffer = null
}

export function hasConnectionOffer() {
  return Boolean(activeOffer)
}

export { STORAGE_KEY as RELAY_OFFER_STORAGE_KEY }
