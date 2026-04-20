import { onBeforeUnmount, unref, watchEffect } from 'vue'

const DEFAULT_PAGE_TITLE = 'PromptX'

export function formatPageTitle(title = '') {
  const normalizedTitle = String(unref(title) || '').trim()
  return normalizedTitle ? `${DEFAULT_PAGE_TITLE} (${normalizedTitle})` : DEFAULT_PAGE_TITLE
}

export function usePageTitle(title = '', options = {}) {
  const applyTitle = () => {
    if (typeof document === 'undefined') {
      return
    }

    const normalizedTitle = String(unref(title) || '').trim()
    document.title = unref(options.raw)
      ? normalizedTitle || DEFAULT_PAGE_TITLE
      : formatPageTitle(normalizedTitle)
  }

  watchEffect(applyTitle)

  onBeforeUnmount(() => {
    if (typeof document === 'undefined') {
      return
    }
    document.title = DEFAULT_PAGE_TITLE
  })
}
