export const SESSION_LIST_VIEW_KEY = 'promptx:v2:session-list-view'

export function readSessionListView(storage) {
  try { return (storage || globalThis.localStorage)?.getItem(SESSION_LIST_VIEW_KEY) === 'recent' ? 'recent' : 'workspace' } catch { return 'workspace' }
}

export function writeSessionListView(value, storage) {
  try { (storage || globalThis.localStorage)?.setItem(SESSION_LIST_VIEW_KEY, value === 'recent' ? 'recent' : 'workspace') } catch {}
}

function timestamp(value) {
  const result = Date.parse(value || '')
  return Number.isFinite(result) ? result : 0
}

function activity(task) {
  return timestamp(task.lastActiveAt) || timestamp(task.createdAt)
}

function dayNumber(date) {
  // 用本地日历日期比较，避免夏令时把“昨天”算成不足 24 小时。
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86400000
}

export function groupRecentSessions(tasks, now = new Date()) {
  const groups = new Map()
  const today = dayNumber(now)
  const sorted = [...tasks].sort((a, b) => {
    if (Boolean(a.pinnedAt) !== Boolean(b.pinnedAt)) return a.pinnedAt ? -1 : 1
    return (a.pinnedAt ? timestamp(b.pinnedAt) - timestamp(a.pinnedAt) : 0)
      || activity(b) - activity(a) || String(a.id).localeCompare(String(b.id))
  })
  for (const task of sorted) {
    const time = activity(task)
    const date = new Date(time)
    const days = today - dayNumber(date)
    let key, label
    if (task.pinnedAt) { key = 'pinned'; label = '置顶' }
    else if (!time) { key = 'unknown'; label = '更早' }
    else if (days <= 0) { key = 'today'; label = '今天' }
    else if (days === 1) { key = 'yesterday'; label = '昨天' }
    else if (days < 7) {
      key = `day-${dayNumber(date)}`
      label = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' }).format(date)
    } else {
      key = `month-${date.getFullYear()}-${date.getMonth()}`
      label = `${date.getFullYear() === now.getFullYear() ? '' : `${date.getFullYear()}年`}${date.getMonth() + 1}月`
    }
    if (!groups.has(key)) groups.set(key, { key, label, tasks: [] })
    groups.get(key).tasks.push(task)
  }
  return [...groups.values()]
}
