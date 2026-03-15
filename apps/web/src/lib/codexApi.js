import { getApiBase, request } from './request.js'

const API_BASE = getApiBase()

export function listCodexSessions() {
  return request('/api/codex/sessions')
}

export function listCodexWorkspaces() {
  return request('/api/codex/workspaces')
}

export function createCodexSession(payload) {
  return request('/api/codex/sessions', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateCodexSession(sessionId, payload) {
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'PATCH',
    body: JSON.stringify(payload),
  })
}

export function deleteCodexSession(sessionId) {
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
  })
}

export function listCodexSessionFiles(sessionId, options = {}) {
  const params = new URLSearchParams()
  const targetPath = String(options.path || '').trim()
  const refreshToken = String(options.refreshToken || '').trim()

  if (targetPath) {
    params.set('path', targetPath)
  }
  if (refreshToken) {
    params.set('_', refreshToken)
  }

  const query = params.toString()
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/files/tree${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  })
}

export function searchCodexSessionFiles(sessionId, query, options = {}) {
  const params = new URLSearchParams()
  const keyword = String(query || '').trim()
  const limit = Number(options.limit || 60)
  const refreshToken = String(options.refreshToken || '').trim()

  if (keyword) {
    params.set('q', keyword)
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }
  if (refreshToken) {
    params.set('_', refreshToken)
  }

  const search = params.toString()
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/files/search${search ? `?${search}` : ''}`, {
    cache: 'no-store',
  })
}

export function sendPromptToCodexSession(sessionId, payload) {
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/send`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function updateTaskCodexSession(taskSlug, sessionId) {
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-session`, {
    method: 'POST',
    body: JSON.stringify({ sessionId }),
  })
}

export function listTaskCodexRuns(taskSlug, options = {}) {
  const params = new URLSearchParams()
  const limit = Number(options.limit || 20)

  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }

  const query = params.toString()
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  })
}

export function createTaskCodexRun(taskSlug, payload) {
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function clearTaskCodexRuns(taskSlug) {
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
    method: 'DELETE',
  })
}

export function stopCodexRun(runId) {
  return request(`/api/codex/runs/${encodeURIComponent(runId)}/stop`, {
    method: 'POST',
  })
}

export async function streamCodexRun(runId, options = {}) {
  const params = new URLSearchParams()
  const afterSeq = Math.max(0, Number(options.afterSeq) || 0)
  if (afterSeq) {
    params.set('afterSeq', String(afterSeq))
  }

  const query = params.toString()
  const response = await fetch(`${API_BASE}/api/codex/runs/${encodeURIComponent(runId)}/stream${query ? `?${query}` : ''}`, {
    method: 'GET',
    signal: options.signal,
  })

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}))
    throw new Error(errorPayload.message || '请求失败。')
  }

  if (!response.body) {
    throw new Error('浏览器不支持流式响应。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (line) {
        const event = JSON.parse(line)
        options.onEvent?.(event)
      }

      newlineIndex = buffer.indexOf('\n')
    }

    if (done) {
      const tail = buffer.trim()
      if (tail) {
        const event = JSON.parse(tail)
        options.onEvent?.(event)
      }
      break
    }
  }
}

export async function streamPromptToCodexSession(sessionId, payload, options = {}) {
  const response = await fetch(`${API_BASE}/api/codex/sessions/${encodeURIComponent(sessionId)}/send-stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal: options.signal,
  })

  if (!response.ok) {
    const errorPayload = await response.json().catch(() => ({}))
    throw new Error(errorPayload.message || '请求失败。')
  }

  if (!response.body) {
    throw new Error('浏览器不支持流式响应。')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { value, done } = await reader.read()
    buffer += decoder.decode(value || new Uint8Array(), { stream: !done })

    let newlineIndex = buffer.indexOf('\n')
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)

      if (line) {
        const event = JSON.parse(line)
        options.onEvent?.(event)
      }

      newlineIndex = buffer.indexOf('\n')
    }

    if (done) {
      const tail = buffer.trim()
      if (tail) {
        const event = JSON.parse(tail)
        options.onEvent?.(event)
      }
      break
    }
  }
}
