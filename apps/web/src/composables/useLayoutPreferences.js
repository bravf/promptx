import { computed, readonly, ref } from 'vue'

const STORAGE_KEY = 'promptx:layout:content-width'
const contentWidth = ref('fixed')
let initialized = false
const normalize = value => value === 'full' ? 'full' : 'fixed'
const contentWidthClass = computed(() => contentWidth.value === 'full' ? 'max-w-none' : 'max-w-3xl')

export function useLayoutPreferences() {
  if (!initialized && typeof window !== 'undefined') {
    initialized = true
    try { contentWidth.value = normalize(window.localStorage.getItem(STORAGE_KEY)) } catch { /* 无持久化权限时使用默认布局 */ }
    window.addEventListener('storage', event => {
      if (event.key === STORAGE_KEY || event.key === null) contentWidth.value = normalize(event.newValue)
    })
  }
  function setContentWidth(value) {
    contentWidth.value = normalize(value)
    try { window.localStorage.setItem(STORAGE_KEY, contentWidth.value) } catch { /* 当前窗口仍生效 */ }
  }
  return { contentWidth: readonly(contentWidth), contentWidthClass, setContentWidth }
}
