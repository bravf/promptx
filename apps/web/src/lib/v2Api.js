import { getApiBase, request } from './request.js'
import { transportObjectUrl } from './transport.js'

export const v2Api = {
  listProjects: () => request('/api/v2/projects', { cache: 'no-store' }),
  createProject: (input) => request('/api/v2/projects', { method: 'POST', body: JSON.stringify(input) }),
  getProject: (projectId) => request(`/api/v2/projects/${encodeURIComponent(projectId)}`, { cache: 'no-store' }),
  updateProject: (projectId, input) => request(`/api/v2/projects/${encodeURIComponent(projectId)}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteProject: (projectId) => request(`/api/v2/projects/${encodeURIComponent(projectId)}`, { method: 'DELETE' }),
  listProjectTasks: (projectId) => request(`/api/v2/projects/${encodeURIComponent(projectId)}/tasks`, { cache: 'no-store' }),
  createTask: (projectId, input) => request(`/api/v2/projects/${encodeURIComponent(projectId)}/tasks`, { method: 'POST', body: JSON.stringify(input) }),
  getTask: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}`, { cache: 'no-store' }),
  getTaskEnvironment: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/environment`, { cache: 'no-store' }),
  getTaskAgent: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/agent`, { cache: 'no-store' }),
  getTaskControl: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/control`, { cache: 'no-store' }),
  updateTaskSettings: (taskId, input) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/settings`, { method: 'PATCH', body: JSON.stringify(input) }),
  listTaskTurns: (taskId, limit = 300) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/turns?limit=${encodeURIComponent(limit)}`, { cache: 'no-store' }),
  startTaskTurn: (taskId, content, clientMessageId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/turns`, { method: 'POST', body: JSON.stringify({ clientMessageId, input: { content } }) }),
  cancelTask: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/cancel`, { method: 'POST' }),
  clearTaskAttention: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/attention/clear`, { method: 'POST' }),
  getTaskTimeline: (taskId, options = {}) => {
    const query = new URLSearchParams({ direction: options.direction || 'tail', limit: String(options.limit || 300) })
    if (options.cursor) query.set('cursor', options.cursor)
    return request(`/api/v2/tasks/${encodeURIComponent(taskId)}/timeline?${query}`)
  },
  syncTaskTimeline: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/timeline/sync`, { method: 'POST' }),
  listTaskFiles: (taskId, filePath = '') => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/files?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  readTaskFile: (taskId, filePath) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/file?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  taskFileObjectUrl: (taskId, filePath, options = {}) => transportObjectUrl(`${getApiBase()}/api/v2/tasks/${encodeURIComponent(taskId)}/file/content?${new URLSearchParams({ path: filePath })}`, options),
  getTaskGitStatus: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/status`, { cache: 'no-store' }),
  getTaskGitDiff: (taskId, filePath = '') => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/diff?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  getTaskCommits: (taskId, limit = 50) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/commits?limit=${encodeURIComponent(limit)}`, { cache: 'no-store' }),
  commitTask: (taskId, message) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/commit`, { method: 'POST', body: JSON.stringify({ message }) }),
  pushTask: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/push`, { method: 'POST' }),
  mergeTask: (taskId, input = {}) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/git/merge`, { method: 'POST', body: JSON.stringify(input) }),
  uploadTaskAsset: (taskId, file, options = {}) => {
    const body = new FormData()
    body.append('file', file)
    return request(`/api/v2/tasks/${encodeURIComponent(taskId)}/assets`, { method: 'POST', body, signal: options.signal })
  },
  archiveTask: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/archive`, { method: 'POST' }),
  reconcileTaskEnvironment: (taskId) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/environment/reconcile`, { method: 'POST' }),
  rebindTaskEnvironment: (taskId, input) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/environment/rebind`, { method: 'POST', body: JSON.stringify(input) }),
  copyTask: (taskId, input = {}) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}/copy`, { method: 'POST', body: JSON.stringify(input) }),
  deleteTask: (taskId, input = undefined) => request(`/api/v2/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    ...(input ? { body: JSON.stringify(input) } : {}),
  }),
  listProviders: () => request('/api/v2/providers'),
  listImportableSessions: (options = {}) => {
    const query = new URLSearchParams()
    if (options.providerId) query.set('providerId', options.providerId)
    if (options.query) query.set('q', options.query)
    if (options.limit) query.set('limit', String(options.limit))
    return request(`/api/v2/import/sessions?${query}`, { cache: 'no-store', signal: options.signal })
  },
  importSession: (input) => request('/api/v2/import/sessions', { method: 'POST', body: JSON.stringify(input) }),
  searchDirectories: (query = '', options = {}) => request(`/api/v2/directories/search?${new URLSearchParams({
    q: query,
    limit: String(options.limit || 20),
  })}`, { cache: 'no-store', signal: options.signal }),
  assetObjectUrl: (assetId, options = {}) => transportObjectUrl(`${getApiBase()}/api/v2/assets/${encodeURIComponent(assetId)}/content`, options),
  getRelayConfig: () => request('/api/v2/relay/config', { cache: 'no-store' }),
  updateRelayConfig: (input) => request('/api/v2/relay/config', { method: 'PUT', body: JSON.stringify(input) }),
  reconnectRelay: () => request('/api/v2/relay/reconnect', { method: 'POST' }),
  resetRelayIdentity: () => request('/api/v2/relay/identity/reset', { method: 'POST' }),
}

export function taskEventsUrl(taskId, cursor = '') {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return `${getApiBase()}/api/v2/tasks/${encodeURIComponent(taskId)}/events${query}`
}

export function globalEventsUrl() {
  return `${getApiBase()}/api/v2/events`
}
