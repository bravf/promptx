import {
  parseJsonLinesWithOffsets,
  readStableHistoryFileRange,
  toIsoTimestamp,
} from '../historySnapshot.js'
import { acpContentText, mergeAcpToolCall } from '../../providers/acpEvents.js'

export function extractAcpUpdate(record) {
  if (!record || typeof record !== 'object') return null
  const params = record.params && typeof record.params === 'object' ? record.params : record
  const update = params.update && typeof params.update === 'object' ? params.update : record.update
  if (!update?.sessionUpdate) return null
  return {
    method: record.method || '',
    sessionId: params.sessionId || '',
    update,
    timestamp: record.timestamp,
    meta: { ...(params._meta || {}), ...(update._meta || {}) },
  }
}

function turnStatusFromStopReason(stopReason) {
  if (stopReason === 'cancelled' || stopReason === 'canceled') return 'canceled'
  if (stopReason === 'error' || stopReason === 'max_turn_requests' || stopReason === 'refusal') return 'failed'
  return 'completed'
}

function appendTextItem(turn, type, text, timestamp, itemOrdinal) {
  const last = turn.items.at(-1)
  if (last?.item?.type === type && typeof last.item.text === 'string') {
    last.item.text += text
    last.timestamp = timestamp || last.timestamp
    return
  }
  const id = `${turn.sourceTurnId}:${type === 'reasoning' ? 'thought' : 'message'}:${itemOrdinal.value++}`
  turn.items.push({
    providerMessageId: id,
    timestamp,
    item: type === 'reasoning'
      ? { type, messageId: id, text }
      : { type, messageId: id, phase: 'final_answer', text },
  })
}

function nativeTurnId(meta = {}) {
  if (meta.promptId) return String(meta.promptId)
  if (meta.promptIndex !== undefined && meta.promptIndex !== null) return `acp-turn:${meta.promptIndex}`
  return ''
}

// Grok updates.jsonl：轮次边界和 prompt 元数据是 Grok 的存储约定。
export function mapGrokHistorySnapshot(sessionId, content, revision = '', { baseOffset = 0 } = {}) {
  const turns = []
  let turn = null
  let tools = new Map()
  const itemOrdinal = { value: 0 }
  const records = Array.isArray(content)
    ? content
    : parseJsonLinesWithOffsets(String(content || ''), baseOffset)

  function closeTurn(status, timestamp, errorMessage = '') {
    if (!turn) return
    turn.status = status
    turn.finishedAt = timestamp || turn.finishedAt
    if (errorMessage) turn.errorMessage = errorMessage
    turns.push(turn)
    turn = null
    tools = new Map()
  }

  for (const record of records) {
    const raw = record && typeof record === 'object' && 'value' in record ? record.value : record
    const offset = Number.isSafeInteger(record?.offset) ? record.offset : undefined
    const extracted = extractAcpUpdate(raw)
    if (!extracted) continue
    const { update, timestamp: rawTimestamp, meta } = extracted
    const timestamp = toIsoTimestamp(meta.agentTimestampMs || rawTimestamp)
    const kind = update.sessionUpdate

    if (kind === 'user_message_chunk') {
      const text = acpContentText(update.content)
      if (!text) continue
      const collectingUser = Boolean(turn && turn.items.every((entry) => entry.item.type === 'user_message'))
      const sourceTurnId = nativeTurnId(meta) || (collectingUser ? turn.sourceTurnId : `acp-offset:${offset ?? turns.length}`)
      const sameTurn = turn && (
        turn.sourceTurnId === sourceTurnId
        || (meta.promptId && (turn.providerPromptId === meta.promptId || turn.sourceTurnId === meta.promptId))
        || (collectingUser && !nativeTurnId(meta))
      )
      if (sameTurn) {
        const userItem = turn.items.find((entry) => entry.item.type === 'user_message')
        if (userItem?.item?.content?.[0]) {
          userItem.item.content[0].text += text
          userItem.timestamp = timestamp || userItem.timestamp
        }
        if (meta.promptId) turn.providerPromptId = meta.promptId
        turn.finishedAt = timestamp || turn.finishedAt
        continue
      }
      if (turn) closeTurn('completed', timestamp)
      turn = {
        sourceTurnId,
        providerPromptId: meta.promptId || sourceTurnId,
        startOffset: offset,
        status: 'running',
        startedAt: timestamp,
        finishedAt: timestamp,
        items: [{
          providerMessageId: `${sourceTurnId}:user`,
          timestamp,
          item: { type: 'user_message', clientMessageId: `${sourceTurnId}:user`, content: [{ type: 'text', text }] },
        }],
      }
      itemOrdinal.value = 0
      tools = new Map()
      continue
    }

    if (kind === 'turn_completed') {
      const promptId = update.prompt_id || update.promptId
      if (promptId && turn) turn.providerPromptId = promptId
      closeTurn(turnStatusFromStopReason(update.stop_reason), timestamp, update.stop_reason === 'error' ? (update.agent_result || update.message || 'ACP Turn 失败') : '')
      continue
    }

    if (kind === 'retry_state' && update.type === 'failed') {
      closeTurn('failed', timestamp, update.message || update.reason || 'ACP Turn 失败')
      continue
    }

    if (!turn) continue
    turn.finishedAt = timestamp || turn.finishedAt
    if (meta.promptId) turn.providerPromptId = meta.promptId

    if (kind === 'agent_thought_chunk') {
      const text = acpContentText(update.content)
      if (text) appendTextItem(turn, 'reasoning', text, timestamp, itemOrdinal)
    } else if (kind === 'agent_message_chunk') {
      const text = acpContentText(update.content)
      if (text) appendTextItem(turn, 'assistant_message', text, timestamp, itemOrdinal)
    } else if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = update.toolCallId || `${turn.sourceTurnId}:tool:${itemOrdinal.value++}`
      const previous = tools.get(id)
      const entry = {
        providerMessageId: id,
        timestamp,
        item: mergeAcpToolCall(previous?.item, { ...update, toolCallId: id }),
      }
      if (previous) {
        previous.timestamp = timestamp
        previous.item = entry.item
      } else {
        turn.items.push(entry)
        tools.set(id, entry)
      }
    } else if (kind === 'plan') {
      const id = `${turn.sourceTurnId}:plan`
      const item = {
        type: 'todo',
        items: (update.entries || []).map((entry) => ({ text: entry.content || entry.text || '', status: entry.status })),
      }
      const existing = turn.items.find((entry) => entry.providerMessageId === id)
      if (existing) {
        existing.timestamp = timestamp
        existing.item = item
      } else {
        turn.items.push({ providerMessageId: id, timestamp, item })
      }
    }
  }
  if (turn) turns.push(turn)
  const runningTurnStartOffset = turns.at(-1)?.status === 'running' ? turns.at(-1).startOffset : undefined
  return {
    sourceId: sessionId,
    revision,
    turns: turns.map(({ startOffset, ...item }) => item),
    runningTurnStartOffset,
  }
}

export function readGrokHistoryFile(sessionId, file, { knownRevision = '', cursor = 0 } = {}) {
  if (!sessionId || !file) return { status: 'unavailable' }
  const result = readStableHistoryFileRange(file, { knownRevision, cursor })
  if (result.status !== 'ready') return result
  const records = parseJsonLinesWithOffsets(result.content, result.baseOffset)
  const snapshot = mapGrokHistorySnapshot(sessionId, records, result.revision, { baseOffset: result.baseOffset })
  let safeCursor = result.content.endsWith('\n')
    ? result.endOffset
    : result.baseOffset + Buffer.byteLength(result.content.slice(0, Math.max(0, result.content.lastIndexOf('\n') + 1)))
  if (snapshot.turns.at(-1)?.status === 'running' && Number.isSafeInteger(snapshot.runningTurnStartOffset)) {
    safeCursor = snapshot.runningTurnStartOffset
  }
  const { runningTurnStartOffset, ...history } = snapshot
  return {
    ...history,
    completeness: result.baseOffset > 0 && !result.reset ? 'incremental' : 'full',
    cursor: safeCursor,
  }
}
