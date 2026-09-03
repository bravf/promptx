import { getApiBase, request } from './request.js'
import { transportObjectUrl } from './transport.js'

export const v2Api = {
  listProviders: () => request('/api/v2/providers'),
  searchDirectories: (query = '', options = {}) => {
    const search = new URLSearchParams({
      q: query,
      limit: String(options.limit || 20),
    })
    return request(`/api/v2/directories/search?${search}`, {
      cache: 'no-store',
      signal: options.signal,
    })
  },
  listWorkspaces: () => request('/api/v2/workspaces'),
  listWorkspaceFiles: (workspaceId, filePath = '') => request(`/api/v2/workspaces/${workspaceId}/files?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  readWorkspaceFile: (workspaceId, filePath) => request(`/api/v2/workspaces/${workspaceId}/file?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  workspaceFileObjectUrl: (workspaceId, filePath, options = {}) => transportObjectUrl(`${getApiBase()}/api/v2/workspaces/${encodeURIComponent(workspaceId)}/file/content?${new URLSearchParams({ path: filePath })}`, options),
  getWorkspaceGitStatus: (workspaceId) => request(`/api/v2/workspaces/${workspaceId}/git/status`, { cache: 'no-store' }),
  getWorkspaceGitDiff: (workspaceId, filePath) => request(`/api/v2/workspaces/${workspaceId}/git/diff?${new URLSearchParams({ path: filePath })}`, { cache: 'no-store' }),
  createConversation: (input) => request('/api/v2/conversations', { method: 'POST', body: JSON.stringify(input) }),
  deleteWorkspace: (id) => request(`/api/v2/workspaces/${id}`, { method: 'DELETE' }),
  uploadAsset: (workspaceId, file, options = {}) => {
    const body = new FormData()
    body.append('file', file)
    return request(`/api/v2/workspaces/${workspaceId}/assets`, {
      method: 'POST',
      body,
      signal: options.signal,
    })
  },
  assetObjectUrl: (assetId, options = {}) => transportObjectUrl(`${getApiBase()}/api/v2/assets/${encodeURIComponent(assetId)}/content`, options),
  listAgents: (workspaceId) => request(`/api/v2/workspaces/${workspaceId}/agents`),
  createAgent: (workspaceId, input) => request(`/api/v2/workspaces/${workspaceId}/agents`, { method: 'POST', body: JSON.stringify(input) }),
  deleteAgent: (agentId) => request(`/api/v2/agents/${agentId}`, { method: 'DELETE' }),
  getAgentControl: (agentId) => request(`/api/v2/agents/${agentId}/control`, { cache: 'no-store' }),
  updateAgentSettings: (agentId, input) => request(`/api/v2/agents/${agentId}/settings`, {
    method: 'PATCH',
    body: JSON.stringify(input),
  }),
  listTurns: (agentId, limit = 300) => request(`/api/v2/agents/${agentId}/turns?limit=${encodeURIComponent(limit)}`),
  getTimeline: (agentId, options = {}) => {
    const query = new URLSearchParams({
      direction: options.direction || 'tail',
      limit: String(options.limit || 300),
    })
    if (options.cursor) query.set('cursor', options.cursor)
    return request(`/api/v2/agents/${agentId}/timeline?${query}`)
  },
  startTurn: (agentId, content, clientMessageId) => request(`/api/v2/agents/${agentId}/turns`, {
    method: 'POST',
    body: JSON.stringify({ clientMessageId, input: { content } }),
  }),
  cancel: (agentId) => request(`/api/v2/agents/${agentId}/cancel`, { method: 'POST' }),
  clearAgentAttention: (agentId) => request(`/api/v2/agents/${agentId}/attention/clear`, { method: 'POST' }),
  getRelayConfig: () => request('/api/v2/relay/config', { cache: 'no-store' }),
  updateRelayConfig: (input) => request('/api/v2/relay/config', { method: 'PUT', body: JSON.stringify(input) }),
  reconnectRelay: () => request('/api/v2/relay/reconnect', { method: 'POST' }),
  resetRelayIdentity: () => request('/api/v2/relay/identity/reset', { method: 'POST' }),
}

export function agentEventsUrl(agentId, cursor = '') {
  const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''
  return `${getApiBase()}/api/v2/agents/${agentId}/events${query}`
}

export function globalEventsUrl() {
  return `${getApiBase()}/api/v2/events`
}
