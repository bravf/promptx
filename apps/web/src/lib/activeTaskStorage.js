export const ACTIVE_TASK_STORAGE_KEY = 'promptx:v2:active-task-id'

export function readActiveTaskId(storage) {
  try {
    const target = storage || globalThis.localStorage
    return String(target?.getItem(ACTIVE_TASK_STORAGE_KEY) || '').trim()
  } catch {
    return ''
  }
}

export function writeActiveTaskId(taskId, storage) {
  try {
    const target = storage || globalThis.localStorage
    const normalized = String(taskId || '').trim()
    if (normalized) target?.setItem(ACTIVE_TASK_STORAGE_KEY, normalized)
    else target?.removeItem(ACTIVE_TASK_STORAGE_KEY)
  } catch {}
}
