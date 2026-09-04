const DEFAULT_ALLOWED_ORIGINS = [
  'http://127.0.0.1:3001',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:5174',
  'http://localhost:3001',
  'http://localhost:5173',
  'http://localhost:5174',
  'http://[::1]:3001',
  'http://[::1]:5173',
  'http://[::1]:5174',
]

function parseOrigins(value) {
  if (Array.isArray(value)) return value
  return String(value || '').split(/[\s,]+/)
}

function normalizeOrigin(value) {
  const input = String(value || '').trim()
  if (!input) return ''
  try {
    const url = new URL(input)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) return ''
    return url.origin
  } catch {
    return ''
  }
}

export function createCorsPolicy(allowedOrigins = process.env.PROMPTX_ALLOWED_ORIGINS) {
  const configured = parseOrigins(allowedOrigins).map(normalizeOrigin).filter(Boolean)
  const allowed = new Set([...DEFAULT_ALLOWED_ORIGINS, ...configured])
  return {
    allowedOrigins: [...allowed],
    allows(origin) {
      if (!origin) return true
      const normalized = normalizeOrigin(origin)
      return Boolean(normalized && allowed.has(normalized))
    },
  }
}
