import { transportFetch } from './transport.js'

const importMetaEnv = typeof import.meta !== 'undefined' && import.meta.env ? import.meta.env : {}

function resolveDefaultApiBase() {
  if (typeof window === 'undefined') {
    return 'http://localhost:3001'
  }

  const url = new URL(window.location.origin)
  const explicitApiPort = String(importMetaEnv.VITE_API_PORT || '').trim()
  if (explicitApiPort) {
    url.port = explicitApiPort
    return url.toString().replace(/\/$/, '')
  }

  const currentPort = String(url.port || '')
  const viteDevPorts = new Set(['4173', '5173', '5174', '5175'])
  if (importMetaEnv.DEV === true || viteDevPorts.has(currentPort)) {
    url.port = '3001'
    return url.toString().replace(/\/$/, '')
  }

  return url.toString().replace(/\/$/, '')
}

function getApiBaseInternal() {
  return (importMetaEnv.VITE_API_BASE_URL || resolveDefaultApiBase()).replace(/\/$/, '')
}

export function resolveRequestErrorMessage(payload = {}, fallbackKey = 'errors.requestFailed') {
  return payload?.message || (fallbackKey === 'errors.requestFailed' ? '请求失败，请稍后重试。' : fallbackKey)
}

export async function request(path, options = {}) {
  const hasJsonBody = typeof options.body !== 'undefined' && !(options.body instanceof FormData)
  const response = await transportFetch(`${getApiBaseInternal()}${path}`, {
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    const error = new Error(resolveRequestErrorMessage(payload))
    error.code = payload?.error || ''
    error.statusCode = response.status
    error.details = payload
    throw error
  }

  if (response.status === 204) {
    return null
  }

  const type = response.headers.get('content-type') || ''
  if (type.includes('application/json')) {
    return response.json()
  }
  return response.text()
}

export function getApiBase() {
  return getApiBaseInternal()
}

export function resolveAssetUrl(url) {
  if (!url) {
    return ''
  }

  if (url.startsWith('http')) {
    try {
      const parsed = new URL(url)
      if (
        typeof window !== 'undefined'
        && (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1')
      ) {
        const current = new URL(window.location.origin)
        parsed.hostname = current.hostname
        parsed.port = current.port
        parsed.protocol = current.protocol
        return parsed.toString()
      }
    } catch {
      // ignore
    }
    return url
  }

  return `${getApiBaseInternal()}${url}`
}
