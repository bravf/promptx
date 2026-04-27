import { request } from './request.js'

export function getMeta() {
  return request('/api/meta', {
    cache: 'no-store',
  })
}

export function listTasks() {
  return request('/api/tasks')
}

export function listTaskWorkspaceDiffSummaries(input = 30) {
  const options = typeof input === 'object' && input !== null
    ? input
    : { limit: input }
  const params = new URLSearchParams()
  const normalizedLimit = Math.max(1, Number(options.limit) || 30)
  params.set('limit', String(normalizedLimit))
  ;(options.slugs || []).forEach((slug) => {
    const normalizedSlug = String(slug || '').trim()
    if (normalizedSlug) {
      params.append('slug', normalizedSlug)
    }
  })

  return request(`/api/tasks/workspace-diff-summaries?${params.toString()}`, {
    cache: 'no-store',
  })
}

export function createTask(payload) {
  return request('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(payload),
  })
}

export function reorderTasks(slugs = []) {
  return request('/api/tasks/reorder', {
    method: 'POST',
    body: JSON.stringify({ slugs }),
  })
}

export function getTask(slug) {
  return request(`/api/tasks/${slug}`)
}

export function updateTask(slug, payload) {
  return request(`/api/tasks/${slug}`, {
    method: 'PUT',
    body: JSON.stringify(payload),
  })
}

export function deleteTask(slug) {
  return request(`/api/tasks/${slug}`, {
    method: 'DELETE',
  })
}

export function fetchRawTask(slug) {
  return request(`/api/tasks/${slug}/raw`)
}
