export const MOBILE_TIMELINE_HISTORY_KEY = 'promptxV2MobileView'
export const MOBILE_TIMELINE_TASK_KEY = 'promptxV2MobileTaskId'

export function hasMobileTimelineHistoryState(state) {
  return state?.[MOBILE_TIMELINE_HISTORY_KEY] === 'timeline'
}

export function getMobileTimelineTaskId(state) {
  if (!hasMobileTimelineHistoryState(state)) return ''
  return typeof state?.[MOBILE_TIMELINE_TASK_KEY] === 'string'
    ? state[MOBILE_TIMELINE_TASK_KEY].trim()
    : ''
}

export function createMobileTimelineHistoryState(state, taskId = '') {
  const nextState = {
    ...(state || {}),
    [MOBILE_TIMELINE_HISTORY_KEY]: 'timeline',
  }
  const normalizedTaskId = String(taskId || '').trim()
  if (normalizedTaskId) nextState[MOBILE_TIMELINE_TASK_KEY] = normalizedTaskId
  else delete nextState[MOBILE_TIMELINE_TASK_KEY]
  return nextState
}
