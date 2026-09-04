import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readStableHistoryFile, textContent, toIsoTimestamp } from '../historySnapshot.js'

function resolveWirePath(sessionId) {
  const root = path.join(process.env.KIMI_HOME || path.join(os.homedir(), '.kimi'), 'sessions')
  if (!fs.existsSync(root)) return null
  for (const directory of fs.readdirSync(root, { withFileTypes: true })) {
    if (!directory.isDirectory()) continue
    const file = path.join(root, directory.name, sessionId, 'wire.jsonl')
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

function kimiUserText(input) {
  if (typeof input === 'string') return input
  return textContent(input)
}

export function mapKimiHistorySnapshot(sessionId, content, revision = '') {
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

export function readKimiHistorySnapshot(sessionId, { knownRevision = '' } = {}) {
  if (!sessionId) return { status: 'unsupported' }
  const file = resolveWirePath(sessionId)
  if (!file) return { status: 'unavailable' }
  const result = readStableHistoryFile(file, knownRevision)
  if (result.status !== 'ready') return result
  return mapKimiHistorySnapshot(sessionId, result.content, result.revision)
}
