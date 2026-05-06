import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { AGENT_ENGINES, normalizeComparablePath } from '../../../packages/shared/src/index.js'

const DEFAULT_LIMIT = 80
const MAX_SCAN_FILES = 800
const MAX_DAT_FILE_SIZE = 8 * 1024 * 1024
const MAX_PREVIEW_LENGTH = 80

function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const limit = Math.max(1, Number(value) || fallback)
  return Math.min(200, limit)
}

function normalizeText(value = '') {
  return String(value || '').trim()
}

function safeStat(filePath = '') {
  try {
    return fs.statSync(filePath)
  } catch {
    return null
  }
}

function safeReadFile(filePath = '', maxBytes = MAX_DAT_FILE_SIZE) {
  const stat = safeStat(filePath)
  if (!stat?.isFile() || stat.size > maxBytes) {
    return ''
  }

  try {
    return fs.readFileSync(filePath, 'utf8')
  } catch {
    return ''
  }
}

function safeReadFileHead(filePath = '', maxBytes = 256 * 1024) {
  const stat = safeStat(filePath)
  if (!stat?.isFile()) {
    return ''
  }

  const bytesToRead = Math.min(Math.max(1, Number(maxBytes) || 1), stat.size)
  const buffer = Buffer.allocUnsafe(bytesToRead)
  let fd = null
  try {
    fd = fs.openSync(filePath, 'r')
    const bytesRead = fs.readSync(fd, buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } catch {
    return ''
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {
        // ignore close errors for best-effort discovery
      }
    }
  }
}

function parseJson(value) {
  const text = normalizeText(value)
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function parseMaybeJson(value) {
  if (!value) {
    return null
  }

  if (typeof value === 'object') {
    return value
  }

  return parseJson(value)
}

function extractOpenCodePromptText(value) {
  const parsed = parseMaybeJson(value)
  if (!parsed || typeof parsed !== 'object') {
    return normalizeText(value)
  }

  if (Array.isArray(parsed.prompt)) {
    const parts = parsed.prompt
      .map((item) => {
        if (!item || typeof item !== 'object') {
          return ''
        }
        return normalizeText(item.content || item.text || '')
      })
      .filter(Boolean)
    return parts.join(' ').trim()
  }

  return extractMessageText(parsed)
}

function sanitizeOpenCodeSessionLabel(value = '', cwd = '', sessionId = '') {
  const text = normalizeText(value).replace(/\s+/g, ' ').trim()
  if (text.length >= 2) {
    return text
  }

  return path.basename(normalizeText(cwd)) || normalizeText(sessionId)
}

function toIsoDate(value) {
  if (value === null || value === undefined || value === '') {
    return ''
  }

  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString()
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value > 1e12 ? value : value * 1000
    const date = new Date(timestamp)
    return Number.isFinite(date.getTime()) ? date.toISOString() : ''
  }

  const text = normalizeText(value)
  if (!text) {
    return ''
  }

  if (/^\d+$/.test(text)) {
    return toIsoDate(Number(text))
  }

  const date = new Date(text)
  return Number.isFinite(date.getTime()) ? date.toISOString() : ''
}

function getSortTime(value = '') {
  const time = Date.parse(normalizeText(value))
  return Number.isFinite(time) ? time : 0
}

function createSessionCandidate(input = {}) {
  const id = normalizeText(input.id)
  if (!id) {
    return null
  }

  const cwd = normalizeText(input.cwd)
  const label = normalizeText(input.label) || path.basename(cwd) || id
  return {
    id,
    engine: input.engine,
    label: label.length > MAX_PREVIEW_LENGTH ? `${label.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : label,
    cwd,
    updatedAt: toIsoDate(input.updatedAt),
    updatedAtSource: normalizeText(input.updatedAtSource),
    source: normalizeText(input.source),
    summary: normalizeText(input.summary),
  }
}

function getUpdatedAtPriority(value = '') {
  return value === 'explicit' ? 1 : 0
}

function sortAndLimitCandidates(items = [], options = {}) {
  const limit = normalizeLimit(options.limit)
  const targetCwd = normalizeComparablePath(options.cwd)
  const deduped = new Map()

  items.forEach((item) => {
    const candidate = createSessionCandidate(item)
    if (!candidate) {
      return
    }

    const key = `${candidate.engine}:${candidate.id}`
    const current = deduped.get(key)
    if (!current) {
      deduped.set(key, candidate)
      return
    }

    const nextScore = Number(Boolean(candidate.cwd)) + Number(Boolean(candidate.label && candidate.label !== candidate.id))
    const currentScore = Number(Boolean(current.cwd)) + Number(Boolean(current.label && current.label !== current.id))
    const nextTimePriority = getUpdatedAtPriority(candidate.updatedAtSource)
    const currentTimePriority = getUpdatedAtPriority(current.updatedAtSource)
    if (
      nextTimePriority > currentTimePriority
      || (nextTimePriority === currentTimePriority && getSortTime(candidate.updatedAt) > getSortTime(current.updatedAt))
      || nextScore > currentScore
    ) {
      deduped.set(key, {
        ...current,
        ...candidate,
        cwd: candidate.cwd || current.cwd,
        label: candidate.label || current.label,
        summary: candidate.summary || current.summary,
        updatedAt: candidate.updatedAt || current.updatedAt,
        updatedAtSource: candidate.updatedAtSource || current.updatedAtSource,
      })
    }
  })

  return [...deduped.values()]
    .map((item) => ({
      ...item,
      matchedCwd: Boolean(targetCwd && normalizeComparablePath(item.cwd) === targetCwd),
    }))
    .sort((left, right) => (
      Number(right.matchedCwd) - Number(left.matchedCwd)
      || getUpdatedAtPriority(right.updatedAtSource) - getUpdatedAtPriority(left.updatedAtSource)
      || getSortTime(right.updatedAt) - getSortTime(left.updatedAt)
      || String(left.label || left.id).localeCompare(String(right.label || right.id), 'zh-CN')
    ))
    .slice(0, limit)
}

function collectFiles(rootDir = '', options = {}) {
  const root = normalizeText(rootDir)
  if (!root || !safeStat(root)?.isDirectory()) {
    return []
  }

  const maxDepth = Math.max(0, Number(options.maxDepth) || 0)
  const maxFiles = Math.max(1, Number(options.maxFiles) || MAX_SCAN_FILES)
  const match = typeof options.match === 'function' ? options.match : () => true
  const files = []

  function visit(dir, depth) {
    if (files.length >= maxFiles) {
      return
    }

    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxFiles || entry.name.startsWith('.')) {
        continue
      }

      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (depth < maxDepth) {
          visit(entryPath, depth + 1)
        }
        continue
      }

      if (entry.isFile() && match(entryPath, entry.name)) {
        files.push(entryPath)
      }
    }
  }

  visit(root, 0)
  return files
}

function extractMessageText(value, depth = 0) {
  if (!value || depth > 4) {
    return ''
  }

  if (typeof value === 'string') {
    return normalizeText(value)
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const text = extractMessageText(item, depth + 1)
      if (text) {
        return text
      }
    }
    return ''
  }

  if (typeof value !== 'object') {
    return ''
  }

  for (const key of ['text', 'content', 'message', 'prompt', 'summary']) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      continue
    }

    const text = extractMessageText(value[key], depth + 1)
    if (text) {
      return text
    }
  }

  return ''
}

function readJsonlPreview(filePath = '') {
  const content = safeReadFileHead(filePath, 256 * 1024)
  if (!content) {
    return ''
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n').slice(0, 30)
  for (const line of lines) {
    const event = parseJson(line)
    if (!event) {
      continue
    }

    const type = normalizeText(event.type).toLowerCase()
    if (type && type !== 'user') {
      continue
    }

    const text = extractMessageText(event)
    if (text) {
      return text.replace(/\s+/g, ' ').slice(0, MAX_PREVIEW_LENGTH)
    }
  }

  return ''
}

function readClaudeJsonlCwd(filePath = '') {
  const content = safeReadFileHead(filePath, 256 * 1024)
  if (!content) {
    return ''
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n')
  for (const line of lines) {
    const event = parseJson(line)
    if (!event || typeof event !== 'object') {
      continue
    }

    const cwd = normalizeText(event.cwd)
    if (cwd) {
      return cwd
    }

    const message = event.message
    if (message && typeof message === 'object') {
      const msgCwd = normalizeText(message.cwd)
      if (msgCwd) {
        return msgCwd
      }
    }
  }

  return ''
}

function normalizeClaudeProjectPathInput(cwd = '') {
  const value = normalizeText(cwd)
  if (!value) {
    return ''
  }

  const normalized = value.replace(/\\/g, '/')
  if (normalized.length > 1 && !/^[A-Za-z]:\/$/i.test(normalized)) {
    return normalized.replace(/\/+$/, '')
  }
  return normalized
}

function getClaudeProjectPathInputs(cwd = '') {
  const primary = normalizeClaudeProjectPathInput(cwd)
  if (!primary) {
    return []
  }

  const values = [primary]
  try {
    const realPath = normalizeClaudeProjectPathInput(fs.realpathSync.native(primary))
    if (realPath && !values.includes(realPath)) {
      values.push(realPath)
    }
  } catch {
    // Some candidate paths may not exist locally, especially cross-platform paths.
  }

  return values
}

function encodeClaudeProjectPath(cwd = '') {
  const value = normalizeClaudeProjectPathInput(cwd)
  if (!value) {
    return ''
  }

  return value.replace(/[/:.]/g, '-')
}

function getClaudeProjectKeysForCwd(cwd = '') {
  const keys = []
  getClaudeProjectPathInputs(cwd).forEach((targetPath) => {
    const key = encodeClaudeProjectPath(targetPath)
    if (!key || keys.includes(key)) {
      return
    }
    keys.push(key)

    if (/^[A-Za-z]--/.test(key)) {
      const upperDriveKey = `${key[0].toUpperCase()}${key.slice(1)}`
      const lowerDriveKey = `${key[0].toLowerCase()}${key.slice(1)}`
      ;[upperDriveKey, lowerDriveKey].forEach((driveKey) => {
        if (!keys.includes(driveKey)) {
          keys.push(driveKey)
        }
      })
    }
  })
  return keys
}

function inferClaudeProjectCwd(projectKey = '', options = {}) {
  const key = normalizeText(projectKey)
  const targetPaths = getClaudeProjectPathInputs(options.cwd)
  if (!key || !targetPaths.length) {
    return ''
  }

  const matched = targetPaths.some((targetPath) => {
    const encodedTarget = encodeClaudeProjectPath(targetPath)
    const isWindowsPath = /^[A-Za-z]:\//.test(targetPath)
    return isWindowsPath
      ? encodedTarget.toLowerCase() === key.toLowerCase()
      : encodedTarget === key
  })
  return matched ? targetPaths[0] : ''
}

function normalizeClaudeDiscoveredCwd(cwd = '', options = {}) {
  const discoveredCwd = normalizeClaudeProjectPathInput(cwd)
  if (!discoveredCwd) {
    return ''
  }

  const targetPaths = getClaudeProjectPathInputs(options.cwd)
  if (!targetPaths.length) {
    return discoveredCwd
  }

  const discoveredComparable = normalizeComparablePath(discoveredCwd)
  const isTargetEquivalent = targetPaths.some((targetPath) => (
    normalizeComparablePath(targetPath) === discoveredComparable
  ))
  return isTargetEquivalent ? targetPaths[0] : discoveredCwd
}

export function decodeClaudeProjectPath(projectKey = '') {
  const key = normalizeText(projectKey)
  if (!key) {
    return ''
  }

  if (key.startsWith('-')) {
    return key.replace(/-/g, '/')
  }

  const driveMatch = key.match(/^([A-Za-z])-+/)
  if (driveMatch) {
    return `${driveMatch[1]}:${key.slice(driveMatch[0].length - 1).replace(/-/g, '\\')}`
  }

  return ''
}

export function listKnownClaudeCodeSessions(options = {}) {
  const claudeHome = normalizeText(options.claudeHome || process.env.CLAUDE_HOME)
    || path.join(os.homedir(), '.claude')
  const transcriptDir = path.join(claudeHome, 'transcripts')
  const projectsDir = path.join(claudeHome, 'projects')
  const items = []
  const seenProjectFiles = new Set()

  collectFiles(transcriptDir, {
    maxDepth: 0,
    maxFiles: MAX_SCAN_FILES,
    match: (filePath) => filePath.endsWith('.jsonl'),
  }).forEach((filePath) => {
    const stat = safeStat(filePath)
    const id = path.basename(filePath, '.jsonl')
    items.push({
      id,
      engine: AGENT_ENGINES.CLAUDE_CODE,
      label: readJsonlPreview(filePath) || id,
      updatedAt: stat?.mtime,
      source: 'claude_transcripts',
    })
  })

  function addClaudeProjectFile(filePath) {
    const fileKey = path.resolve(filePath)
    if (seenProjectFiles.has(fileKey)) {
      return
    }
    seenProjectFiles.add(fileKey)

    const stat = safeStat(filePath)
    const relativeParts = path.relative(projectsDir, filePath).split(path.sep).filter(Boolean)
    const projectKey = relativeParts[0] || ''
    const cwd = normalizeClaudeDiscoveredCwd(readClaudeJsonlCwd(filePath), options)
      || inferClaudeProjectCwd(projectKey, options)
      || decodeClaudeProjectPath(projectKey)
    const id = path.basename(filePath, '.jsonl')
    items.push({
      id,
      engine: AGENT_ENGINES.CLAUDE_CODE,
      label: readJsonlPreview(filePath) || path.basename(cwd) || id,
      cwd,
      updatedAt: stat?.mtime,
      source: 'claude_projects',
    })
  }

  getClaudeProjectKeysForCwd(options.cwd).forEach((targetProjectKey) => {
    collectFiles(path.join(projectsDir, targetProjectKey), {
      maxDepth: 2,
      maxFiles: MAX_SCAN_FILES,
      match: (filePath) => filePath.endsWith('.jsonl'),
    }).forEach(addClaudeProjectFile)
  })

  collectFiles(projectsDir, {
    maxDepth: 3,
    maxFiles: MAX_SCAN_FILES,
    match: (filePath) => filePath.endsWith('.jsonl'),
  }).forEach(addClaudeProjectFile)

  return sortAndLimitCandidates(items, options)
}

function getOpenCodeDataDirs(options = {}) {
  if (options.openCodeDataDir) {
    return [options.openCodeDataDir]
  }

  if (process.env.OPENCODE_DATA_DIR) {
    return [process.env.OPENCODE_DATA_DIR]
  }

  const dirs = []
  const home = os.homedir()
  if (process.platform === 'darwin') {
    dirs.push(path.join(home, 'Library', 'Application Support', 'ai.opencode.desktop'))
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
    dirs.push(path.join(appData, 'ai.opencode.desktop'))
  } else {
    dirs.push(path.join(home, '.config', 'ai.opencode.desktop'))
  }
  dirs.push(path.join(home, '.opencode'))
  return dirs
}

function getOpenCodeDbPaths(options = {}) {
  const home = os.homedir()

  if (options.openCodeDbPath) {
    return [normalizeText(options.openCodeDbPath)].filter(Boolean)
  }

  const paths = []
  if (process.env.OPENCODE_DB_PATH) {
    paths.push(process.env.OPENCODE_DB_PATH)
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
    paths.push(path.join(localAppData, 'opencode', 'opencode.db'))
  } else {
    paths.push(path.join(home, '.local', 'share', 'opencode', 'opencode.db'))
  }

  paths.push(path.join(home, '.opencode', 'opencode.db'))

  return [...new Set(paths.map((item) => normalizeText(item)).filter(Boolean))]
}

function decodeOpenCodeWorkspacePath(fileName = '') {
  const name = normalizeText(fileName)
  const match = name.match(/^opencode\.workspace\.([^.]+)(?:\..*)?\.dat$/)
  if (!match) {
    return ''
  }

  const token = match[1]
  if (token.startsWith('/') || /^[a-z]:[\\/]/i.test(token)) {
    return token
  }

  try {
    const decoded = Buffer.from(token, 'base64').toString('utf8')
    if (
      (decoded.startsWith('/') && decoded.split('/').filter(Boolean).length >= 3)
      || /^[a-z]:[\\/]/i.test(decoded)
    ) {
      return decoded
    }
  } catch {
    return ''
  }

  return ''
}

function readOpenCodeDat(filePath = '') {
  return parseJson(safeReadFile(filePath)) || {}
}

function loadOpenCodeSessionsFromDb(options = {}) {
  const dbPath = getOpenCodeDbPaths(options).find((candidate) => safeStat(candidate)?.isFile())
  if (!dbPath) {
    return []
  }

  let db
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare(`
      select
        id,
        title,
        directory,
        time_updated,
        time_created,
        time_archived
      from session
      where time_archived is null
      order by time_updated desc
      limit ?
    `).all(Math.max(50, normalizeLimit(options.limit) * 4))

    return rows.map((row) => ({
      id: normalizeText(row.id),
      engine: AGENT_ENGINES.OPENCODE,
      label: sanitizeOpenCodeSessionLabel(row.title, row.directory, row.id),
      cwd: normalizeText(row.directory),
      updatedAt: row.time_updated || row.time_created,
      source: 'opencode_db',
      summary: '',
    }))
  } catch {
    return []
  } finally {
    try {
      db?.close()
    } catch {
      // ignore close errors
    }
  }
}

function addOpenCodeLayoutSessions(dat = {}, sourceFile = '', items = [], idToCwd = new Map()) {
  const layout = parseMaybeJson(dat['layout.page'])
  if (!layout || typeof layout !== 'object') {
    return
  }

  const lastProjectSession = layout.lastProjectSession && typeof layout.lastProjectSession === 'object'
    ? layout.lastProjectSession
    : {}
  Object.entries(lastProjectSession).forEach(([projectPath, value]) => {
    const item = value && typeof value === 'object' ? value : {}
    const id = normalizeText(item.id)
    const cwd = normalizeText(item.directory || projectPath)
    if (!id) {
      return
    }
    idToCwd.set(id, cwd)
    items.push({
      id,
      engine: AGENT_ENGINES.OPENCODE,
      label: path.basename(cwd) || id,
      cwd,
      updatedAt: item.at,
      updatedAtSource: item.at ? 'explicit' : 'inferred',
      source: 'opencode_desktop',
    })
  })

  const lastSession = layout.lastSession && typeof layout.lastSession === 'object'
    ? layout.lastSession
    : {}
  Object.entries(lastSession).forEach(([projectPath, idValue]) => {
    const id = normalizeText(idValue)
    const cwd = normalizeText(projectPath)
    if (!id) {
      return
    }
    idToCwd.set(id, cwd)
    items.push({
      id,
      engine: AGENT_ENGINES.OPENCODE,
      label: path.basename(cwd) || id,
      cwd,
      updatedAt: safeStat(sourceFile)?.mtime,
      updatedAtSource: 'inferred',
      source: 'opencode_desktop',
    })
  })
}

export function listKnownOpenCodeSessions(options = {}) {
  const sqliteItems = loadOpenCodeSessionsFromDb(options)
  if (sqliteItems.length) {
    return sortAndLimitCandidates(sqliteItems, options)
  }

  const items = []
  const idToCwd = new Map()

  getOpenCodeDataDirs(options).forEach((dataDir) => {
    collectFiles(dataDir, {
      maxDepth: 0,
      maxFiles: MAX_SCAN_FILES,
      match: (filePath) => filePath.endsWith('.dat'),
    }).forEach((filePath) => {
      const stat = safeStat(filePath)
      const dat = readOpenCodeDat(filePath)
      const fileCwd = decodeOpenCodeWorkspacePath(path.basename(filePath))

      addOpenCodeLayoutSessions(dat, filePath, items, idToCwd)

      const fileSessionIds = [...new Set(
        Object.keys(dat)
          .map((key) => String(key || '').match(/^session:([^:]+):/)?.[1] || '')
          .filter(Boolean)
      )]
      const mappedFileCwds = [...new Set(fileSessionIds.map((id) => idToCwd.get(id)).filter(Boolean))]
      const workspaceCwd = mappedFileCwds.length === 1 ? mappedFileCwds[0] : fileCwd

      Object.entries(dat).forEach(([key, value]) => {
        const match = String(key || '').match(/^session:([^:]+):([^:]+)$/)
        if (!match) {
          return
        }

        const [, id, field] = match
        const cwd = idToCwd.get(id) || workspaceCwd
        const text = field === 'prompt' ? extractOpenCodePromptText(value) : ''
        items.push({
          id,
          engine: AGENT_ENGINES.OPENCODE,
          label: sanitizeOpenCodeSessionLabel(text, cwd, id),
          cwd,
          updatedAt: stat?.mtime,
          updatedAtSource: 'inferred',
          source: 'opencode_desktop',
        })
      })
    })
  })

  return sortAndLimitCandidates(items, options)
}

function getKimiHomeDir(options = {}) {
  return normalizeText(options.kimiHome || process.env.KIMI_HOME)
    || path.join(os.homedir(), '.kimi')
}

function readKimiJson(options = {}) {
  const kimiJsonPath = path.join(getKimiHomeDir(options), 'kimi.json')
  return parseJson(safeReadFile(kimiJsonPath)) || {}
}

function readKimiContextPreview(contextPath = '') {
  const content = safeReadFile(contextPath, 256 * 1024)
  if (!content) {
    return ''
  }

  const lines = content.replace(/\r\n/g, '\n').split('\n').slice(0, 30)
  for (const line of lines) {
    const event = parseJson(line)
    if (!event) {
      continue
    }

    const role = normalizeText(event.role).toLowerCase()
    if (role !== 'user') {
      continue
    }

    const text = extractMessageText(event)
    if (text) {
      return text.replace(/\s+/g, ' ').slice(0, MAX_PREVIEW_LENGTH)
    }
  }

  return ''
}

export function listKnownKimiCodeSessions(options = {}) {
  const kimiHome = getKimiHomeDir(options)
  const items = []

  const kimiJson = readKimiJson(options)
  const cwdBySessionId = new Map()

  if (kimiJson?.work_dirs && Array.isArray(kimiJson.work_dirs)) {
    kimiJson.work_dirs.forEach((entry) => {
      const id = normalizeText(entry?.last_session_id)
      const cwd = normalizeText(entry?.path)
      if (!id || !cwd) {
        return
      }

      cwdBySessionId.set(id, cwd)
      items.push({
        id,
        engine: AGENT_ENGINES.KIMI_CODE,
        label: path.basename(cwd) || id,
        cwd,
        updatedAt: safeStat(path.join(kimiHome, 'kimi.json'))?.mtime,
        source: 'kimi_json',
      })
    })
  }

  const sessionsDir = path.join(kimiHome, 'sessions')
  if (safeStat(sessionsDir)?.isDirectory()) {
    let hashDirs = []
    try {
      hashDirs = fs.readdirSync(sessionsDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      hashDirs = []
    }

    for (const hashDir of hashDirs) {
      const hashDirPath = path.join(sessionsDir, hashDir)
      let sessionDirs = []
      try {
        sessionDirs = fs.readdirSync(hashDirPath, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name)
      } catch {
        continue
      }

      for (const sessionId of sessionDirs) {
        if (cwdBySessionId.has(sessionId)) {
          const statePath = path.join(hashDirPath, sessionId, 'state.json')
          const state = parseJson(safeReadFile(statePath))
          if (state?.archived) {
            const index = items.findIndex((item) => item.id === sessionId)
            if (index >= 0) {
              items.splice(index, 1)
            }
            continue
          }

          const contextPath = path.join(hashDirPath, sessionId, 'context.jsonl')
          const preview = readKimiContextPreview(contextPath)
          const stateStat = safeStat(statePath)
          const existing = items.find((item) => item.id === sessionId)
          if (existing) {
            existing.label = normalizeText(state?.custom_title) || preview || existing.label
            if (stateStat?.mtime && getSortTime(stateStat.mtime) > getSortTime(existing.updatedAt)) {
              existing.updatedAt = toIsoDate(stateStat.mtime)
              existing.updatedAtSource = 'explicit'
            }
          }
          continue
        }

        const statePath = path.join(hashDirPath, sessionId, 'state.json')
        const state = parseJson(safeReadFile(statePath))
        if (state?.archived) {
          continue
        }

        const contextPath = path.join(hashDirPath, sessionId, 'context.jsonl')
        const preview = readKimiContextPreview(contextPath)

        items.push({
          id: sessionId,
          engine: AGENT_ENGINES.KIMI_CODE,
          label: normalizeText(state?.custom_title) || preview || sessionId,
          cwd: '',
          updatedAt: safeStat(statePath)?.mtime,
          source: 'kimi_sessions',
        })
      }
    }
  }

  return sortAndLimitCandidates(items, options)
}
