const API_BASE = (import.meta.env.VITE_API_BASE_URL || 'http://localhost:3000').replace(/\/$/, '')

async function request(path, options = {}) {
  const hasJsonBody = typeof options.body !== 'undefined' && !(options.body instanceof FormData)
  const response = await fetch(`${API_BASE}${path}`, {
    headers: {
      ...(hasJsonBody ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message || 'Request failed.')
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
  return API_BASE
}

export function resolveAssetUrl(url) {
  if (!url) {
    return ''
  }
  return url.startsWith('http') ? url : `${API_BASE}${url}`
}

export function listDocuments() {
  return request('/api/documents')
}

export function createDocument(payload) {
  return request('/api/documents', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function getDocument(slug) {
  return request(`/api/documents/${slug}`)
}

export function updateDocument(slug, payload) {
  return request(`/api/documents/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteDocument(slug) {
  return request(`/api/documents/${slug}`, {
    method: 'DELETE',
  })
}

export async function uploadImage(file) {
  const body = new FormData()
  body.append('file', file)

  const response = await fetch(`${API_BASE}/api/uploads`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message || 'Upload failed.')
  }

  return response.json()
}

export async function importPdf(file) {
  const body = new FormData()
  body.append('file', file)

  const response = await fetch(`${API_BASE}/api/imports/pdf`, {
    method: 'POST',
    body,
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(payload.message || 'PDF import failed.')
  }

  return response.json()
}

export function fetchRawDocument(slug) {
  return request(`/p/${slug}/raw`)
}
