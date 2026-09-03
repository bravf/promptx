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
    turn.processEntries = turn.processEntries.filter((entry) => (
      !isProviderRetryEntry(entry) || entry === latestEntry
    ))
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

export function formatElapsedTime(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(Number(milliseconds || 0) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours) return `${hours}小时 ${String(minutes).padStart(2, '0')}分钟 ${String(seconds).padStart(2, '0')}秒`
  if (minutes) return `${minutes}分钟 ${String(seconds).padStart(2, '0')}秒`
  return `${seconds}秒`
}

export function formatMessageTime(timestamp) {
  const time = validTime(timestamp)
  if (time === null) return ''
  return new Intl.DateTimeFormat('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(time)
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
