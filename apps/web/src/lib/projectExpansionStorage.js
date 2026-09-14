export const COLLAPSED_PROJECTS_STORAGE_KEY = 'promptx:v2:collapsed-project-ids'

function normalizeProjectIds(projectIds) {
  if (!Array.isArray(projectIds)) return []
  return [...new Set(projectIds.map((id) => String(id || '').trim()).filter(Boolean))]
}

export function readCollapsedProjectIds(storage) {
  try {
    const target = storage || globalThis.localStorage
    return normalizeProjectIds(JSON.parse(target?.getItem(COLLAPSED_PROJECTS_STORAGE_KEY) || '[]'))
  } catch {
    return []
  }
}

export function writeCollapsedProjectIds(projectIds, storage) {
  try {
    const target = storage || globalThis.localStorage
    const normalized = normalizeProjectIds(projectIds)
    if (normalized.length) target?.setItem(COLLAPSED_PROJECTS_STORAGE_KEY, JSON.stringify(normalized))
    else target?.removeItem(COLLAPSED_PROJECTS_STORAGE_KEY)
  } catch {}
}
