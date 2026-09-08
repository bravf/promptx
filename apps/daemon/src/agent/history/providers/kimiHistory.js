import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import {
  parseJsonLinesWithOffsets,
  readStableHistoryFile,
  readStableHistoryFileRange,
  textContent,
  toIsoTimestamp,
} from '../historySnapshot.js'

function resolveWirePath(sessionId) {
  for (const base of kimiRoots()) {
    const root = path.join(base, 'sessions')
    if (!fs.existsSync(root)) continue
    for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
      if (!directory.isDirectory()) continue
      const file = path.join(root, directory.name, sessionId, 'wire.jsonl')
      if (fs.existsSync(file)) return file
      const sessionDir = path.join(root, directory.name, sessionId, 'agents')
      if (!fs.existsSync(sessionDir)) continue
      const mainWire = path.join(sessionDir, 'main', 'wire.jsonl')
      if (fs.existsSync(mainWire)) return mainWire
      for (const agent of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        const agentWire = path.join(sessionDir, agent.name, 'wire.jsonl')
        if (agent.isDirectory() && fs.existsSync(agentWire)) return agentWire
      }
    }
  }
  return null
}

function kimiRoots() {
  const configured = process.env.KIMI_HOME ? [path.resolve(process.env.KIMI_HOME)] : []
  return [...new Set([...configured, path.join(os.homedir(), '.kimi-code'), path.join(os.homedir(), '.kimi')])]
}

function projectHash(cwd) {
  return crypto.createHash('md5').update(cwd).digest('hex')
}

export function listKimiHistorySessions(workspaces = []) {
  const sessions = []
  const seen = new Set()
  const cwdByHash = new Map(workspaces.map((workspace) => [projectHash(workspace.cwd), workspace.cwd]))
  for (const base of kimiRoots()) {
    const indexPath = path.join(base, 'session_index.jsonl')
    if (fs.existsSync(indexPath)) {
      const entries = parseLines(fs.readFileSync(indexPath, 'utf8'))
      for (const entry of entries) {
        const id = entry.sessionId
        const sessionDir = entry.sessionDir
        if (!id || !sessionDir || seen.has(id) || !fs.existsSync(sessionDir)) continue
        const fullPath = findSessionWire(sessionDir)
        if (!fullPath) continue
        const state = readJson(path.join(sessionDir, 'state.json'))
        const records = parseLines(readStableHistoryFile(fullPath).content || '')
        const first = records.find((record) => record.type === 'turn.prompt' || record.message?.type === 'TurnBegin')
        const text = kimiUserText(first?.input || first?.message?.payload?.user_input).trim()
        const stat = fs.statSync(fullPath)
        seen.add(id)
        sessions.push({
          providerId: 'kimi', providerHandleId: id,
          cwd: entry.workDir || state.cwd || '',
          title: String(state.title || text || 'Kimi 会话').slice(0, 80),
          firstPromptPreview: text.slice(0, 160), lastPromptPreview: String(state.lastPrompt || text).slice(0, 160),
          lastActivityAt: state.updatedAt ? new Date(state.updatedAt).toISOString() : stat.mtime.toISOString(),
        })
      }
    }

    const root = path.join(base, 'sessions')
    if (!fs.existsSync(root)) continue
    for (const project of fs.readdirSync(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue
      const cwd = cwdByHash.get(project.name) || ''
      const projectDir = path.join(root, project.name)
      for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
        if (!session.isDirectory() || seen.has(session.name)) continue
        const fullPath = findSessionWire(path.join(projectDir, session.name))
        if (!fullPath) continue
        let stat
        try { stat = fs.statSync(fullPath) } catch { continue }
        const content = readStableHistoryFile(fullPath).content || ''
        const records = parseLines(content)
        const first = records.find((record) => record.message?.type === 'TurnBegin')
        const text = kimiUserText(first?.message?.payload?.user_input).trim()
        seen.add(session.name)
        sessions.push({
          providerId: 'kimi', providerHandleId: session.name, cwd,
          title: text.slice(0, 80) || 'Kimi 会话', firstPromptPreview: text.slice(0, 160), lastPromptPreview: text.slice(0, 160),
          lastActivityAt: stat.mtime.toISOString(),
        })
      }
    }
  }
  return sessions.sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return {} }
}

function findSessionWire(sessionDir) {
  const legacy = path.join(sessionDir, 'wire.jsonl')
  if (fs.existsSync(legacy)) return legacy
  const agentsDir = path.join(sessionDir, 'agents')
  if (!fs.existsSync(agentsDir)) return null
  const mainWire = path.join(agentsDir, 'main', 'wire.jsonl')
  if (fs.existsSync(mainWire)) return mainWire
  for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    const file = path.join(agentsDir, agent.name, 'wire.jsonl')
    if (agent.isDirectory() && fs.existsSync(file)) return file
  }
  return null
}

function parseLines(content) {
  const result = []
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue
    try { result.push(JSON.parse(line)) } catch {}
  }
  return result
}

function kimiUserText(input) {
  if (typeof input === 'string') return input
  return textContent(input)
}

export function mapKimiHistorySnapshot(sessionId, content, revision = '') {
  const records = parseLines(content)
  if (records.some((record) => record.type === 'turn.prompt')) return mapKimiCodeHistorySnapshot(sessionId, records, revision)
  const turns = []
  let turn = null
  let itemOrdinal = 0
  let tools = new Map()
  for (const record of parseLines(content)) {
    const message = record.message
    if (!message?.type) continue
    const timestamp = toIsoTimestamp(record.timestamp)
    if (message.type === 'TurnBegin') {
      if (turn) turns.push(turn)
      const sourceTurnId = `kimi-turn:${record.timestamp}`
      const text = kimiUserText(message.payload?.user_input)
      turn = {
        sourceTurnId,
        providerPromptId: sourceTurnId,
        status: 'running',
        startedAt: timestamp,
        finishedAt: timestamp,
        items: text ? [{
          providerMessageId: `${sourceTurnId}:user`,
          timestamp,
          item: { type: 'user_message', clientMessageId: `${sourceTurnId}:user`, content: [{ type: 'text', text }] },
        }] : [],
      }
      itemOrdinal = 0
      tools = new Map()
      continue
    }
    if (!turn) continue
    if (message.type === 'ContentPart') {
      const payload = message.payload || {}
      const text = payload.type === 'think' ? payload.think : payload.type === 'text' ? payload.text : ''
      if (text) {
        const id = `${turn.sourceTurnId}:content:${itemOrdinal++}`
        turn.items.push({
          providerMessageId: id,
          timestamp,
          item: payload.type === 'think'
            ? { type: 'reasoning', messageId: id, text }
            : { type: 'assistant_message', messageId: id, phase: 'final_answer', text },
        })
      }
    } else if (message.type === 'ToolCall') {
      const payload = message.payload || {}
      const id = payload.id || `${turn.sourceTurnId}:tool:${itemOrdinal++}`
      const entry = {
        providerMessageId: id,
        timestamp,
        item: {
          type: 'tool_call',
          callId: id,
          name: payload.function?.name || '工具调用',
          status: 'running',
          detail: { type: 'kimi_tool', arguments: payload.function?.arguments },
        },
      }
      turn.items.push(entry)
      tools.set(id, entry)
    } else if (message.type === 'ToolResult') {
      const payload = message.payload || {}
      const target = tools.get(payload.tool_call_id)
      if (target) {
        const failed = Boolean(payload.return_value?.is_error)
        target.item = {
          ...target.item,
          status: failed ? 'failed' : 'completed',
          detail: { ...target.item.detail, output: payload.return_value?.output },
          ...(failed ? { error: { message: payload.return_value?.message || '工具调用失败' } } : {}),
        }
      }
    } else if (message.type === 'TurnEnd') {
      turn.status = 'completed'
      turn.finishedAt = timestamp
      turns.push(turn)
      turn = null
    } else if (message.type === 'StepInterrupted') {
      turn.status = 'canceled'
      turn.finishedAt = timestamp
    }
  }
  if (turn) turns.push(turn)
  return { sourceId: sessionId, revision, turns }
}

function mapKimiCodeHistorySnapshot(sessionId, records, revision) {
  const turns = []
  const byTurnId = new Map()
  const tools = new Map()
  let current = null
  for (const record of records) {
    const timestamp = toIsoTimestamp(record.time || record.finishedAt || record.timestamp)
    if (record.type === 'turn.prompt') {
      const sourceTurnId = record.promptId || `kimi-turn:${record.time}`
      const text = kimiUserText(record.input).trim()
      current = { sourceTurnId, providerPromptId: sourceTurnId, runtimeTurnId: '', status: 'running', startedAt: timestamp, finishedAt: timestamp, items: text ? [{
        providerMessageId: record.promptId || `${sourceTurnId}:user`, timestamp,
        item: { type: 'user_message', clientMessageId: record.promptId || `${sourceTurnId}:user`, content: [{ type: 'text', text }] },
      }] : [] }
      turns.push(current)
      byTurnId.set(String(record.promptId || record.turnId || sourceTurnId), current)
      continue
    }
    if (record.type === 'turn.ended') {
      const runtimeTurnId = record.turnId
      const turn = runtimeTurnId === undefined || runtimeTurnId === null
        ? current
        : byTurnId.get(String(runtimeTurnId)) || current
      if (turn) {
        if (runtimeTurnId !== undefined && runtimeTurnId !== null) {
          turn.runtimeTurnId = String(runtimeTurnId)
          byTurnId.set(String(runtimeTurnId), turn)
        }
        const failed = record.reason === 'failed' || Boolean(record.error)
        turn.status = failed ? 'failed' : record.reason === 'canceled' ? 'canceled' : 'completed'
        turn.errorMessage = failed ? (record.error?.message || 'Kimi Turn 失败') : ''
        turn.finishedAt = timestamp || turn.finishedAt
      }
      continue
    }
    if (record.type !== 'context.append_loop_event') continue
    const event = record.event || {}
    const runtimeTurnId = event.turnId ?? record.turnId
    const turn = runtimeTurnId === undefined || runtimeTurnId === null
      ? current
      : byTurnId.get(String(runtimeTurnId)) || current
    if (!turn) continue
    if (runtimeTurnId !== undefined && runtimeTurnId !== null) {
      turn.runtimeTurnId = String(runtimeTurnId)
      byTurnId.set(String(runtimeTurnId), turn)
    }
    if (event.type === 'content.part') {
      const part = event.part || {}
      const text = part.type === 'think' ? part.think : part.type === 'text' ? part.text : ''
      if (text) {
        const id = part.uuid || `${turn.sourceTurnId}:content:${turn.items.length}`
        turn.items.push({ providerMessageId: id, timestamp, item: part.type === 'think'
          ? { type: 'reasoning', messageId: id, text }
          : { type: 'assistant_message', messageId: id, phase: 'final_answer', text } })
      }
    } else if (event.type === 'tool.call') {
      const id = event.toolCallId || event.uuid || `${turn.sourceTurnId}:tool:${turn.items.length}`
      const entry = {
        providerMessageId: id,
        timestamp,
        item: {
          type: 'tool_call',
          callId: id,
          name: event.name || '工具调用',
          status: 'running',
          detail: { type: 'kimi_tool', arguments: event.args },
        },
      }
      turn.items.push(entry)
      tools.set(id, entry)
    } else if (event.type === 'tool.result') {
      const id = event.toolCallId || event.parentUuid
      const target = tools.get(id)
      if (target) {
        const failed = Boolean(event.result?.isError || event.result?.is_error || event.error)
        target.item = {
          ...target.item,
          status: failed ? 'failed' : 'completed',
          detail: { ...target.item.detail, output: event.result?.output ?? event.result },
          ...(failed ? { error: { message: event.error?.message || event.result?.message || '工具调用失败' } } : {}),
        }
      }
    }
    turn.finishedAt = timestamp || turn.finishedAt
  }
  for (const record of records) {
    if (!['turn.ended', 'prompt.completed'].includes(record.type)) continue
    const sourceTurnId = record.type === 'prompt.completed' ? record.promptId : record.turnId
    const turn = sourceTurnId === undefined || sourceTurnId === null
      ? null
      : byTurnId.get(String(sourceTurnId))
    if (turn) {
      const failed = record.reason === 'failed' || Boolean(record.error)
      turn.status = failed ? 'failed' : record.reason === 'canceled' ? 'canceled' : 'completed'
      turn.errorMessage = failed ? (record.error?.message || turn.errorMessage || 'Kimi Turn 失败') : ''
      turn.finishedAt = toIsoTimestamp(record.finishedAt || record.time) || turn.finishedAt
    }
  }
  return { sourceId: sessionId, revision, turns }
}

export function readKimiHistorySnapshot(sessionId, { knownRevision = '', cursor = 0 } = {}) {
  if (!sessionId) return { status: 'unsupported' }
  const file = resolveWirePath(sessionId)
  if (!file) return { status: 'unavailable' }
  const result = readStableHistoryFileRange(file, { knownRevision, cursor })
  if (result.status !== 'ready') return result
  const records = parseJsonLinesWithOffsets(result.content, result.baseOffset)
  const snapshot = mapKimiHistorySnapshot(sessionId, result.content, result.revision)
  let safeCursor = result.content.endsWith('\n')
    ? result.endOffset
    : result.baseOffset + Buffer.byteLength(result.content.slice(0, Math.max(0, result.content.lastIndexOf('\n') + 1)))
  if (snapshot.turns.at(-1)?.status === 'running') {
    const start = [...records].reverse().find(({ value }) => value.type === 'turn.prompt' || value.message?.type === 'TurnBegin')
    if (start) safeCursor = start.offset
  }
  return {
    ...snapshot,
    completeness: result.baseOffset > 0 && !result.reset ? 'incremental' : 'full',
    cursor: safeCursor,
  }
}
