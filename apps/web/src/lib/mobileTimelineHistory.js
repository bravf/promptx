export const MOBILE_TIMELINE_HISTORY_KEY = 'promptxV2MobileView'

export function hasMobileTimelineHistoryState(state) {
  return state?.[MOBILE_TIMELINE_HISTORY_KEY] === 'timeline'
}

export function createMobileTimelineHistoryState(state) {
  return {
    ...(state || {}),
    [MOBILE_TIMELINE_HISTORY_KEY]: 'timeline',
  }
}
