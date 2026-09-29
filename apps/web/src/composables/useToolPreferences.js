import { readonly, ref } from 'vue'

export const TOOL_AUTO_EXPAND_KEY = 'promptx:tools:auto-expand'
const autoExpand = ref(false)
let initialized = false
export function useToolPreferences() {
  if (!initialized && typeof window !== 'undefined') {
    initialized = true
    try { autoExpand.value = localStorage.getItem(TOOL_AUTO_EXPAND_KEY) === 'true' } catch { /* 无持久化权限时保留内存设置 */ }
    window.addEventListener('storage', event => {
      if (event.key === TOOL_AUTO_EXPAND_KEY || event.key === null) autoExpand.value = event.newValue === 'true'
    })
  }
  function setAutoExpand(value) {
    autoExpand.value = Boolean(value)
    try { localStorage.setItem(TOOL_AUTO_EXPAND_KEY, String(autoExpand.value)) } catch { /* 当前窗口仍生效 */ }
  }
  return { autoExpand: readonly(autoExpand), setAutoExpand }
}
