import { computed, ref } from 'vue'

export const WORKBENCH_SEND_BEHAVIOR = {
  ENTER: 'enter',
  SHIFT_ENTER: 'shift_enter',
  BUTTON_ONLY: 'button_only',
}

export const WORKBENCH_SEND_BEHAVIOR_OPTIONS = [
  {
    value: WORKBENCH_SEND_BEHAVIOR.ENTER,
    labelKey: 'settingsDialog.general.sendBehavior.options.enter.label',
    descriptionKey: 'settingsDialog.general.sendBehavior.options.enter.description',
  },
  {
    value: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
    labelKey: 'settingsDialog.general.sendBehavior.options.shiftEnter.label',
    descriptionKey: 'settingsDialog.general.sendBehavior.options.shiftEnter.description',
  },
  {
    value: WORKBENCH_SEND_BEHAVIOR.BUTTON_ONLY,
    labelKey: 'settingsDialog.general.sendBehavior.options.buttonOnly.label',
    descriptionKey: 'settingsDialog.general.sendBehavior.options.buttonOnly.description',
  },
]

export const WORKBENCH_PREFERENCE_KEYS = {
  SEND_BEHAVIOR: 'sendBehavior',
  NOTIFICATION_SOUND_ENABLED: 'notificationSoundEnabled',
}

export const WORKBENCH_PREFERENCE_STORAGE = {
  CLIENT: 'client',
  SERVER: 'server',
}

export const WORKBENCH_PREFERENCES_STORAGE_KEY = 'promptx:workbench-preferences'

const WORKBENCH_PREFERENCE_DEFINITIONS = {
  [WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR]: {
    key: WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR,
    section: 'general',
    storage: WORKBENCH_PREFERENCE_STORAGE.CLIENT,
    defaultValue: WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER,
  },
  [WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED]: {
    key: WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED,
    section: 'general',
    storage: WORKBENCH_PREFERENCE_STORAGE.CLIENT,
    defaultValue: false,
  },
}

const preferenceStorageAdapters = {
  [WORKBENCH_PREFERENCE_STORAGE.CLIENT]: {
    loadAll() {
      if (typeof window === 'undefined') {
        return {}
      }

      try {
        const payload = JSON.parse(window.localStorage.getItem(WORKBENCH_PREFERENCES_STORAGE_KEY) || '{}')
        return payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {}
      } catch {
        return {}
      }
    },
    saveAll(preferences = {}) {
      if (typeof window === 'undefined') {
        return
      }

      window.localStorage.setItem(
        WORKBENCH_PREFERENCES_STORAGE_KEY,
        JSON.stringify(preferences)
      )
    },
  },
  [WORKBENCH_PREFERENCE_STORAGE.SERVER]: {
    loadAll() {
      return {}
    },
    saveAll() {},
  },
}

const workbenchPreferences = ref(createDefaultWorkbenchPreferences())
const workbenchPreferencesReady = ref(false)

function createDefaultWorkbenchPreferences() {
  return {
    [WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR]: WORKBENCH_PREFERENCE_DEFINITIONS[WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR].defaultValue,
    [WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED]: WORKBENCH_PREFERENCE_DEFINITIONS[WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED].defaultValue,
  }
}

function normalizeSendBehavior(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === WORKBENCH_SEND_BEHAVIOR.ENTER) {
    return WORKBENCH_SEND_BEHAVIOR.ENTER
  }
  if (normalized === WORKBENCH_SEND_BEHAVIOR.BUTTON_ONLY) {
    return WORKBENCH_SEND_BEHAVIOR.BUTTON_ONLY
  }
  return WORKBENCH_SEND_BEHAVIOR.SHIFT_ENTER
}

function normalizeNotificationSoundEnabled(value = false) {
  if (typeof value === 'string') {
    const normalized = String(value).trim().toLowerCase()
    if (['1', 'true', 'on', 'yes'].includes(normalized)) {
      return true
    }
    if (['0', 'false', 'off', 'no', ''].includes(normalized)) {
      return false
    }
  }

  return Boolean(value)
}

function normalizeWorkbenchPreferences(input = {}) {
  return {
    [WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR]: normalizeSendBehavior(input?.[WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR]),
    [WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED]: normalizeNotificationSoundEnabled(input?.[WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED]),
  }
}

function loadPreferencesByStorage(storage = WORKBENCH_PREFERENCE_STORAGE.CLIENT) {
  return preferenceStorageAdapters[storage]?.loadAll?.() || {}
}

function savePreferencesByStorage(storage = WORKBENCH_PREFERENCE_STORAGE.CLIENT, preferences = {}) {
  preferenceStorageAdapters[storage]?.saveAll?.(preferences)
}

export function initializeWorkbenchPreferences() {
  const defaults = createDefaultWorkbenchPreferences()
  const clientPreferences = loadPreferencesByStorage(WORKBENCH_PREFERENCE_STORAGE.CLIENT)
  const serverPreferences = loadPreferencesByStorage(WORKBENCH_PREFERENCE_STORAGE.SERVER)
  const merged = normalizeWorkbenchPreferences({
    ...defaults,
    ...clientPreferences,
    ...serverPreferences,
  })

  workbenchPreferences.value = merged
  savePreferencesByStorage(WORKBENCH_PREFERENCE_STORAGE.CLIENT, merged)
  workbenchPreferencesReady.value = true
  return merged
}

export function getWorkbenchPreferenceDefinition(key = '') {
  return WORKBENCH_PREFERENCE_DEFINITIONS[String(key || '').trim()] || null
}

export function getWorkbenchPreference(key = '') {
  const definition = getWorkbenchPreferenceDefinition(key)
  if (!definition) {
    return undefined
  }

  return workbenchPreferences.value[definition.key]
}

export function setWorkbenchPreference(key = '', value) {
  const definition = getWorkbenchPreferenceDefinition(key)
  if (!definition) {
    return workbenchPreferences.value
  }

  const nextPreferences = normalizeWorkbenchPreferences({
    ...workbenchPreferences.value,
    [definition.key]: value,
  })

  workbenchPreferences.value = nextPreferences

  const storage = definition.storage || WORKBENCH_PREFERENCE_STORAGE.CLIENT
  if (storage === WORKBENCH_PREFERENCE_STORAGE.CLIENT) {
    savePreferencesByStorage(storage, nextPreferences)
  }

  workbenchPreferencesReady.value = true
  return nextPreferences
}

export function shouldSendOnWorkbenchKeydown(event, options = {}) {
  const key = String(event?.key || '')
  const sendBehavior = normalizeSendBehavior(options?.sendBehavior)

  if (key !== 'Enter') {
    return false
  }

  if (options?.isComposing) {
    return false
  }

  if (!options?.isEditing) {
    return false
  }

  if (event?.metaKey || event?.ctrlKey || event?.altKey) {
    return false
  }

  if (sendBehavior === WORKBENCH_SEND_BEHAVIOR.BUTTON_ONLY) {
    return false
  }

  if (sendBehavior === WORKBENCH_SEND_BEHAVIOR.ENTER) {
    return !event?.shiftKey
  }

  return Boolean(event?.shiftKey)
}

export function useWorkbenchPreferences() {
  const preferences = computed(() => workbenchPreferences.value)
  const sendBehavior = computed(() => getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR))
  const notificationSoundEnabled = computed(() => getWorkbenchPreference(WORKBENCH_PREFERENCE_KEYS.NOTIFICATION_SOUND_ENABLED))

  return {
    preferences,
    sendBehavior,
    notificationSoundEnabled,
    workbenchPreferencesReady,
    initializeWorkbenchPreferences,
    getPreference: getWorkbenchPreference,
    setPreference: setWorkbenchPreference,
  }
}
