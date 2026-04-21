import { normalizeCodexRunEventsMode } from '../../../../packages/shared/src/index.js'
import { getApiBase, request, resolveRequestErrorMessage } from './request.js'
import { translate } from '../composables/useI18n.js'

const API_BASE = getApiBase()

export function listCodexSessions() {
  return request('/api/codex/sessions')
}

export function listCodexWorkspaces(options = {}) {
  const params = new URLSearchParams()
  const engine = String(options.engine || '').trim()

  if (engine) {
    params.set('engine', engine)
  }

  const query = params.toString()
  return request(`/api/codex/workspaces${query ? `?${query}` : ''}`)
}

export function listAgentSessionCandidates(options = {}) {
  const params = new URLSearchParams()
  const engine = String(options.engine || '').trim()
  const cwd = String(options.cwd || '').trim()
  const limit = Number(options.limit || 0)

  if (engine) {
    params.set('engine', engine)
  }
  if (cwd) {
    params.set('cwd', cwd)
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }

  const query = params.toString()
  return request(`/api/codex/session-candidates${query ? `?${query}` : ''}`, {
    cache: 'no-store',
    signal: options.signal,
  })
}

export function listCodexDirectoryTree(options = {}) {
  const params = new URLSearchParams()
  const targetPath = String(options.path || '').trim()
  const limit = Number(options.limit || 0)

  if (targetPath) {
    params.set('path', targetPath)
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }

  const query = params.toString()
  return request(`/api/codex/directories/tree${query ? `?${query}` : ''}`, {
    cache: 'no-store',
    signal: options.signal,
  })
}

export function searchCodexDirectories(query, options = {}) {
  const params = new URLSearchParams()
  const keyword = String(query || '').trim()
  const targetPath = String(options.path || '').trim()
  const limit = Number(options.limit || 0)

  if (keyword) {
    params.set('q', keyword)
  }
  if (targetPath) {
    params.set('path', targetPath)
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }

  const search = params.toString()
  return request(`/api/codex/directories/search${search ? `?${search}` : ''}`, {
    cache: 'no-store',
    signal: options.signal,
  })
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

export function resetCodexSession(sessionId) {
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/reset`, {
    method: 'POST',
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
    signal: options.signal,
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
    signal: options.signal,
  })
}

export function getCodexSessionFileContent(sessionId, options = {}) {
  const params = new URLSearchParams()
  const targetPath = String(options.path || '').trim()
  const limit = Number(options.limit || 0)
  const refreshToken = String(options.refreshToken || '').trim()

  if (targetPath) {
    params.set('path', targetPath)
  }
  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }
  if (refreshToken) {
    params.set('_', refreshToken)
  }

  const query = params.toString()
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/files/content${query ? `?${query}` : ''}`, {
    cache: 'no-store',
    signal: options.signal,
  })
}

export function searchCodexSessionFileContent(sessionId, query, options = {}) {
  const params = new URLSearchParams()
  const keyword = String(query || '').trim()
  const limit = Number(options.limit || 80)
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
  return request(`/api/codex/sessions/${encodeURIComponent(sessionId)}/files/content-search${search ? `?${search}` : ''}`, {
    cache: 'no-store',
    signal: options.signal,
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
  const events = normalizeCodexRunEventsMode(options.events, options)

  if (Number.isFinite(limit) && limit > 0) {
    params.set('limit', String(limit))
  }
  params.set('events', events)

  const query = params.toString()
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  })
}

export function listCodexRunEvents(runId, options = {}) {
  const params = new URLSearchParams()
  const afterSeq = Math.max(0, Number(options.afterSeq) || 0)
  const limit = Math.max(1, Number(options.limit) || 5000)

  if (afterSeq > 0) {
    params.set('afterSeq', String(afterSeq))
  }
  if (limit > 0) {
    params.set('limit', String(limit))
  }

  const query = params.toString()
  return request(`/api/codex/runs/${encodeURIComponent(runId)}/events${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  })
}

export function getTaskGitDiff(taskSlug, options = {}) {
  const params = new URLSearchParams()
  const scope = String(options.scope || 'workspace').trim()
  const runId = String(options.runId || '').trim()
  const filePath = String(options.filePath || '').trim()
  const includeFiles = options.includeFiles !== false
  const includeStats = options.includeStats !== false
  const timeoutMs = Math.max(0, Number(options.timeoutMs) || 0)

  if (scope === 'run') {
    params.set('scope', 'run')
  } else if (scope === 'task') {
    params.set('scope', 'task')
  } else {
    params.set('scope', 'workspace')
  }

  if (runId) {
    params.set('runId', runId)
  }
  if (filePath) {
    params.set('filePath', filePath)
  }
  if (!includeFiles) {
    params.set('includeFiles', 'false')
  }
  if (!includeStats) {
    params.set('includeStats', 'false')
  }
  if (timeoutMs > 0) {
    params.set('timeoutMs', String(timeoutMs))
  }

  const query = params.toString()
  return request(`/api/tasks/${encodeURIComponent(taskSlug)}/git-diff${query ? `?${query}` : ''}`, {
    cache: 'no-store',
  })
}

export function buildTaskGitDiffBlobUrl(taskSlug, options = {}) {
  const params = new URLSearchParams()
  const scope = options.scope === 'run' ? 'run' : options.scope === 'task' ? 'task' : 'workspace'
  const runId = String(options.runId || '').trim()
  const filePath = String(options.filePath || '').trim()
  const side = String(options.side || '').trim() === 'before' ? 'before' : 'after'

  params.set('scope', scope)
  params.set('side', side)
  if (runId) {
    params.set('runId', runId)
  }
  if (filePath) {
    params.set('filePath', filePath)
  }

  const query = params.toString()
  return `${API_BASE}/api/tasks/${encodeURIComponent(taskSlug)}/git-diff/blob${query ? `?${query}` : ''}`
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
    throw new Error(resolveRequestErrorMessage(errorPayload))
  }

  if (!response.body) {
    throw new Error(translate('errors.streamUnsupported'))
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
