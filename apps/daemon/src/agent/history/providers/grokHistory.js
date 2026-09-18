import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readGrokHistoryFile } from './grokHistorySnapshot.js'

function grokRoots() {
  if (process.env.GROK_HOME) return [path.resolve(process.env.GROK_HOME)]
  return [path.join(os.homedir(), '.grok')]
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null }
}

function decodeGroupCwd(groupDir, encodedName, summary) {
  const cwdFile = path.join(groupDir, '.cwd')
  try {
    if (fs.existsSync(cwdFile)) {
      const value = fs.readFileSync(cwdFile, 'utf8').trim()
      if (value) return value
    }
  } catch {}
  if (summary?.info?.cwd) return summary.info.cwd
  try { return decodeURIComponent(encodedName) } catch { return encodedName }
}

function sessionPreview(summary = {}) {
  return String(summary.last_turn_summary || summary.session_summary || summary.generated_title || '').trim()
}

function resolveUpdatesPath(sessionId) {
  for (const base of grokRoots()) {
    const root = path.join(base, 'sessions')
    if (!fs.existsSync(root)) continue
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const file = path.join(root, group.name, sessionId, 'updates.jsonl')
      if (fs.existsSync(file)) return file
    }
  }
  return null
}

export function listGrokHistorySessions() {
  const sessions = []
  const seen = new Set()
  for (const base of grokRoots()) {
    const root = path.join(base, 'sessions')
    if (!fs.existsSync(root)) continue
    for (const group of fs.readdirSync(root, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const groupDir = path.join(root, group.name)
      for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
        if (!session.isDirectory() || seen.has(session.name)) continue
        const sessionDir = path.join(groupDir, session.name)
        const updates = path.join(sessionDir, 'updates.jsonl')
        const summary = readJson(path.join(sessionDir, 'summary.json')) || {}
        if (!fs.existsSync(updates) || summary.session_kind === 'subagent') continue
        let stat
        try { stat = fs.statSync(updates) } catch { continue }
        const preview = sessionPreview(summary)
        const title = String(summary.generated_title || summary.session_summary || preview || 'Grok 会话').slice(0, 80)
        seen.add(session.name)
        sessions.push({
          providerId: 'grok',
          providerHandleId: session.name,
          cwd: decodeGroupCwd(groupDir, group.name, summary),
          title,
          firstPromptPreview: preview.slice(0, 160),
          lastPromptPreview: preview.slice(0, 160),
          lastActivityAt: summary.last_active_at || summary.updated_at || stat.mtime.toISOString(),
        })
      }
    }
  }
  return sessions.sort((a, b) => String(b.lastActivityAt).localeCompare(String(a.lastActivityAt)))
}

export function readGrokHistorySnapshot(sessionId, options = {}) {
  if (!sessionId) return { status: 'unsupported' }
  const file = resolveUpdatesPath(sessionId)
  if (!file) return { status: 'unavailable' }
  return readGrokHistoryFile(sessionId, file, options)
}
