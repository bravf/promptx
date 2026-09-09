const MAX_COMMAND_PREVIEW = 2_000
const MAX_PATHS = 32

function objectValue(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function lineNumber(value) {
  for (const key of ['line', 'lineNumber', 'line_number', 'startLine', 'start_line']) {
    const number = Number(value?.[key])
    if (Number.isInteger(number) && number > 0) return number
  }
  return null
}

function collectPaths(value, result, depth = 0) {
  if (result.length >= MAX_PATHS || value == null || depth > 5) return
  const source = objectValue(value)
  if (typeof value === 'string') {
    if (source) collectPaths(source, result, depth + 1)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectPaths(entry, result, depth + 1))
    return
  }
  if (typeof value !== 'object') return
  for (const key of ['path', 'filePath', 'file_path', 'target']) {
    if (typeof value[key] === 'string' && value[key].trim()) {
      const line = lineNumber(value)
      result.push({ path: value[key].trim(), ...(line ? { line } : {}) })
    }
  }
  for (const key of ['changes', 'files', 'content', 'input']) collectPaths(value[key], result, depth + 1)
}

function uniquePaths(paths) {
  const seen = new Set()
  return paths.filter((entry) => {
    const key = `${entry.path}\u0000${entry.line || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).slice(0, MAX_PATHS)
}

function compactToolDetail(detail) {
  const source = objectValue(detail) || {}
  const compact = { type: String(source.type || 'unknown') }
  for (const key of ['kind', 'command', 'path', 'filePath', 'file_path', 'target']) {
    if (typeof source[key] === 'string' && source[key].trim()) compact[key] = source[key].trim().slice(0, MAX_COMMAND_PREVIEW)
  }
  const paths = []
  collectPaths(source, paths)
  collectPaths(source.rawInput, paths)
  const unique = uniquePaths(paths)
  if (unique.length) compact.paths = unique
  return compact
}

export function presentTimelineItem(item) {
  if (!item || item.type !== 'tool_call') return item
  return { ...item, detail: compactToolDetail(item.detail) }
}

export function presentTimelineRow(row) {
  if (!row) return row
  return { ...row, item: presentTimelineItem(row.item) }
}

export function presentTimelineRows(rows = []) {
  return rows.map(presentTimelineRow)
}
