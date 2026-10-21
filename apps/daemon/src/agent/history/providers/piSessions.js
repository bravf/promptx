import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const HEAD_BYTES = 64 * 1024
const TAIL_BYTES = 256 * 1024

function resolvePath(value, baseDir, homeDir) {
  if (value === '~') return homeDir
  if (value.startsWith('~/')) return path.join(homeDir, value.slice(2))
  return path.isAbsolute(value) ? value : path.resolve(baseDir, value)
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function sessionDirs(projects, env, homeDir) {
  const agentDir = resolvePath(env.PI_CODING_AGENT_DIR || path.join(homeDir, '.pi', 'agent'), process.cwd(), homeDir)
  const roots = new Set()
  const configured = env.PI_CODING_AGENT_SESSION_DIR
  if (configured) roots.add(resolvePath(configured, process.cwd(), homeDir))
  const globalSettings = readJson(path.join(agentDir, 'settings.json'))
  if (typeof globalSettings?.sessionDir === 'string' && globalSettings.sessionDir.trim()) {
    roots.add(resolvePath(globalSettings.sessionDir, process.cwd(), homeDir))
  }
  for (const project of projects) {
    const cwd = project?.cwd
    if (!cwd) continue
    const settings = readJson(path.join(cwd, '.pi', 'settings.json'))
    if (typeof settings?.sessionDir === 'string' && settings.sessionDir.trim()) {
      roots.add(resolvePath(settings.sessionDir, cwd, homeDir))
    }
  }
  roots.add(path.join(agentDir, 'sessions'))
  return [...roots]
}

function walkSessions(directory, files, depth = 0) {
  if (depth > 12) return
  let entries
  try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) walkSessions(file, files, depth + 1)
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(file)
  }
}

function readChunk(file, start, length) {
  const descriptor = fs.openSync(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const bytesRead = fs.readSync(descriptor, buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally { fs.closeSync(descriptor) }
}

function parseRecords(text) {
  return text.split(/\r?\n/).flatMap(line => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

function messageText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
}

function readSession(file) {
  let stat
  try { stat = fs.statSync(file) } catch { return null }
  if (!stat.isFile() || stat.size <= 0) return null
  try {
    const head = readChunk(file, 0, Math.min(stat.size, HEAD_BYTES))
    const header = parseRecords(head)[0]
    if (header?.type !== 'session' || !header.id || !header.cwd) return null
    const tailStart = Math.max(0, stat.size - TAIL_BYTES)
    const tail = readChunk(file, tailStart, stat.size - tailStart)
    const headRecords = parseRecords(head)
    const tailRecords = parseRecords(tail)
    const firstUser = headRecords.find(entry => entry.type === 'message' && entry.message?.role === 'user')
    const lastUser = [...tailRecords].reverse().find(entry => entry.type === 'message' && entry.message?.role === 'user')
    const info = [...tailRecords].reverse().find(entry => entry.type === 'session_info' && entry.name)
      || headRecords.find(entry => entry.type === 'session_info' && entry.name)
    const firstPromptPreview = messageText(firstUser?.message?.content).trim().replace(/\s+/g, ' ').slice(0, 160)
    const lastPromptPreview = messageText(lastUser?.message?.content).trim().replace(/\s+/g, ' ').slice(0, 160)
    if (!firstPromptPreview && !lastPromptPreview) return null
    const lastTimestamp = [...tailRecords].reverse().find(entry => entry.timestamp)?.timestamp
    const parsedTime = Date.parse(lastTimestamp || '')
    return {
      providerId: 'pi',
      providerHandleId: header.id,
      sessionFile: file,
      cwd: header.cwd,
      title: String(info?.name || firstPromptPreview || 'Pi 会话').slice(0, 80),
      firstPromptPreview,
      lastPromptPreview,
      lastActivityAt: Number.isFinite(parsedTime) ? new Date(parsedTime).toISOString() : stat.mtime.toISOString(),
    }
  } catch { return null }
}

export function listPiHistorySessions(projects = [], { env = process.env, homeDir = os.homedir(), limit = 500 } = {}) {
  const files = []
  for (const root of sessionDirs(projects, env, homeDir)) walkSessions(root, files)
  return [...new Set(files)]
    .flatMap(file => {
      try { return [{ file, mtime: fs.statSync(file).mtimeMs }] } catch { return [] }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, Math.min(1000, Math.max(1, Number(limit) || 500)))
    .map(({ file }) => readSession(file))
    .filter(Boolean)
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}
