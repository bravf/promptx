import { createHash } from 'node:crypto'
import fs from 'node:fs'

export const TERMINAL_HISTORY_STATUSES = new Set(['completed', 'failed', 'canceled'])
export const HISTORY_RECONCILER_VERSION = 5

export function historyItemKey(entry) {
  if (!entry?.item) return ''
  const id = entry.providerMessageId
    || entry.item.clientMessageId
    || entry.item.messageId
    || entry.item.callId
  return id ? `${entry.item.type}:${id}` : ''
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]))
}

export function historyTurnFingerprint(turn) {
  const value = {
    sourceTurnId: turn.sourceTurnId,
    status: turn.status,
    items: turn.items.map((entry) => ({ key: historyItemKey(entry), item: stableValue(entry.item) })),
  }
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function createHistoryManifest(snapshot) {
  return {
    reconcilerVersion: HISTORY_RECONCILER_VERSION,
    sourceId: snapshot.sourceId,
    revision: snapshot.revision || '',
    completeness: snapshot.completeness || 'full',
    cursor: Number.isSafeInteger(snapshot.cursor) ? snapshot.cursor : 0,
    turns: snapshot.turns.map((turn) => ({
      sourceTurnId: turn.sourceTurnId,
      status: turn.status,
      fingerprint: historyTurnFingerprint(turn),
    })),
  }
}

export function assertHistorySnapshot(snapshot) {
  if (!snapshot || typeof snapshot.sourceId !== 'string' || !snapshot.sourceId || !Array.isArray(snapshot.turns)) {
    const error = new Error('Provider History Adapter 返回了无效快照。')
    error.code = 'HISTORY_SNAPSHOT_INVALID'
    throw error
  }
  const turnIds = new Set()
  for (const turn of snapshot.turns) {
    if (!turn?.sourceTurnId || turnIds.has(turn.sourceTurnId) || !['running', 'completed', 'failed', 'canceled'].includes(turn.status)) {
      const error = new Error('Provider History Adapter 返回了无效 Turn。')
      error.code = 'HISTORY_SNAPSHOT_INVALID'
      throw error
    }
    turnIds.add(turn.sourceTurnId)
    if (!Array.isArray(turn.items)) {
      const error = new Error('Provider History Adapter 返回了无效 Timeline items。')
      error.code = 'HISTORY_SNAPSHOT_INVALID'
      throw error
    }
  }
  return {
    ...snapshot,
    completeness: snapshot.completeness === 'incremental' ? 'incremental' : 'full',
  }
}

function fileRevision(stat) {
  return `${stat.size}:${stat.mtimeMs}`
}

export function readStableHistoryFile(file, knownRevision = '') {
  let revision
  try {
    revision = fileRevision(fs.statSync(file))
  } catch {
    return { status: 'unavailable', revision: '' }
  }
  if (knownRevision && revision === knownRevision) return { status: 'unchanged', revision }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    let content
    let nextRevision
    try {
      content = fs.readFileSync(file, 'utf8')
      nextRevision = fileRevision(fs.statSync(file))
    } catch {
      return { status: 'unavailable', revision }
    }
    if (nextRevision === revision) return { status: 'ready', revision, content }
    revision = nextRevision
  }
  return { status: 'unavailable', revision }
}

export function readStableHistoryFileRange(file, { knownRevision = '', cursor = 0 } = {}) {
  let stat
  try {
    stat = fs.statSync(file)
  } catch {
    return { status: 'unavailable', revision: '' }
  }
  let revision = fileRevision(stat)
  if (knownRevision && revision === knownRevision) return { status: 'unchanged', revision }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const requestedOffset = Number.isSafeInteger(cursor) && cursor >= 0 && cursor <= stat.size ? cursor : 0
    const length = Math.max(0, stat.size - requestedOffset)
    const buffer = Buffer.alloc(length)
    let bytesRead = 0
    let descriptor
    try {
      descriptor = fs.openSync(file, 'r')
      while (bytesRead < length) {
        const read = fs.readSync(descriptor, buffer, bytesRead, length - bytesRead, requestedOffset + bytesRead)
        if (!read) break
        bytesRead += read
      }
      fs.closeSync(descriptor)
      descriptor = undefined
      const next = fs.statSync(file)
      const nextRevision = fileRevision(next)
      if (nextRevision === revision) {
        return {
          status: 'ready',
          revision,
          content: buffer.subarray(0, bytesRead).toString('utf8'),
          baseOffset: requestedOffset,
          endOffset: requestedOffset + bytesRead,
          reset: requestedOffset !== cursor,
        }
      }
      stat = next
      revision = nextRevision
    } catch {
      if (descriptor !== undefined) try { fs.closeSync(descriptor) } catch {}
      return { status: 'unavailable', revision }
    }
  }
  return { status: 'unavailable', revision }
}

export function parseJsonLinesWithOffsets(content, baseOffset = 0) {
  const records = []
  let charOffset = 0
  let byteOffset = baseOffset
  while (charOffset < content.length) {
    const newline = content.indexOf('\n', charOffset)
    const end = newline < 0 ? content.length : newline + 1
    const raw = content.slice(charOffset, end)
    const line = raw.replace(/\r?\n$/, '')
    if (line.trim()) {
      try { records.push({ value: JSON.parse(line), offset: byteOffset }) } catch {}
    }
    byteOffset += Buffer.byteLength(raw)
    charOffset = end
  }
  return records
}

export function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  }
  const time = Date.parse(value || '')
  return Number.isFinite(time) ? new Date(time).toISOString() : undefined
}

export function textContent(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((block) => block?.type === 'text' ? block.text || '' : '').filter(Boolean).join('\n')
}
