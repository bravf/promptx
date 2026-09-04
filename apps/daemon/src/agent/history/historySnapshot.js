import { createHash } from 'node:crypto'
import fs from 'node:fs'

export const TERMINAL_HISTORY_STATUSES = new Set(['completed', 'failed', 'canceled'])

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
    sourceId: snapshot.sourceId,
    revision: snapshot.revision || '',
    turns: snapshot.turns.map((turn) => ({
      sourceTurnId: turn.sourceTurnId,
      status: turn.status,
      fingerprint: historyTurnFingerprint(turn),
    })),
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
