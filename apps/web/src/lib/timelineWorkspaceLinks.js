function objectValue(value) {
  if (value && typeof value === 'object') return value
  if (typeof value !== 'string' || !value.trim().startsWith('{')) return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function pathCandidates(value, candidates) {
  const object = objectValue(value)
  if (!object) return
  for (const key of ['path', 'filePath', 'file_path', 'target']) {
    if (typeof object[key] === 'string') candidates.push({ path: object[key], source: object })
  }
  for (const key of ['changes', 'files', 'content']) {
    if (Array.isArray(object[key])) object[key].forEach((entry) => pathCandidates(entry, candidates))
  }
}

function isWindowsAbsolutePath(value) {
  return /^[a-z]:\//i.test(value) || value.startsWith('//')
}

function isAbsolutePath(value) {
  return value.startsWith('/') || isWindowsAbsolutePath(value)
}

function normalizePathSyntax(value) {
  return String(value || '').trim().replaceAll('\\', '/').replace(/^\/(?=[a-z]:\/)/i, '')
}

function normalizePath(value, workspaceCwd = '') {
  let filePath = normalizePathSyntax(value)
  if (!filePath || /^(?:https?|data):/i.test(filePath)) return ''
  const cwd = normalizePathSyntax(workspaceCwd).replace(/\/$/, '')
  if (isAbsolutePath(filePath)) {
    if (!cwd || !isAbsolutePath(cwd)) return ''
    const caseInsensitive = isWindowsAbsolutePath(filePath) || isWindowsAbsolutePath(cwd)
    const comparablePath = caseInsensitive ? filePath.toLowerCase() : filePath
    const comparableCwd = caseInsensitive ? cwd.toLowerCase() : cwd
    if (comparablePath !== comparableCwd && !comparablePath.startsWith(`${comparableCwd}/`)) return ''
    filePath = filePath.slice(cwd.length).replace(/^\//, '')
  }
  filePath = filePath.replace(/^\.\//, '')
  if (!filePath || filePath === '..' || filePath.startsWith('../')) return ''
  return filePath
}

function decodedHref(value) {
  try {
    return decodeURIComponent(String(value || '').trim())
  } catch {
    return String(value || '').trim()
  }
}

export function workspaceLinkForHref(value, workspaceCwd = '') {
  let href = decodedHref(value)
  const hasExternalScheme = /^[a-z][a-z\d+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)
  if (!href || href.startsWith('#') || hasExternalScheme) return null

  let line = null
  const lineMatch = href.match(/#L(\d+)(?:C\d+)?$/i)
  if (lineMatch) {
    line = Number(lineMatch[1])
    href = href.slice(0, lineMatch.index)
  } else {
    href = href.replace(/[?#].*$/, '')
    const locationMatch = href.match(/:(\d+)(?::\d+)?$/)
    if (locationMatch) {
      line = Number(locationMatch[1])
      href = href.slice(0, locationMatch.index)
    }
  }

  const filePath = normalizePath(href, workspaceCwd)
  return filePath ? { path: filePath, intent: 'file', line } : null
}

function lineNumber(source) {
  for (const key of ['line', 'lineNumber', 'line_number', 'startLine', 'start_line']) {
    const value = Number(source?.[key])
    if (Number.isInteger(value) && value > 0) return value
  }
  return null
}

export function workspaceLinksForTool(item, workspaceCwd = '') {
  if (item?.type !== 'tool_call') return []
  const detail = objectValue(item.detail) || {}
  const candidates = []
  pathCandidates(detail, candidates)
  pathCandidates(detail.input, candidates)
  pathCandidates(detail.rawInput, candidates)
  const type = `${item.name || ''} ${detail.type || ''} ${detail.kind || ''}`.toLowerCase()
  const intent = /(edit|write|patch|change|create|delete|move|rename)/.test(type) ? 'diff' : 'file'
  const seen = new Set()
  return candidates.flatMap((candidate) => {
    const filePath = normalizePath(candidate.path, workspaceCwd)
    if (!filePath || seen.has(filePath)) return []
    seen.add(filePath)
    return [{ path: filePath, intent, line: lineNumber(candidate.source) }]
  })
}
