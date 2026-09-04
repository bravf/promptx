import { createHistoryManifest, historyItemKey, historyTurnFingerprint, TERMINAL_HISTORY_STATUSES } from './historySnapshot.js'

function firstUserClientId(turn) {
  return turn.items.find((entry) => entry.item.type === 'user_message')?.item.clientMessageId || ''
}

function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

function providerUserText(turn) {
  const content = turn.items.find((entry) => entry.item.type === 'user_message')?.item.content || []
  return normalizedText(content.map((block) => block.type === 'text' ? block.text : '').join('\n'))
}

function localUserText(rows, turnId) {
  const content = rows.find((row) => row.turnId === turnId && row.item.type === 'user_message')?.item.content || []
  return normalizedText(content.map((block) => block.type === 'text' ? block.text : '').join('\n'))
}

function providerRows(turn) {
  return turn.items.map((entry) => ({
    sourceTurnId: turn.sourceTurnId,
    timestamp: entry.timestamp || turn.finishedAt || turn.startedAt,
    providerMessageId: entry.providerMessageId,
    item: entry.item,
  }))
}

function localRowsForTurn(rows, localTurnId) {
  return rows.filter((row) => row.turnId === localTurnId).map((row) => ({
    localTurnId,
    timestamp: row.timestamp,
    providerMessageId: row.providerMessageId,
    item: row.item,
  }))
}

function sameManifest(previous, next) {
  return previous?.sourceId === next.sourceId
    && (previous.revision || '') === (next.revision || '')
    && JSON.stringify(previous.turns || []) === JSON.stringify(next.turns || [])
}

function terminalTurns(snapshot) {
  return snapshot.turns.filter((turn) => TERMINAL_HISTORY_STATUSES.has(turn.status))
}

function publicTurn(turn, localTurnId = '') {
  return {
    sourceTurnId: turn.sourceTurnId,
    ...(localTurnId ? { localTurnId } : {}),
    clientMessageId: firstUserClientId(turn),
    status: turn.status,
    errorMessage: turn.errorMessage || '',
    startedAt: turn.startedAt,
    finishedAt: turn.finishedAt,
  }
}

export function reconcileHistory({ snapshot, localRows = [], localTurns = [], syncState = null, activeTurnId = '' }) {
  const manifest = createHistoryManifest(snapshot)
  if (syncState?.sourceId === snapshot.sourceId && sameManifest(syncState.manifest, manifest)) {
    return { mode: 'noop', changed: false, manifest, turns: [], rows: [] }
  }

  const settled = terminalTurns(snapshot)
  const localTurnBySource = new Map()
  const localTurnByClient = new Map()
  const localTurnsByText = new Map()
  for (const turn of localTurns) {
    if (turn.nativeTurnId) localTurnBySource.set(turn.nativeTurnId, turn)
    if (turn.clientMessageId) localTurnByClient.set(turn.clientMessageId, turn)
    const text = localUserText(localRows, turn.id)
    if (text) localTurnsByText.set(text, [...(localTurnsByText.get(text) || []), turn])
  }
  const providerTextCounts = new Map()
  for (const turn of settled) {
    const text = providerUserText(turn)
    if (text) providerTextCounts.set(text, (providerTextCounts.get(text) || 0) + 1)
  }
  const matchedLocalTurn = new Map()
  for (const turn of settled) {
    let local = localTurnBySource.get(turn.sourceTurnId) || localTurnByClient.get(firstUserClientId(turn))
    if (!local) {
      const text = providerUserText(turn)
      const candidates = localTurnsByText.get(text) || []
      if (text && providerTextCounts.get(text) === 1 && candidates.length === 1) local = candidates[0]
    }
    if (local) matchedLocalTurn.set(turn.sourceTurnId, local)
  }
  if (!matchedLocalTurn.size && settled.length === localTurns.length && settled.length > 0) {
    const providerTexts = settled.map(providerUserText)
    const localTexts = localTurns.slice().reverse().map((turn) => localUserText(localRows, turn.id))
    if (providerTexts.every(Boolean) && JSON.stringify(providerTexts) === JSON.stringify(localTexts)) {
      settled.forEach((turn, index) => matchedLocalTurn.set(turn.sourceTurnId, localTurns.slice().reverse()[index]))
    }
  }

  const previousTurns = syncState?.sourceId === snapshot.sourceId ? (syncState.manifest?.turns || []) : []
  const previousById = new Map(previousTurns.map((turn) => [turn.sourceTurnId, turn]))
  const settledIds = settled.map((turn) => turn.sourceTurnId)
  const previousSettled = previousTurns.filter((turn) => TERMINAL_HISTORY_STATUSES.has(turn.status))
  const prefixUnchanged = previousSettled.every((turn, index) => (
    settled[index]?.sourceTurnId === turn.sourceTurnId
    && historyTurnFingerprint(settled[index]) === turn.fingerprint
  ))

  const matchedIndexes = settled.flatMap((turn, index) => matchedLocalTurn.has(turn.sourceTurnId) ? [index] : [])
  const lastMatchedIndex = matchedIndexes.length ? Math.max(...matchedIndexes) : -1
  const missingIndexes = settled.flatMap((turn, index) => matchedLocalTurn.has(turn.sourceTurnId) ? [] : [index])
  const onlyTailMissing = missingIndexes.every((index) => index > lastMatchedIndex)
  const hasReliableBoundary = matchedIndexes.length > 0 || localTurns.length === 0 || settled.length === 0
  // 本地 Turn 可能先于 Provider 回复创建。如果指纹是新增或发生变化，直接
  // append 会保留本地占位，从而静默丢失后续 reasoning/assistant item；此时
  // 必须重建已结束历史，让完整的 Provider Turn 替换占位内容。
  const hasChangedMatchedTurn = settled.some((turn) => {
    if (!matchedLocalTurn.has(turn.sourceTurnId)) return false
    const previous = previousById.get(turn.sourceTurnId)
    return Boolean(syncState) && (!previous || previous.fingerprint !== historyTurnFingerprint(turn))
  })
  const canAppend = (syncState ? prefixUnchanged : true)
    && onlyTailMissing
    && hasReliableBoundary
    && !hasChangedMatchedTurn

  if (canAppend) {
    const missing = missingIndexes.map((index) => settled[index])
    return {
      mode: 'append',
      changed: missing.length > 0,
      manifest,
      turns: settled.map((turn) => publicTurn(turn, matchedLocalTurn.get(turn.sourceTurnId)?.id)),
      rows: missing.flatMap(providerRows),
    }
  }

  const rows = localRows.filter((row) => !row.turnId).map((row) => ({
    timestamp: row.timestamp,
    providerMessageId: row.providerMessageId,
    item: row.item,
  }))
  const retainedLocalIds = new Set()
  for (const turn of settled) {
    const local = matchedLocalTurn.get(turn.sourceTurnId)
    const previous = previousById.get(turn.sourceTurnId)
    const unchanged = !syncState || Boolean(previous && previous.fingerprint === historyTurnFingerprint(turn))
    if (local && unchanged) {
      retainedLocalIds.add(local.id)
      rows.push(...localRowsForTurn(localRows, local.id))
    } else {
      rows.push(...providerRows(turn))
    }
  }

  const knownProviderIds = new Set(previousTurns.map((turn) => turn.sourceTurnId))
  for (const turn of localTurns) {
    if (retainedLocalIds.has(turn.id)) continue
    const belongsToRemovedProviderTurn = turn.nativeTurnId && knownProviderIds.has(turn.nativeTurnId)
    if (belongsToRemovedProviderTurn && turn.id !== activeTurnId) continue
    const preserveUnmatchedInitialTurn = !syncState && turn.status !== 'completed'
    const preserveUnmatchedKnownTurn = Boolean(syncState) && !belongsToRemovedProviderTurn
    if (
      (preserveUnmatchedInitialTurn || preserveUnmatchedKnownTurn || turn.id === activeTurnId)
      && !matchedLocalTurn.has(turn.nativeTurnId)
      && (!turn.nativeTurnId || !settledIds.includes(turn.nativeTurnId))
    ) {
      rows.push(...localRowsForTurn(localRows, turn.id))
    }
  }

  return {
    mode: 'replace',
    changed: true,
    manifest,
    turns: settled.map((turn) => publicTurn(turn, matchedLocalTurn.get(turn.sourceTurnId)?.id)),
    rows,
  }
}

export { historyItemKey }
