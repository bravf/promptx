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

function itemIdentities(entry) {
  const type = entry.item?.type
  if (!type) return []
  return [
    entry.providerMessageId,
    entry.item.clientMessageId,
    entry.item.messageId,
    entry.item.callId,
  ].filter(Boolean).map((id) => `${type}:${id}`)
}

function shouldImportProviderItem(entry, rows) {
  const typeRows = rows.filter((row) => row.item.type === entry.item.type)
  if (entry.item.type === 'user_message') return typeRows.length === 0
  if (entry.item.type === 'system_notice') return !typeRows.some(row => row.item.code === entry.item.code && row.item.text === entry.item.text)

  const identities = new Set(itemIdentities(entry))
  const sameItem = identities.size > 0 && typeRows.some((row) => (
    itemIdentities(row).some((identity) => identities.has(identity))
  ))
  if (sameItem) {
    // 工具状态可以继续追加，由 Timeline 投影合并生命周期；文本已经由本地流完整保存。
    return entry.item.type === 'tool_call'
  }
  if (entry.item.type === 'assistant_message') {
    // Provider 行按消息身份补充；只有本地实时流存在同 phase 内容时才优先保留本地版本。
    // 过程消息不能证明最终回复已经存在。
    const phase = entry.item.phase || 'unknown'
    return !typeRows.some((row) => row.source !== 'provider' && (row.item.phase || 'unknown') === phase)
  }
  if (entry.item.type === 'reasoning' && typeRows.some((row) => row.source !== 'provider')) return false
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
  // 仅依据原始历史明确标记的消息身份清理旧占位内容，不按文字删除正常消息。
  const ignoredIdentities = new Set((snapshot.ignoredItems || []).flatMap(itemIdentities))
  const ignoredRows = localRows.filter(row => itemIdentities(row).some(id => ignoredIdentities.has(id)))
  const ignoredRuntimeIds = new Set((snapshot.ignoredItems || []).map(entry => entry.runtimeTurnId).filter(Boolean))
  const placeholderTurnIds = localTurns.filter(turn => (
    TERMINAL_HISTORY_STATUSES.has(turn.status)
    && (ignoredRuntimeIds.has(turn.nativeTurnId) || ignoredRuntimeIds.has(turn.providerPromptId))
    && localRows.filter(row => row.turnId === turn.id).every(row => ignoredRows.includes(row)
      || (row.item.type === 'system_notice' && row.item.code === 'autonomous_turn'))
  )).map(turn => turn.id)
  if (ignoredRows.length) localRows = localRows.filter(row => !ignoredRows.includes(row))
  // 旧版把系统任务通知导入成用户轮次，同时实时流另存了自动续跑。
  // 只清理完全由 Provider 导入、且有相同 runtime 身份的重复轮次；真实本地输入不受影响。
  const supersededTurnIds = snapshot.turns.filter(turn => turn.taskNotification && TERMINAL_HISTORY_STATUSES.has(turn.status)).flatMap(turn => {
    const live = localTurns.find(local => local.nativeTurnId === turn.runtimeTurnId && local.clientMessageId?.startsWith('autonomous:'))
    if (!live) return []
    return localTurns.filter(local => local.id !== live.id && local.providerPromptId === turn.providerPromptId
      && TERMINAL_HISTORY_STATUSES.has(local.status)
      && localRows.filter(row => row.turnId === local.id).every(row => row.source === 'provider')).map(local => local.id)
  })
  supersededTurnIds.push(...placeholderTurnIds)
  if (supersededTurnIds.length) {
    localTurns = localTurns.filter(turn => !supersededTurnIds.includes(turn.id))
    localRows = localRows.filter(row => !supersededTurnIds.includes(row.turnId))
  }
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
  if (!ignoredRows.length && !supersededTurnIds.length && !checkedTurnIds.length && syncState?.sourceId === snapshot.sourceId
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
  const requiresRebuild = ignoredRows.length > 0 || supersededTurnIds.length > 0 || (snapshot.completeness !== 'incremental' && Boolean(previous) && !commonPrefixMatches)

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
      supersededTurnIds,
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
