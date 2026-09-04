import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStableHistoryFile, textContent, toIsoTimestamp } from '../historySnapshot.js'

const PROJECT_DIR_LENGTH_CAP = 200

function hashSuffix(input) {
  let hash = 0
  for (let index = 0; index < input.length; index += 1) hash = ((hash << 5) - hash + input.charCodeAt(index)) | 0
  return Math.abs(hash).toString(36)
}

function encodeProjectPath(input) {
  const replaced = input.replace(/[^a-zA-Z0-9]/g, '-')
  return replaced.length <= PROJECT_DIR_LENGTH_CAP
    ? replaced
    : `${replaced.slice(0, PROJECT_DIR_LENGTH_CAP)}-${hashSuffix(input)}`
}

function resolveHistoryPath(cwd, sessionId) {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')
  const candidates = [cwd]
  try {
    const real = fs.realpathSync(cwd)
    if (real !== cwd) candidates.push(real)
  } catch {}
  for (const candidate of candidates) {
    const file = path.join(configDir, 'projects', encodeProjectPath(candidate), `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return file
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

function visibleUser(entry) {
  if (entry.type !== 'user' || entry.isSidechain || entry.isMeta || entry.isCompactSummary) return false
  const content = entry.message?.content
  if (Array.isArray(content) && content.some((block) => block?.type === 'tool_result')) return false
  return Boolean(textContent(content).trim())
}

function toolResult(entry, tools) {
  if (entry.type !== 'user' || !Array.isArray(entry.message?.content)) return
  for (const block of entry.message.content) {
    if (block?.type !== 'tool_result' || !block.tool_use_id) continue
    const target = tools.get(block.tool_use_id)
    if (!target) continue
    target.item = {
      ...target.item,
      status: block.is_error ? 'failed' : 'completed',
      detail: { ...target.item.detail, output: textContent(block.content) || block.content },
      ...(block.is_error ? { error: { message: textContent(block.content) || '工具调用失败' } } : {}),
    }
  }
}

function appendAssistant(entry, turn, tools) {
  if (entry.type !== 'assistant' || entry.isSidechain) return
  const content = Array.isArray(entry.message?.content) ? entry.message.content : []
  const hasTool = content.some((block) => block?.type === 'tool_use')
  content.forEach((block, index) => {
    const providerMessageId = block.id || `${entry.uuid || entry.message?.id}:${index}`
    if (block?.type === 'text' && block.text) {
      turn.items.push({
        providerMessageId,
        timestamp: toIsoTimestamp(entry.timestamp),
        item: {
          type: 'assistant_message',
          messageId: entry.message?.id || entry.uuid,
          phase: hasTool || entry.message?.stop_reason === 'tool_use' ? 'commentary'
            : entry.message?.stop_reason === 'end_turn' ? 'final_answer' : 'unknown',
          text: block.text,
        },
      })
    } else if (block?.type === 'thinking' && block.thinking) {
      turn.items.push({
        providerMessageId,
        timestamp: toIsoTimestamp(entry.timestamp),
        item: { type: 'reasoning', messageId: entry.message?.id || entry.uuid, text: block.thinking },
      })
    } else if (block?.type === 'tool_use' && block.id) {
      const item = {
        providerMessageId: block.id,
        timestamp: toIsoTimestamp(entry.timestamp),
        item: {
          type: 'tool_call',
          callId: block.id,
          name: block.name || '工具调用',
          status: 'running',
          detail: { type: 'claude_tool', input: block.input },
        },
      }
      turn.items.push(item)
      tools.set(block.id, item)
    }
  })
  turn.lastStopReason = entry.message?.stop_reason || turn.lastStopReason
  turn.finishedAt = toIsoTimestamp(entry.timestamp) || turn.finishedAt
}

export function mapClaudeHistorySnapshot(sessionId, content, revision = '') {
  const turns = []
  let turn = null
  let tools = new Map()
  for (const entry of parseLines(content)) {
    if (visibleUser(entry)) {
      if (turn) {
        turn.status = 'completed'
        turns.push(turn)
      }
      const timestamp = toIsoTimestamp(entry.timestamp)
      turn = {
        sourceTurnId: entry.uuid,
        status: 'running',
        startedAt: timestamp,
        finishedAt: timestamp,
        lastStopReason: '',
        items: [{
          providerMessageId: entry.uuid,
          timestamp,
          item: {
            type: 'user_message',
            clientMessageId: entry.uuid,
            content: [{ type: 'text', text: textContent(entry.message?.content) }],
          },
        }],
      }
      tools = new Map()
      continue
    }
    if (!turn) continue
    appendAssistant(entry, turn, tools)
    toolResult(entry, tools)
  }
  if (turn) {
    turn.status = turn.lastStopReason === 'end_turn' ? 'completed' : 'running'
    turns.push(turn)
  }
  return {
    sourceId: sessionId,
    revision,
    turns: turns.map(({ lastStopReason, ...value }) => value),
  }
}

export function readClaudeHistorySnapshot({ cwd, sessionId, knownRevision = '' }) {
  if (!sessionId) return { status: 'unsupported' }
  const file = resolveHistoryPath(cwd, sessionId)
  if (!file) return { status: 'unavailable' }
  const result = readStableHistoryFile(file, knownRevision)
  if (result.status !== 'ready') return result
  return mapClaudeHistorySnapshot(sessionId, result.content, result.revision)
}
