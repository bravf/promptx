import { createHistoryManifest, historyItemKey, TERMINAL_HISTORY_STATUSES } from './historySnapshot.js'

const LEGACY_MATCH_TIME_WINDOW_MS = 5_000

function firstUserClientId(turn) {
  return turn.items.find((entry) => entry.item.type === 'user_message')?.item.clientMessageId || ''
}

function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function contentText(content = []) {
  return normalizedText(content.map((block) => block?.type === 'text' ? block.text : '').join('\n'))
}

function providerUserText(turn) {
  return contentText(turn.items.find((entry) => entry.item.type === 'user_message')?.item.content)
}

function localUserText(rows, turnId) {
  return contentText(rows.find((row) => row.turnId === turnId && row.item.type === 'user_message')?.item.content)
}

function turnTimestamp(turn) {
  const value = Date.parse(turn.startedAt || turn.createdAt || turn.finishedAt || '')
  return Number.isFinite(value) ? value : null
}

function chronologicalTurns(turns) {
  return [...turns].sort((left, right) => {
    const leftTime = turnTimestamp(left)
    const rightTime = turnTimestamp(right)
    if (leftTime !== null && rightTime !== null && leftTime !== rightTime) return leftTime - rightTime
    if (leftTime !== null && rightTime === null) return -1
    if (leftTime === null && rightTime !== null) return 1
    return String(left.id || '').localeCompare(String(right.id || ''))
  })
}

function providerRows(turn, localTurnId = '') {
  return turn.items.map((entry) => ({
    sourceTurnId: turn.sourceTurnId,
    ...(localTurnId ? { localTurnId } : {}),
    timestamp: entry.timestamp || turn.finishedAt || turn.startedAt,
    providerMessageId: entry.providerMessageId,
    source: 'provider',
    item: entry.item,
  }))
}

function preservedLocalRows(rows, localTurnId = '') {
  return rows.map((row) => ({
    ...(localTurnId ? { localTurnId } : {}),
    timestamp: row.timestamp,
    source: row.source || 'local',
    providerMessageId: row.providerMessageId,
    item: row.item,
  }))
}

function publicTurn(turn, localTurnId = '') {
  return {
    sourceTurnId: turn.sourceTurnId,
    providerPromptId: turn.providerPromptId || turn.sourceTurnId,
    runtimeTurnId: turn.runtimeTurnId || '',
    ...(localTurnId ? { localTurnId } : {}),
    clientMessageId: firstUserClientId(turn),
    status: turn.status,
    historyState: TERMINAL_HISTORY_STATUSES.has(turn.status) ? 'confirmed' : 'pending',
    errorMessage: turn.errorMessage || '',
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
  }
}

function localItemIdentity(row) {
  const id = row.providerMessageId || row.item?.clientMessageId || row.item?.messageId || row.item?.callId
  return id ? `${row.item.type}:${id}` : ''
}

function shouldImportProviderItem(entry, rows) {
  const typeRows = rows.filter((row) => row.item.type === entry.item.type)
  if (entry.item.type === 'user_message') return typeRows.length === 0

  const key = historyItemKey(entry)
  if (key && typeRows.some((row) => localItemIdentity(row) === key)) {
    // 工具状态可以继续追加，由 Timeline 投影合并生命周期；文本已经由本地流完整保存。
    return entry.item.type === 'tool_call'
  }
  if (['assistant_message', 'reasoning'].includes(entry.item.type) && typeRows.length) return false
  return !typeRows.some((row) => JSON.stringify(row.item) === JSON.stringify(entry.item))
}

function matchProviderTurns(settled, localTurns, localRows) {
  const orderedLocal = chronologicalTurns(localTurns)
  const byPrompt = new Map()
  const byRuntime = new Map()
  const byClient = new Map()
  const byText = new Map()
  for (const turn of orderedLocal) {
    if (turn.providerPromptId) byPrompt.set(turn.providerPromptId, turn)
    if (turn.nativeTurnId) byRuntime.set(turn.nativeTurnId, turn)
    if (turn.clientMessageId) byClient.set(turn.clientMessageId, turn)
    const text = localUserText(localRows, turn.id)
    if (text) byText.set(text, [...(byText.get(text) || []), turn])
  }

  const matched = new Map()
  const used = new Set()
  const bind = (providerTurn, localTurn) => {
    if (!localTurn || used.has(localTurn.id)) return false
    matched.set(providerTurn.sourceTurnId, localTurn)
    used.add(localTurn.id)
    return true
  }

  for (const turn of settled) {
    const promptId = turn.providerPromptId || turn.sourceTurnId
    const exact = byPrompt.get(promptId)
      || byRuntime.get(turn.runtimeTurnId || turn.sourceTurnId)
      || byClient.get(firstUserClientId(turn))
    if (bind(turn, exact)) continue

    // 旧 Provider 记录没有透传 clientMessageId 时，才使用文本和时间绑定。
    const text = providerUserText(turn)
    const candidates = (byText.get(text) || []).filter((candidate) => !used.has(candidate.id))
    const providerTime = turnTimestamp(turn)
    const timed = providerTime === null ? [] : candidates
      .map((candidate) => ({ candidate, distance: Math.abs((turnTimestamp(candidate) ?? Number.POSITIVE_INFINITY) - providerTime) }))
      .filter(({ distance }) => Number.isFinite(distance) && distance <= LEGACY_MATCH_TIME_WINDOW_MS)
      .sort((left, right) => left.distance - right.distance)
    bind(turn, timed[0]?.candidate || (text && candidates.length === 1 ? candidates[0] : null))
  }
  return matched
}

export function reconcileHistory({
  snapshot,
  localRows = [],
  localTurns = [],
  syncState = null,
  checkedTurnIds = [],
}) {
  const snapshotManifest = createHistoryManifest(snapshot)
  const previous = syncState?.sourceId === snapshot.sourceId ? syncState.manifest : null
  const manifest = snapshot.completeness === 'incremental' && previous
    ? {
        ...snapshotManifest,
        turns: [...new Map([
          ...(previous.turns || []).map((turn) => [turn.sourceTurnId, turn]),
          ...snapshotManifest.turns.map((turn) => [turn.sourceTurnId, turn]),
        ]).values()],
      }
    : snapshotManifest
  if (!checkedTurnIds.length && syncState?.sourceId === snapshot.sourceId
    && JSON.stringify(syncState.manifest || null) === JSON.stringify(manifest)) {
    return { mode: 'noop', changed: false, manifest, turns: [], rows: [], checkedTurnIds, confirmedTurnIds: [] }
  }
  const settled = snapshot.turns.filter((turn) => TERMINAL_HISTORY_STATUSES.has(turn.status))
  const matched = matchProviderTurns(settled, localTurns, localRows)
  const turns = settled.map((turn) => publicTurn(turn, matched.get(turn.sourceTurnId)?.id))
  const rows = []

  for (const turn of settled) {
    const local = matched.get(turn.sourceTurnId)
    if (!local) {
      rows.push(...providerRows(turn))
      continue
    }
    const existing = localRows.filter((row) => row.turnId === local.id)
    const missing = turn.items.filter((entry) => shouldImportProviderItem(entry, existing))
    rows.push(...providerRows({ ...turn, items: missing }, local.id))
  }

  const manifestChanged = JSON.stringify(previous || null) !== JSON.stringify(manifest)
  const previousIds = (previous?.turns || []).map((turn) => turn.sourceTurnId)
  const currentIds = settled.map((turn) => turn.sourceTurnId)
  const commonPrefixMatches = Array.from({ length: Math.min(previousIds.length, currentIds.length) })
    .every((_, index) => previousIds[index] === currentIds[index])
  const requiresRebuild = snapshot.completeness !== 'incremental' && Boolean(previous) && !commonPrefixMatches

  if (requiresRebuild) {
    const groups = []
    const matchedLocalIds = new Set()
    for (const turn of settled) {
      const local = matched.get(turn.sourceTurnId)
      if (local) matchedLocalIds.add(local.id)
      const existing = local ? localRows.filter((row) => row.turnId === local.id) : []
      const missing = turn.items.filter((entry) => shouldImportProviderItem(entry, existing))
      const groupRows = [
        ...preservedLocalRows(existing, local?.id),
        ...providerRows({ ...turn, items: missing }, local?.id),
      ]
      groups.push({ timestamp: turn.startedAt || turn.finishedAt || '', rows: groupRows })
    }
    for (const local of localTurns) {
      if (matchedLocalIds.has(local.id)) continue
      groups.push({
        timestamp: local.createdAt || local.startedAt || local.finishedAt || '',
        rows: preservedLocalRows(localRows.filter((row) => row.turnId === local.id), local.id),
      })
    }
    for (const row of localRows.filter((entry) => !entry.turnId)) {
      groups.push({ timestamp: row.timestamp, rows: preservedLocalRows([row]) })
    }
    groups.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)))
    return {
      mode: 'rebuild',
      changed: true,
      manifest,
      turns,
      rows: groups.flatMap((group) => group.rows),
      checkedTurnIds,
      confirmedTurnIds: turns.flatMap((turn) => turn.localTurnId ? [turn.localTurnId] : []),
    }
  }
  return {
    mode: 'merge',
    changed: manifestChanged || rows.length > 0,
    manifest,
    turns,
    rows,
    checkedTurnIds,
    confirmedTurnIds: turns.flatMap((turn) => turn.localTurnId ? [turn.localTurnId] : []),
  }
}

export { historyItemKey }
