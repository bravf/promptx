import { computed, ref } from 'vue'
import { DEFAULT_THEME_ID, THEME_PRESET_MAP, THEME_PRESETS, THEME_STORAGE_KEY } from '../lib/themes.js'

const themeId = ref(DEFAULT_THEME_ID)
const themeReady = ref(false)
let mediaQuery = null
let mobileMediaQuery = null

function isMobileThemeRestricted() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false
  }

  return window.matchMedia('(max-width: 1023px)').matches
}

function getBrowserThemeFallback() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return DEFAULT_THEME_ID
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'promptx-stone-dark'
    : DEFAULT_THEME_ID
}

function resolveTheme(id = '') {
  return THEME_PRESET_MAP[String(id || '').trim()] || THEME_PRESET_MAP[DEFAULT_THEME_ID]
}

function isThemeAvailableOnCurrentDevice(theme) {
  if (!theme) {
    return false
  }

  if (!isMobileThemeRestricted()) {
    return true
  }

  return theme.mobileEnabled !== false
}

function resolveEffectiveTheme(id = '') {
  const preferredTheme = resolveTheme(id)
  if (isThemeAvailableOnCurrentDevice(preferredTheme)) {
    return preferredTheme
  }

  return resolveTheme(DEFAULT_THEME_ID)
}

function applyThemeToDocument(nextTheme) {
  if (typeof document === 'undefined' || !nextTheme) {
    return
  }

  const root = document.documentElement
  root.dataset.theme = nextTheme.id
  root.classList.toggle('dark', nextTheme.mode === 'dark')
  root.style.colorScheme = nextTheme.mode

  // 未指定字体的主题使用全局默认值，避免沿用上一个主题的字体。
  root.style.removeProperty('--theme-fontSans')
  root.style.removeProperty('--theme-primaryIcon')
  Object.entries(nextTheme.colors || {}).forEach(([token, value]) => {
    root.style.setProperty(`--theme-${token}`, String(value))
  })
}

export function initializeTheme() {
  if (typeof window === 'undefined') {
    return resolveEffectiveTheme(DEFAULT_THEME_ID)
  }

  const storedThemeId = window.localStorage.getItem(THEME_STORAGE_KEY)
  const preferredTheme = resolveTheme(storedThemeId || getBrowserThemeFallback())
  const nextTheme = resolveEffectiveTheme(preferredTheme.id)
  themeId.value = preferredTheme.id
  applyThemeToDocument(nextTheme)
  window.localStorage.setItem(THEME_STORAGE_KEY, preferredTheme.id)
  themeReady.value = true

  if (!mediaQuery && typeof window.matchMedia === 'function') {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
    mediaQuery.addEventListener?.('change', () => {
      if (window.localStorage.getItem(THEME_STORAGE_KEY)) {
        return
      }
      const fallbackTheme = resolveTheme(getBrowserThemeFallback())
      themeId.value = fallbackTheme.id
      applyThemeToDocument(resolveEffectiveTheme(fallbackTheme.id))
    })
  }

  if (!mobileMediaQuery && typeof window.matchMedia === 'function') {
    mobileMediaQuery = window.matchMedia('(max-width: 1023px)')
    mobileMediaQuery.addEventListener?.('change', () => {
      applyThemeToDocument(resolveEffectiveTheme(themeId.value))
    })
  }

  return nextTheme
}

export function useTheme() {
  const currentTheme = computed(() => resolveEffectiveTheme(themeId.value))
  const isDark = computed(() => currentTheme.value.mode === 'dark')
  const themes = computed(() => THEME_PRESETS.filter((theme) => isThemeAvailableOnCurrentDevice(theme)))

  function setTheme(nextThemeId) {
    const preferredTheme = resolveTheme(nextThemeId)
    themeId.value = preferredTheme.id

    if (typeof window !== 'undefined') {
      window.localStorage.setItem(THEME_STORAGE_KEY, preferredTheme.id)
    }

    applyThemeToDocument(resolveEffectiveTheme(preferredTheme.id))
    themeReady.value = true
  }

  return {
    currentTheme,
    isDark,
    setTheme,
    themeId,
    themeReady,
    themes,
  }
}
