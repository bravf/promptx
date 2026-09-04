export const MOBILE_DIALOG_HISTORY_KEY = 'promptxV2MobileDialog'

const MOBILE_DIALOG_IDS = new Set(['conversation', 'import', 'settings'])

export function getMobileDialogHistoryState(state) {
  const dialogId = state?.[MOBILE_DIALOG_HISTORY_KEY]
  return MOBILE_DIALOG_IDS.has(dialogId) ? dialogId : ''
}

export function createMobileDialogHistoryState(state, dialogId) {
  if (!MOBILE_DIALOG_IDS.has(dialogId)) return { ...(state || {}) }
  return {
    ...(state || {}),
    [MOBILE_DIALOG_HISTORY_KEY]: dialogId,
  }
}
