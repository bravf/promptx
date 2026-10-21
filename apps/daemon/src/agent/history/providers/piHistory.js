import {
  parseJsonLinesWithOffsets,
  readStableHistoryFileRange,
  textContent,
  toIsoTimestamp,
} from '../historySnapshot.js'

function timelineText(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => block.text || '').join('\n')
}

function terminalStatus(reason) {
  if (reason === 'aborted' || reason === 'cancelled' || reason === 'canceled') return 'canceled'
  if (reason === 'error' || reason === 'max_turn_requests') return 'failed'
  return reason === 'stop' || reason === 'length' ? 'completed' : ''
}

export function mapPiHistorySnapshot(sessionId, content, revision = '', { baseOffset = 0 } = {}) {
  const records = Array.isArray(content) ? content : parseJsonLinesWithOffsets(String(content || ''), baseOffset)
  const entries = records.map(record => record?.value && Number.isSafeInteger(record.offset)
    ? { ...record.value, offset: record.offset }
    : record)

  // Pi sessions are trees. Keep only the active branch ending at the final persisted entry.
  const byId = new Map(entries.filter(entry => entry?.id).map(entry => [entry.id, entry]))
  const branch = []
  let current = entries.at(-1)
  const seen = new Set()
  while (current && !seen.has(current.id)) {
    if (current.id) seen.add(current.id)
    branch.push(current)
    current = current.parentId ? byId.get(current.parentId) : null
  }
  branch.reverse()

  const turns = []
  let turn = null
  let turnStartOffset = 0
  const toolCalls = new Map()
  const closeTurn = (status, timestamp, errorMessage = '') => {
    if (!turn) return
    turn.status = status
    turn.finishedAt = timestamp || turn.finishedAt
    if (errorMessage) turn.errorMessage = errorMessage
    turns.push(turn)
    turn = null
    toolCalls.clear()
  }
  const addItem = (id, timestamp, item) => {
    if (!turn) return
    turn.items.push({ providerMessageId: id, timestamp, item })
  }

  for (const entry of branch) {
    if (entry.type !== 'message' || !entry.message || !entry.id) continue
    const message = entry.message
    const timestamp = toIsoTimestamp(entry.timestamp)
    if (message.role === 'user') {
      if (turn) closeTurn('completed', timestamp)
      turnStartOffset = entry.offset ?? turnStartOffset
      const text = timelineText(message.content)
      turn = {
        sourceTurnId: entry.id,
        providerPromptId: entry.id,
        status: 'running',
        startedAt: timestamp,
        finishedAt: timestamp,
        items: text ? [{
          providerMessageId: entry.id,
          timestamp,
          item: { type: 'user_message', clientMessageId: entry.id, content: [{ type: 'text', text }] },
        }] : [],
      }
      continue
    }
    if (!turn) continue
    turn.finishedAt = timestamp || turn.finishedAt
    const messageId = message.id || entry.id
    if (message.role === 'assistant') {
      for (const [index, block] of (message.content || []).entries()) {
        if (block.type === 'text' && block.text) {
          addItem(`${messageId}:text:${index}`, timestamp, { type: 'assistant_message', phase: 'unknown', messageId, text: block.text })
        } else if (block.type === 'thinking' && block.thinking) {
          addItem(`${messageId}:thinking:${index}`, timestamp, { type: 'reasoning', messageId, text: block.thinking })
        } else if (block.type === 'toolCall' && block.id) {
          const call = {
            type: 'tool_call', callId: block.id, name: block.name || 'Pi 工具', status: 'running',
            detail: { type: 'acp_tool', kind: block.name || '', rawInput: block.arguments ?? {} },
          }
          toolCalls.set(block.id, call)
          addItem(block.id, timestamp, call)
        }
      }
      const status = terminalStatus(message.stopReason)
      if (status) closeTurn(status, timestamp, status === 'failed' ? message.errorMessage || 'Pi 模型请求失败。' : '')
    } else if (message.role === 'toolResult') {
      const call = toolCalls.get(message.toolCallId)
      if (!call) continue
      call.status = message.isError ? 'failed' : 'completed'
      call.detail = { ...call.detail, ...(message.details !== undefined ? { rawOutput: message.details } : { rawOutput: textContent(message.content) }) }
      if (message.isError) call.error = { message: timelineText(message.content) || 'Pi 工具执行失败。' }
    } else if (message.role === 'bashExecution') {
      const id = `pi-bash:${entry.id}`
      addItem(id, timestamp, {
        type: 'tool_call', callId: id, name: 'bash',
        status: message.cancelled ? 'canceled' : message.exitCode === 0 ? 'completed' : 'failed',
        detail: { type: 'shell', command: message.command || '', output: message.output || '', exitCode: message.exitCode ?? null },
        ...(message.exitCode && message.exitCode !== 0 ? { error: { message: `命令退出码：${message.exitCode}` } } : {}),
      })
    }
  }
  if (turn) turns.push(turn)
  const lastTurn = turns.at(-1)
  const safeCursor = lastTurn?.status === 'running' ? turnStartOffset : (baseOffset + Buffer.byteLength(String(content || '').slice(0, Math.max(0, String(content || '').lastIndexOf('\n') + 1))) )
  return {
    sourceId: sessionId,
    revision,
    turns,
    ...(lastTurn?.status === 'running' ? { runningTurnStartOffset: turnStartOffset } : {}),
    safeCursor,
  }
}

export function readPiHistorySnapshot({ sessionId, sessionFile, knownRevision = '', cursor = 0 }) {
  if (!sessionId || !sessionFile) return { status: 'unavailable' }
  const result = readStableHistoryFileRange(sessionFile, { knownRevision, cursor })
  if (result.status !== 'ready') return result.status === 'unchanged' ? { ...result, sourceId: sessionId } : result
  const snapshot = mapPiHistorySnapshot(sessionId, result.content, result.revision, { baseOffset: result.baseOffset })
  const { safeCursor, runningTurnStartOffset, ...history } = snapshot
  return {
    ...history,
    completeness: result.baseOffset > 0 && !result.reset ? 'incremental' : 'full',
    cursor: safeCursor,
  }
}
