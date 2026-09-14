export const SPLIT_TIMELINE_STORAGE_KEY = 'promptx:v2:timeline-layout'

const DEFAULT_STATE = Object.freeze({
  enabled: false,
  primaryTaskId: '',
  secondaryTaskId: '',
  focusedPane: 'primary',
})

function normalizeTaskId(value) {
  return typeof value === 'string' ? value.trim() : ''
}

export function normalizeSplitTimelineState(value = {}) {
  const enabled = Boolean(value?.enabled)
  const primaryTaskId = normalizeTaskId(value?.primaryTaskId)
  const secondaryTaskId = normalizeTaskId(value?.secondaryTaskId)
  return {
    enabled,
    primaryTaskId,
    secondaryTaskId: secondaryTaskId === primaryTaskId ? '' : secondaryTaskId,
    focusedPane: enabled && value?.focusedPane === 'secondary' ? 'secondary' : 'primary',
  }
}

export function readSplitTimelineState(storage) {
  try {
    const target = storage || globalThis.localStorage
    const raw = target?.getItem(SPLIT_TIMELINE_STORAGE_KEY)
    return raw ? normalizeSplitTimelineState(JSON.parse(raw)) : { ...DEFAULT_STATE }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function writeSplitTimelineState(value, storage) {
  try {
    const target = storage || globalThis.localStorage
    target?.setItem(SPLIT_TIMELINE_STORAGE_KEY, JSON.stringify(normalizeSplitTimelineState(value)))
  } catch {}
}

export function resolveSplitTimelineState(value, availableTaskIds, fallbackTaskId = '') {
  const state = normalizeSplitTimelineState(value)
  const available = availableTaskIds instanceof Set ? availableTaskIds : new Set(availableTaskIds || [])
  const hadStoredSecondaryTask = Boolean(state.secondaryTaskId)
  let primaryTaskId = available.has(state.primaryTaskId) ? state.primaryTaskId : ''
  let secondaryTaskId = available.has(state.secondaryTaskId) ? state.secondaryTaskId : ''
  let focusedPane = state.focusedPane
  let enabled = state.enabled

  if (!primaryTaskId && secondaryTaskId) {
    primaryTaskId = secondaryTaskId
    secondaryTaskId = ''
    focusedPane = 'primary'
    enabled = false
  }
  if (!primaryTaskId && available.has(fallbackTaskId)) {
    primaryTaskId = fallbackTaskId
    focusedPane = 'primary'
  }
  if (!primaryTaskId) {
    primaryTaskId = available.values().next().value || ''
    focusedPane = 'primary'
  }
  if (secondaryTaskId === primaryTaskId) secondaryTaskId = ''
  if (hadStoredSecondaryTask && !secondaryTaskId) enabled = false

  return {
    enabled: enabled && Boolean(primaryTaskId),
    primaryTaskId,
    secondaryTaskId: enabled ? secondaryTaskId : '',
    focusedPane: enabled && focusedPane === 'secondary' ? 'secondary' : 'primary',
  }
}
