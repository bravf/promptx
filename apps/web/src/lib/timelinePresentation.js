const PROCESS_ITEM_TYPES = new Set(['reasoning', 'tool_call', 'todo'])
export const TURN_DELAY_THRESHOLD_MS = 45_000

function isProviderRetryEntry(entry) {
  return entry.item?.type === 'system_notice' && entry.item.code === 'provider_retrying'
}

function isProcessEntry(entry) {
  return PROCESS_ITEM_TYPES.has(entry.item?.type)
    || (entry.item?.type === 'assistant_message' && entry.item.phase === 'commentary')
    || isProviderRetryEntry(entry)
}

function hasRenderableAssistantText(entry) {
  return entry.item?.type !== 'assistant_message' || String(entry.item.text || '').trim().length > 0
}

function mergeAssistantOutputEntries(entries = []) {
  const result = []
  for (const entry of entries) {
    const previous = result.at(-1)
    if (entry.item?.type !== 'assistant_message' || previous?.item?.type !== 'assistant_message') {
      result.push({
        ...entry,
        item: { ...entry.item },
        ...(entry.sourceSeqRanges ? { sourceSeqRanges: [...entry.sourceSeqRanges] } : {}),
        ...(entry.collapsed ? { collapsed: [...entry.collapsed] } : {}),
      })
      continue
    }

    const previousText = String(previous.item.text || '').trimEnd()
    const nextText = String(entry.item.text || '').trimStart()
    previous.item = {
      ...previous.item,
      text: previousText && nextText ? `${previousText}\n\n${nextText}` : previousText || nextText,
    }
    previous.timestamp = entry.timestamp
    previous.seqEnd = Math.max(previous.seqEnd, entry.seqEnd)
    previous.sourceSeqRanges = [
      ...(previous.sourceSeqRanges || []),
      ...(entry.sourceSeqRanges || []),
    ]
    previous.collapsed = [...new Set([...(previous.collapsed || []), ...(entry.collapsed || []), 'turn_assistant_merge'])]
  }
  return result
}

function validTime(value) {
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? time : null
}

export function groupTimelineTurns(entries = []) {
  const turns = new Map()
  const result = []

  for (const entry of entries) {
    if (!entry.turnId) {
      result.push(entry)
      continue
    }

    let turn = turns.get(entry.turnId)
    if (!turn) {
      turn = {
        presentationType: 'turn',
        key: `turn:${entry.turnId}`,
        turnId: entry.turnId,
        timestamp: entry.timestamp,
        seqStart: entry.seqStart,
        seqEnd: entry.seqEnd,
        userEntries: [],
        processEntries: [],
        outputEntries: [],
      }
      turns.set(entry.turnId, turn)
      result.push(turn)
    }
    turn.seqStart = Math.min(turn.seqStart, entry.seqStart)
    turn.seqEnd = Math.max(turn.seqEnd, entry.seqEnd)
    turn.timestamp = entry.timestamp

    if (entry.item?.type === 'user_message') turn.userEntries.push(entry)
    else if (isProcessEntry(entry)) turn.processEntries.push(entry)
    else turn.outputEntries.push(entry)
  }

  for (const turn of turns.values()) {
    const allEntries = [...turn.userEntries, ...turn.processEntries, ...turn.outputEntries]
    const latestEntry = allEntries.reduce((latest, entry) => (
      !latest || entry.seqEnd > latest.seqEnd ? entry : latest
    ), null)
    turn.processEntries = turn.processEntries
      .filter(hasRenderableAssistantText)
      .filter((entry) => !isProviderRetryEntry(entry) || entry === latestEntry)
    turn.outputEntries = mergeAssistantOutputEntries(turn.outputEntries.filter(hasRenderableAssistantText))
  }

  return result
}

export function getTurnActivityState(turn, {
  running = false,
  now = Date.now(),
  delayThresholdMs = TURN_DELAY_THRESHOLD_MS,
} = {}) {
  if (!running) return { status: 'completed', inactiveFor: 0 }
  const entries = [...turn.userEntries, ...turn.processEntries, ...turn.outputEntries]
  const latestEntry = entries.reduce((latest, entry) => (
    !latest || entry.seqEnd > latest.seqEnd ? entry : latest
  ), null)
  const lastActivityAt = validTime(latestEntry?.timestamp)
  const inactiveFor = lastActivityAt === null ? 0 : Math.max(0, now - lastActivityAt)
  if (isProviderRetryEntry(latestEntry)) return { status: 'retrying', inactiveFor, lastActivityAt }
  if (lastActivityAt !== null && inactiveFor >= delayThresholdMs) {
    return { status: 'delayed', inactiveFor, lastActivityAt }
  }
  return { status: 'active', inactiveFor, lastActivityAt }
}

export function createTurnTimingMap(rows = [], turns = []) {
  const rowBounds = new Map()
  for (const row of rows) {
    if (!row.turnId) continue
    const time = validTime(row.timestamp)
    if (time === null) continue
    const bounds = rowBounds.get(row.turnId)
    if (!bounds) rowBounds.set(row.turnId, { first: time, last: time })
    else {
      bounds.first = Math.min(bounds.first, time)
      bounds.last = Math.max(bounds.last, time)
    }
  }

  const turnById = new Map(turns.map((turn) => [turn.id, turn]))
  const ids = new Set([...rowBounds.keys(), ...turnById.keys()])
  const result = new Map()
  for (const id of ids) {
    const turn = turnById.get(id)
    const bounds = rowBounds.get(id)
    const startedAt = validTime(turn?.startedAt) ?? validTime(turn?.createdAt) ?? bounds?.first ?? null
    const terminal = turn && !['queued', 'running'].includes(turn.status)
    const finishedAt = validTime(turn?.finishedAt) ?? ((terminal || !turn) ? bounds?.last ?? null : null)
    result.set(id, {
      status: turn?.status || 'unknown',
      startedAt,
      finishedAt,
    })
  }
  return result
}

export function isTimelineTurnRunning({
  agentRunning = false,
  latestTurnId = '',
  turnId = '',
  turnStatus = 'unknown',
} = {}) {
  if (!agentRunning || !turnId || turnId !== latestTurnId) return false
  return ['unknown', 'queued', 'running'].includes(turnStatus)
}

export function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}小时 ${String(minutes).padStart(2, '0')}分钟 ${String(seconds).padStart(2, '0')}秒`
  if (minutes) return `${minutes}分钟 ${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

function localDateKey(date) {
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`
}

function messageClock(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

export function formatMessageTime(timestamp, now = Date.now()) {
  const time = validTime(timestamp)
  if (time === null) return ''
  const date = new Date(time)
  const reference = new Date(now instanceof Date ? now.getTime() : now)
  if (!Number.isFinite(reference.getTime())) return messageClock(date)
  const clock = messageClock(date)
  if (localDateKey(date) === localDateKey(reference)) return clock
  const yesterday = new Date(reference.getFullYear(), reference.getMonth(), reference.getDate() - 1)
  if (localDateKey(date) === localDateKey(yesterday)) return `昨天 ${clock}`
  const dateLabel = `${date.getMonth() + 1}月${date.getDate()}日`
  return date.getFullYear() === reference.getFullYear()
    ? `${dateLabel} ${clock}`
    : `${date.getFullYear()}年${dateLabel} ${clock}`
}

export function formatMessageDateTime(timestamp) {
  const time = validTime(timestamp)
  if (time === null) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(time)
}

export function userMessageCopyText(content = []) {
  return content.map((block) => block.type === 'text' ? block.text : `[${block.type === 'image' ? '图片' : '附件'}] ${block.name}`).filter(Boolean).join('\n')
}
