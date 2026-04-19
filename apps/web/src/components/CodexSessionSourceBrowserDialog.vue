<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import {
  ArrowLeftRight,
  ChevronRight,
  File,
  FileImage,
  FolderOpen,
  LoaderCircle,
  Search,
} from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import SelectionInsertButton from './SelectionInsertButton.vue'
import { useCodeSelectionAction } from '../composables/useCodeSelectionAction.js'
import { useI18n } from '../composables/useI18n.js'
import { useTheme } from '../composables/useTheme.js'
import { useWorkspacePickerData } from '../composables/useWorkspacePickerData.js'
import {
  getCodexSessionFileContent,
  searchCodexSessionFileContent,
} from '../lib/api.js'
import {
  exceedsHighlightThresholdForCode,
  renderSourceCodePreview,
  SOURCE_PREVIEW_HIGHLIGHT_LIMITS,
} from '../lib/sourceCodePreview.js'
import {
  isAbortError,
  WORKSPACE_CONTENT_SEARCH_DEBOUNCE_MS,
  WORKSPACE_PREVIEW_SELECTION_DEBOUNCE_MS,
  WORKSPACE_SEARCH_MIN_QUERY_LENGTH,
} from '../lib/workspaceSearch.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  session: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['close', 'insert-code-context'])
const { t } = useI18n()
const { isDark } = useTheme()

const pickerProps = reactive({
  open: false,
  sessionId: '',
  query: '',
})

const selectedPath = ref('')
const selectedItemType = ref('')
const previewLoading = ref(false)
const previewError = ref('')
const previewPayload = ref(null)
const searchInput = ref('')
const searchMode = ref('path')
const contentSearchResults = ref([])
const contentSearchLoading = ref(false)
const contentSearchError = ref('')
const contentSearchExecutedQuery = ref('')
const contentSearchTruncated = ref(false)
const contentSearchActiveKey = ref('')
const contentSearchItemRefs = new Map()
const searchInputRef = ref(null)
const previewContainerRef = ref(null)
const previewFocusLine = ref(0)
const previewMatchLines = ref([])
const previewSearchQuery = ref('')

let previewRequestId = 0
let contentSearchRequestId = 0
let contentSearchTimer = null
let contentSearchAbortController = null
const CONTENT_SEARCH_DEBOUNCE_MS = WORKSPACE_CONTENT_SEARCH_DEBOUNCE_MS
const PREVIEW_SELECTION_DEBOUNCE_MS = WORKSPACE_PREVIEW_SELECTION_DEBOUNCE_MS
const PREVIEW_CACHE_LIMIT = 20
let previewSelectionTimer = null
const previewPayloadCache = new Map()

const sessionId = computed(() => String(props.session?.id || '').trim())
const sessionCwd = computed(() => String(props.session?.cwd || '').trim())
const isPathSearchMode = computed(() => searchMode.value !== 'content')
const isContentSearchMode = computed(() => searchMode.value === 'content')
const normalizedSearchInput = computed(() => String(searchInput.value || '').trim())
const isSearchKeywordReady = computed(() => normalizedSearchInput.value.length >= WORKSPACE_SEARCH_MIN_QUERY_LENGTH)
const previewTitle = computed(() => previewPayload.value?.name || selectedPath.value || '')
const previewPath = computed(() => previewPayload.value?.path || selectedPath.value || '')
const previewSizeLabel = computed(() => formatFileSize(previewPayload.value?.size || 0))
const previewMetaLabel = computed(() => {
  const parts = []
  if (previewPath.value || previewTitle.value) {
    parts.push(previewPath.value || previewTitle.value)
  }
  if (previewPayload.value?.size) {
    parts.push(previewSizeLabel.value)
  }
  if (previewPayload.value?.truncated) {
    parts.push(t('sourceBrowser.truncated'))
  }
  return parts.join('  ')
})
const showImagePreview = computed(() => Boolean(previewPayload.value?.previewUrl))
const showBinaryState = computed(() => Boolean(previewPayload.value?.binary && !previewPayload.value?.previewUrl))
const showTextPreview = computed(() => Boolean(
  previewPayload.value
  && !previewPayload.value.binary
  && !previewPayload.value.previewUrl
))
const previewCodeHtml = ref('')
const previewCodeBg = ref('')
const previewCodeFg = ref('')
const previewGutterWidth = ref('2.6rem')
const {
  selectedRows: selectedPreviewRows,
  selectionAction: previewSelectionAction,
  clearSelectionState: clearPreviewLineSelection,
  handleSelectionMouseUp: handlePreviewMouseUp,
  updateSelectionActionFromDom: updatePreviewSelectionActionFromDom,
} = useCodeSelectionAction({
  getContainer: () => previewContainerRef.value,
  isActive: () => props.open && showTextPreview.value,
  rowSelector: '.source-code-view__line',
  mapRowElement: (rowElement) => {
    const lineNumber = Number(rowElement?.getAttribute?.('data-line') || 0)
    return lineNumber > 0 ? lineNumber : null
  },
  getCodeLeft: (rowElement) => {
    const codeElement = rowElement?.querySelector?.('.source-code-view__code')
    if (!codeElement) {
      return 0
    }

    const rect = codeElement.getBoundingClientRect?.()
    const styles = window.getComputedStyle?.(codeElement)
    const paddingLeft = Number.parseFloat(styles?.paddingLeft || '0') || 0
    return (rect?.left || 0) + paddingLeft
  },
  debounceMs: 72,
})
const selectedPreviewLines = computed(() => [...new Set(selectedPreviewRows.value)]
  .map((value) => Number(value) || 0)
  .filter((lineNumber) => lineNumber > 0)
  .sort((left, right) => left - right))
const selectedPreviewLineItems = computed(() => {
  const content = String(previewPayload.value?.content || '').replace(/\r\n/g, '\n')
  const lines = content ? content.split('\n') : []
  return [...selectedPreviewLines.value]
    .sort((left, right) => left - right)
    .map((lineNumber) => ({
      lineNumber,
      content: String(lines[lineNumber - 1] || ''),
    }))
    .filter((item) => item.lineNumber > 0)
})
const canInsertPreviewSelection = computed(() => selectedPreviewLineItems.value.length > 0)
const currentSearchPlaceholder = computed(() => (
  isContentSearchMode.value
    ? t('sourceBrowser.contentSearchPlaceholder')
    : t('sourceBrowser.searchPlaceholder')
))
const currentSearchModeLabel = computed(() => (
  isContentSearchMode.value
    ? t('sourceBrowser.searchModeContent')
    : t('sourceBrowser.searchModePath')
))
const hasSearchKeyword = computed(() => Boolean(normalizedSearchInput.value))
const sidebarMode = computed(() => (hasSearchKeyword.value ? 'search' : 'tree'))
const sidebarLoading = computed(() => (
  hasSearchKeyword.value && isContentSearchMode.value
    ? contentSearchLoading.value
    : currentLoading.value
))
const showPathSearchEmptyState = computed(() => isPathSearchMode.value && showSearchEmptyState.value)
const showPathSearchPromptState = computed(() => isPathSearchMode.value && showSearchPromptState.value)
const showContentSearchPromptState = computed(() => (
  hasSearchKeyword.value
  && isContentSearchMode.value
  && !isSearchKeywordReady.value
  && !contentSearchLoading.value
  && !contentSearchError.value
))
const showContentSearchEmptyState = computed(() => (
  hasSearchKeyword.value
  && isContentSearchMode.value
  && isSearchKeywordReady.value
  && Boolean(contentSearchExecutedQuery.value)
  && !contentSearchLoading.value
  && !contentSearchError.value
  && !contentSearchResults.value.length
))
const showContentSearchIdleState = computed(() => (
  hasSearchKeyword.value
  && isContentSearchMode.value
  && isSearchKeywordReady.value
  && !contentSearchLoading.value
  && !contentSearchError.value
  && !contentSearchExecutedQuery.value
  && !contentSearchResults.value.length
))
const contentSearchGroups = computed(() => {
  const groups = []
  const groupMap = new Map()

  contentSearchResults.value.forEach((item) => {
    const filePath = String(item?.path || '').trim()
    if (!filePath) {
      return
    }

    let group = groupMap.get(filePath)
    if (!group) {
      group = {
        path: filePath,
        name: String(item?.name || filePath.split('/').pop() || filePath),
        items: [],
      }
      groupMap.set(filePath, group)
      groups.push(group)
    }

    group.items.push(item)
  })

  return groups
})
const contentSearchResultsSignature = computed(() => contentSearchResults.value
  .map((item) => getContentSearchItemKey(item))
  .join('|'))
const visibleItemsSignature = computed(() => visibleItems.value
  .map((item) => {
    const path = String(item?.path || '').trim()
    const expanded = item?.expanded ? 1 : 0
    const loading = item?.loading ? 1 : 0
    return `${path}:${expanded}:${loading}`
  })
  .join('|'))

const {
  activeKey,
  collapseActiveDirectory,
  expandActiveDirectory,
  currentError,
  currentLoading,
  getDisplayName,
  getHighlightedName,
  getHighlightedPath,
  handleQueryChange,
  handleSessionChange,
  handleVisibleItemsChange,
  initializeData,
  moveActive,
  normalSearchItems,
  recentSearchItems,
  resetData,
  setItemRef,
  showSearchPromptState,
  showSearchEmptyState,
  showTreeEmptyState,
  toggleDirectory,
  treeItems,
  visibleItems,
} = useWorkspacePickerData({
  getMode: () => sidebarMode.value,
  props: pickerProps,
  onSelect: handleSelectItem,
})

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function getContentSearchItemKey(item) {
  return `${item?.path || ''}:${item?.line || 0}:${item?.column || 0}`
}

function setContentSearchItemRef(key, element) {
  if (element) {
    contentSearchItemRefs.set(key, element)
    return
  }
  contentSearchItemRefs.delete(key)
}

function scrollActiveContentSearchItemIntoView() {
  const target = contentSearchItemRefs.get(contentSearchActiveKey.value)
  target?.scrollIntoView?.({ block: 'nearest' })
}

function renderHighlightedSnippet(text = '', query = '') {
  const source = String(text || '')
  const keyword = String(query || '').trim()
  if (!source || !keyword) {
    return escapeHtml(source)
  }

  const normalizedSource = source.toLowerCase()
  const normalizedKeyword = keyword.toLowerCase()
  const matchIndex = normalizedSource.indexOf(normalizedKeyword)
  if (matchIndex < 0) {
    return escapeHtml(source)
  }

  const matchEnd = matchIndex + normalizedKeyword.length
  return `${escapeHtml(source.slice(0, matchIndex))}<mark class="theme-search-highlight">${escapeHtml(source.slice(matchIndex, matchEnd))}</mark>${escapeHtml(source.slice(matchEnd))}`
}

function collectSearchMatchRanges(text = '', query = '') {
  const source = String(text || '')
  const keyword = String(query || '').trim()
  if (!source || !keyword) {
    return []
  }

  const normalizedSource = source.toLowerCase()
  const normalizedKeyword = keyword.toLowerCase()
  const ranges = []
  let searchStart = 0

  while (searchStart < normalizedSource.length) {
    const matchIndex = normalizedSource.indexOf(normalizedKeyword, searchStart)
    if (matchIndex < 0) {
      break
    }
    ranges.push({
      start: matchIndex,
      end: matchIndex + normalizedKeyword.length,
    })
    searchStart = matchIndex + normalizedKeyword.length
  }

  return ranges
}

function buildHighlightedPreviewNode(node, ranges, state) {
  if (!node) {
    return null
  }

  if (node.nodeType === Node.TEXT_NODE) {
    const text = node.textContent || ''
    const startOffset = state.offset
    const endOffset = startOffset + text.length
    state.offset = endOffset

    if (!text) {
      return document.createTextNode('')
    }

    const overlaps = ranges.filter((range) => range.start < endOffset && range.end > startOffset)
    if (!overlaps.length) {
      return document.createTextNode(text)
    }

    const fragment = document.createDocumentFragment()
    let cursor = 0

    overlaps.forEach((range) => {
      const localStart = Math.max(0, range.start - startOffset)
      const localEnd = Math.min(text.length, range.end - startOffset)

      if (localStart > cursor) {
        fragment.appendChild(document.createTextNode(text.slice(cursor, localStart)))
      }

      if (localEnd > localStart) {
        const mark = document.createElement('mark')
        mark.className = 'source-code-view__search-hit'
        mark.textContent = text.slice(localStart, localEnd)
        fragment.appendChild(mark)
      }

      cursor = Math.max(cursor, localEnd)
    })

    if (cursor < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(cursor)))
    }

    return fragment
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return node.cloneNode(true)
  }

  const clone = node.cloneNode(false)
  Array.from(node.childNodes || []).forEach((child) => {
    const highlightedChild = buildHighlightedPreviewNode(child, ranges, state)
    if (highlightedChild) {
      clone.appendChild(highlightedChild)
    }
  })
  return clone
}

function restorePreviewSearchHighlights(container = previewContainerRef.value) {
  if (!container) {
    return
  }

  container
    .querySelectorAll?.('.source-code-view__line-inner[data-original-html]')
    ?.forEach?.((element) => {
      const originalHtml = element.dataset.originalHtml
      if (typeof originalHtml === 'string') {
        element.innerHTML = originalHtml
      }
    })
}

function applyPreviewSearchHighlights() {
  const container = previewContainerRef.value
  const keyword = String(previewSearchQuery.value || '').trim()
  if (!container) {
    return
  }

  restorePreviewSearchHighlights(container)

  if (!keyword) {
    return
  }

  container
    .querySelectorAll?.('.source-code-view__line.is-match .source-code-view__line-inner')
    ?.forEach?.((element) => {
      if (!element.dataset.originalHtml) {
        element.dataset.originalHtml = element.innerHTML
      }

      const ranges = collectSearchMatchRanges(element.textContent || '', keyword)
      if (!ranges.length) {
        return
      }

      const fragment = document.createDocumentFragment()
      const state = { offset: 0 }

      Array.from(element.childNodes || []).forEach((child) => {
        const highlightedChild = buildHighlightedPreviewNode(child, ranges, state)
        if (highlightedChild) {
          fragment.appendChild(highlightedChild)
        }
      })

      element.replaceChildren(fragment)
    })
}

function formatFileSize(value = 0) {
  const size = Math.max(0, Number(value) || 0)
  if (size < 1024) {
    return `${size} B`
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

function clearPreviewFocusStyles() {
  const container = previewContainerRef.value
  if (!container) {
    return
  }

  restorePreviewSearchHighlights(container)

  container
    .querySelectorAll?.('.source-code-view__line.is-match, .source-code-view__line.is-focus-match')
    ?.forEach?.((element) => element.classList.remove('is-match', 'is-focus-match'))
}

function clearPreviewSelectionStyles() {
  const container = previewContainerRef.value
  if (!container) {
    return
  }

  container
    .querySelectorAll?.('.source-code-view__line.is-selected')
    ?.forEach?.((element) => element.classList.remove('is-selected'))
}

function applyPreviewSelectionStyles() {
  clearPreviewSelectionStyles()

  const container = previewContainerRef.value
  if (!container || !selectedPreviewLines.value.length) {
    return
  }

  selectedPreviewLines.value.forEach((lineNumber) => {
    const gutter = container.querySelector(`.source-code-view__gutter[data-line="${lineNumber}"]`)
    const row = gutter?.closest?.('tr')
    row?.classList?.add('is-selected')
  })
}

function getPreviewSelectedRangeLabel() {
  if (!selectedPreviewLines.value.length) {
    return ''
  }

  const numbers = [...selectedPreviewLines.value].sort((left, right) => left - right)
  return numbers[0] === numbers[numbers.length - 1]
    ? `L${numbers[0]}`
    : `L${numbers[0]}-${numbers[numbers.length - 1]}`
}

function insertSelectedPreviewCodeContext() {
  if (!previewPayload.value || !canInsertPreviewSelection.value) {
    return
  }

  const numbers = selectedPreviewLineItems.value.map((item) => item.lineNumber)
  emit('insert-code-context', {
    source: 'source',
    filePath: previewPath.value,
    language: String(previewPayload.value?.language || ''),
    rangeLabel: getPreviewSelectedRangeLabel(),
    lineStart: Math.min(...numbers),
    lineEnd: Math.max(...numbers),
    content: String(previewSelectionAction.value.content || '').trim()
      || selectedPreviewLineItems.value.map((item) => item.content).join('\n'),
  })

  window.getSelection?.()?.removeAllRanges?.()
  clearPreviewLineSelection()
  emit('close')
}

function handlePreviewCopy(event) {
  const selection = window.getSelection?.()
  const container = previewContainerRef.value
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed || !container) {
    return
  }

  updatePreviewSelectionActionFromDom()

  const range = selection.getRangeAt(0)
  const commonAncestor = range.commonAncestorContainer
  if (!container.contains(commonAncestor?.nodeType === 1 ? commonAncestor : commonAncestor?.parentNode)) {
    return
  }

  const content = String(selection.toString() || '').replace(/\u200b/g, '')
  if (!content) {
    return
  }

  event?.clipboardData?.setData?.('text/plain', content)
  event?.preventDefault?.()
}

function clearScheduledPreviewLoad() {
  if (previewSelectionTimer) {
    window.clearTimeout(previewSelectionTimer)
    previewSelectionTimer = null
  }
}

function clearPreviewCache() {
  previewPayloadCache.clear()
}

function getCachedPreviewPayload(pathValue = '') {
  const path = String(pathValue || '').trim()
  if (!path || !previewPayloadCache.has(path)) {
    return null
  }

  const cachedPayload = previewPayloadCache.get(path)
  previewPayloadCache.delete(path)
  previewPayloadCache.set(path, cachedPayload)
  return cachedPayload
}

function setCachedPreviewPayload(pathValue = '', payload = null) {
  const path = String(pathValue || '').trim()
  if (!path || !payload) {
    return
  }

  previewPayloadCache.delete(path)
  previewPayloadCache.set(path, payload)

  while (previewPayloadCache.size > PREVIEW_CACHE_LIMIT) {
    const oldestKey = previewPayloadCache.keys().next().value
    if (!oldestKey) {
      break
    }
    previewPayloadCache.delete(oldestKey)
  }
}

function schedulePreviewLoad(load) {
  clearScheduledPreviewLoad()
  previewSelectionTimer = window.setTimeout(() => {
    previewSelectionTimer = null
    load?.()
  }, PREVIEW_SELECTION_DEBOUNCE_MS)
}

function focusSearchInput() {
  nextTick(() => {
    searchInputRef.value?.focus?.()
  })
}

function handleEscapeIntent(event) {
  event?.preventDefault?.()

  if (normalizedSearchInput.value) {
    event?.stopPropagation?.()
    searchInput.value = ''
    return
  }

  event?.stopPropagation?.()
  emit('close')
}

function resetPreviewState() {
  clearScheduledPreviewLoad()
  previewRequestId += 1
  clearPreviewCache()
  selectedPath.value = ''
  selectedItemType.value = ''
  previewLoading.value = false
  previewError.value = ''
  previewPayload.value = null
  previewCodeHtml.value = ''
  previewCodeBg.value = ''
  previewCodeFg.value = ''
  previewGutterWidth.value = '2.6rem'
  previewFocusLine.value = 0
  previewMatchLines.value = []
  previewSearchQuery.value = ''
  clearPreviewLineSelection()
  clearPreviewFocusStyles()
}

function resetContentSearchState() {
  contentSearchRequestId += 1
  if (contentSearchTimer) {
    window.clearTimeout(contentSearchTimer)
    contentSearchTimer = null
  }
  if (contentSearchAbortController) {
    contentSearchAbortController.abort()
    contentSearchAbortController = null
  }
  contentSearchResults.value = []
  contentSearchLoading.value = false
  contentSearchError.value = ''
  contentSearchExecutedQuery.value = ''
  contentSearchTruncated.value = false
  contentSearchActiveKey.value = ''
  previewMatchLines.value = []
  previewSearchQuery.value = ''
  clearPreviewFocusStyles()
}

function scheduleContentSearch() {
  if (contentSearchTimer) {
    window.clearTimeout(contentSearchTimer)
    contentSearchTimer = null
  }

  if (!props.open || !sessionId.value || !isContentSearchMode.value) {
    return
  }

  const query = normalizedSearchInput.value
  if (!query || !isSearchKeywordReady.value) {
    resetContentSearchState()
    return
  }

  contentSearchLoading.value = true
  contentSearchError.value = ''

  contentSearchTimer = window.setTimeout(() => {
    contentSearchTimer = null
    runContentSearch()
  }, CONTENT_SEARCH_DEBOUNCE_MS)
}

function moveContentSearchActive(step = 1) {
  const items = contentSearchResults.value
  if (!items.length) {
    return false
  }

  const currentIndex = items.findIndex((item) => getContentSearchItemKey(item) === contentSearchActiveKey.value)
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + step + items.length) % items.length

  contentSearchActiveKey.value = getContentSearchItemKey(items[nextIndex])
  nextTick(scrollActiveContentSearchItemIntoView)
  return true
}

function getActiveVisibleSidebarItem() {
  if (!visibleItems.value.length) {
    return null
  }

  return visibleItems.value.find((item) => item.path === activeKey.value) || visibleItems.value[0] || null
}

function selectSidebarItem(item, options = {}) {
  if (!item) {
    return false
  }

  activeKey.value = item?.path || ''
  contentSearchActiveKey.value = ''
  selectedPath.value = String(item?.path || '').trim()
  selectedItemType.value = String(item?.type || '').trim()
  previewError.value = ''
  previewFocusLine.value = 0
  previewMatchLines.value = []
  previewSearchQuery.value = ''

  if (item?.type === 'directory') {
    clearScheduledPreviewLoad()
    previewPayload.value = null
    if (options.toggleDirectory && !hasSearchKeyword.value) {
      toggleDirectory(item.path)
    }
    return true
  }

  if (options.previewMode === 'debounced') {
    schedulePreviewLoad(() => loadPreview(item?.path))
    return true
  }

  clearScheduledPreviewLoad()
  loadPreview(item?.path)
  return true
}

function confirmContentSearchActive() {
  const items = contentSearchResults.value
  if (!items.length) {
    return false
  }

  const activeItem = items.find((item) => getContentSearchItemKey(item) === contentSearchActiveKey.value) || items[0]
  handleSelectContentSearchItem(activeItem)
  return true
}

function handleSidebarKeydown(event) {
  const key = String(event?.key || '')
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(key)) {
    return
  }

  if (hasSearchKeyword.value && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return
  }

  if (isContentSearchMode.value && hasSearchKeyword.value) {
    if (key === 'ArrowDown') {
      event.preventDefault()
      if (moveContentSearchActive(1)) {
        const items = contentSearchResults.value
        const activeItem = items.find((item) => getContentSearchItemKey(item) === contentSearchActiveKey.value) || items[0]
        handleSelectContentSearchItem(activeItem, {
          previewMode: 'debounced',
        })
      }
      return
    }
    if (key === 'ArrowUp') {
      event.preventDefault()
      if (moveContentSearchActive(-1)) {
        const items = contentSearchResults.value
        const activeItem = items.find((item) => getContentSearchItemKey(item) === contentSearchActiveKey.value) || items[0]
        handleSelectContentSearchItem(activeItem, {
          previewMode: 'debounced',
        })
      }
      return
    }
    if (key === 'Enter') {
      event.preventDefault()
      confirmContentSearchActive()
      return
    }
    if (key === 'Escape') {
      handleEscapeIntent(event)
    }
    return
  }

  if (key === 'ArrowDown') {
    event.preventDefault()
    if (moveActive(1)) {
      nextTick(() => {
        selectSidebarItem(getActiveVisibleSidebarItem(), {
          previewMode: 'debounced',
        })
      })
    }
    return
  }
  if (key === 'ArrowUp') {
    event.preventDefault()
    if (moveActive(-1)) {
      nextTick(() => {
        selectSidebarItem(getActiveVisibleSidebarItem(), {
          previewMode: 'debounced',
        })
      })
    }
    return
  }
  if (key === 'ArrowRight') {
    event.preventDefault()
    expandActiveDirectory()
    return
  }
  if (key === 'ArrowLeft') {
    event.preventDefault()
    collapseActiveDirectory()
    return
  }
  if (key === 'Enter') {
    event.preventDefault()
    selectSidebarItem(getActiveVisibleSidebarItem(), {
      toggleDirectory: true,
    })
    return
  }
  if (key === 'Escape') {
    handleEscapeIntent(event)
  }
}

async function toggleSearchMode() {
  const nextMode = isContentSearchMode.value ? 'path' : 'content'
  searchMode.value = nextMode

  if (!normalizedSearchInput.value) {
    if (nextMode === 'content') {
      resetContentSearchState()
    } else {
      resetContentSearchState()
      pickerProps.query = ''
    }
    return
  }

  if (nextMode === 'content') {
    pickerProps.query = ''
    runContentSearch()
    return
  }

  resetContentSearchState()
  pickerProps.query = searchInput.value
}

function handleSearchInputTab(event) {
  event.preventDefault()
  event.stopPropagation?.()
  toggleSearchMode().finally(() => {
    focusSearchInput()
  })
}

async function applyPreviewFocusLine() {
  await nextTick()
  clearPreviewFocusStyles()

  if (!previewContainerRef.value) {
    return
  }

  const lineNumbers = [...new Set(
    previewMatchLines.value
      .map((line) => Math.max(0, Number(line) || 0))
      .filter((line) => line > 0)
  )]
  const focusLineNumber = Math.max(0, Number(previewFocusLine.value) || 0)

  lineNumbers.forEach((lineNumber) => {
    const gutter = previewContainerRef.value.querySelector(`.source-code-view__gutter[data-line="${lineNumber}"]`)
    const row = gutter?.closest?.('tr')
    row?.classList?.add('is-match')
  })

  applyPreviewSearchHighlights()

  if (!focusLineNumber) {
    applyPreviewSelectionStyles()
    return
  }

  const lineNumber = focusLineNumber
  const gutter = previewContainerRef.value.querySelector(`.source-code-view__gutter[data-line="${lineNumber}"]`)
  const row = gutter?.closest?.('tr')
  if (!row) {
    applyPreviewSelectionStyles()
    return
  }

  row.classList.add('is-match', 'is-focus-match')
  applyPreviewSearchHighlights()
  row.scrollIntoView({
    block: 'center',
    inline: 'nearest',
  })
  applyPreviewSelectionStyles()
}

async function renderPreviewCode() {
  if (!showTextPreview.value) {
    previewCodeHtml.value = ''
    previewCodeBg.value = ''
    previewCodeFg.value = ''
    return
  }

  const requestId = previewRequestId
  const content = String(previewPayload.value?.content || '').replace(/\r\n/g, '\n')
  const language = previewPayload.value?.language || ''
  const isLargePreview = exceedsHighlightThresholdForCode(content, SOURCE_PREVIEW_HIGHLIGHT_LIMITS)

  const rendered = await renderSourceCodePreview(previewPayload.value?.content || '', {
    isDark: isDark.value,
    language,
    maxHighlightLines: SOURCE_PREVIEW_HIGHLIGHT_LIMITS.maxLines,
    maxHighlightChars: SOURCE_PREVIEW_HIGHLIGHT_LIMITS.maxChars,
  })

  if (requestId !== previewRequestId) {
    return
  }

  previewCodeHtml.value = rendered.html
  previewCodeBg.value = isLargePreview ? '' : (rendered.bg || '')
  previewCodeFg.value = isLargePreview ? '' : (rendered.fg || '')
  previewGutterWidth.value = rendered.gutterWidth || '2.6rem'
  await nextTick()
  applyPreviewSelectionStyles()
}

async function loadPreview(pathValue = '', options = {}) {
  const nextPath = String(pathValue || '').trim()
  if (!sessionId.value || !nextPath) {
    return
  }

  previewFocusLine.value = Math.max(0, Number(options.focusLine) || 0)
  clearPreviewLineSelection()

  const currentPreviewPath = String(previewPayload.value?.path || '').trim()
  if (!options.forceReload && currentPreviewPath === nextPath && !previewLoading.value && !previewError.value) {
    await applyPreviewFocusLine()
    return
  }

  if (!options.forceReload && previewLoading.value && selectedPath.value === nextPath) {
    return
  }

  previewRequestId += 1
  const requestId = previewRequestId
  previewError.value = ''

  const cachedPayload = options.forceReload ? null : getCachedPreviewPayload(nextPath)
  if (cachedPayload) {
    previewLoading.value = false
    previewPayload.value = cachedPayload
    await renderPreviewCode()
    if (requestId === previewRequestId && showTextPreview.value) {
      await applyPreviewFocusLine()
    }
    return
  }

  previewLoading.value = true

  try {
    const payload = await getCodexSessionFileContent(sessionId.value, {
      path: nextPath,
      limit: 200 * 1024,
      refreshToken: String(Date.now()),
    })

    if (requestId !== previewRequestId) {
      return
    }

    previewPayload.value = payload
    setCachedPreviewPayload(nextPath, payload)
    await renderPreviewCode()
  } catch (error) {
    if (requestId !== previewRequestId) {
      return
    }

    previewPayload.value = null
    previewError.value = error?.message || t('sourceBrowser.previewFailed')
  } finally {
    if (requestId === previewRequestId) {
      previewLoading.value = false
      if (showTextPreview.value) {
        await applyPreviewFocusLine()
      }
    }
  }
}

function handleSelectItem(item) {
  selectSidebarItem(item, {
    toggleDirectory: true,
  })
  nextTick(focusSearchInput)
}

function handleTreeItemClick(event, item) {
  event?.currentTarget?.focus?.()
  handleSelectItem(item)
}

async function runContentSearch() {
  const query = normalizedSearchInput.value
  if (!props.open || !sessionId.value) {
    return
  }

  contentSearchRequestId += 1
  const requestId = contentSearchRequestId

  if (!query || !isSearchKeywordReady.value) {
    resetContentSearchState()
    return
  }

  if (contentSearchAbortController) {
    contentSearchAbortController.abort()
    contentSearchAbortController = null
  }

  contentSearchLoading.value = true
  contentSearchError.value = ''
  contentSearchResults.value = []
  contentSearchTruncated.value = false
  contentSearchActiveKey.value = ''
  contentSearchAbortController = new AbortController()

  try {
    const payload = await searchCodexSessionFileContent(sessionId.value, query, {
      limit: 80,
      refreshToken: String(Date.now()),
      signal: contentSearchAbortController.signal,
    })
    if (requestId !== contentSearchRequestId) {
      return
    }

    contentSearchExecutedQuery.value = query
    contentSearchResults.value = Array.isArray(payload.items) ? payload.items : []
    contentSearchTruncated.value = Boolean(payload.truncated)
    contentSearchActiveKey.value = contentSearchResults.value[0]
      ? getContentSearchItemKey(contentSearchResults.value[0])
      : ''
    if (contentSearchResults.value[0]) {
      handleSelectContentSearchItem(contentSearchResults.value[0], {
        previewMode: 'debounced',
      })
    }
  } catch (error) {
    if (isAbortError(error)) {
      return
    }
    if (requestId !== contentSearchRequestId) {
      return
    }

    contentSearchExecutedQuery.value = query
    contentSearchResults.value = []
    contentSearchError.value = error?.message || t('sourceBrowser.contentSearchFailed')
  } finally {
    if (requestId === contentSearchRequestId) {
      contentSearchAbortController = null
    }
    if (requestId === contentSearchRequestId) {
      contentSearchLoading.value = false
    }
  }
}

function handleSelectContentSearchItem(item, options = {}) {
  contentSearchActiveKey.value = getContentSearchItemKey(item)
  activeKey.value = item?.path || ''
  selectedPath.value = String(item?.path || '').trim()
  selectedItemType.value = 'file'
  previewError.value = ''
  previewSearchQuery.value = contentSearchExecutedQuery.value || normalizedSearchInput.value
  previewMatchLines.value = contentSearchResults.value
    .filter((entry) => entry?.path === item?.path)
    .map((entry) => Number(entry?.line || 0))
    .filter((line) => line > 0)

  const load = () => loadPreview(item?.path, {
    focusLine: item?.line,
  })

  if (options.previewMode === 'debounced') {
    schedulePreviewLoad(load)
    nextTick(focusSearchInput)
    return
  }

  clearScheduledPreviewLoad()
  load()
  nextTick(focusSearchInput)
}

function getContentSearchGroupName(group) {
  const filePath = String(group?.path || '').trim()
  if (!filePath) {
    return ''
  }
  const segments = filePath.split('/')
  return segments[segments.length - 1] || filePath
}

function getContentSearchGroupDirectory(group) {
  const filePath = String(group?.path || '').trim()
  if (!filePath || !filePath.includes('/')) {
    return ''
  }
  return filePath.slice(0, filePath.lastIndexOf('/'))
}

function formatContentSearchGroupCount(group) {
  const count = Array.isArray(group?.items) ? group.items.length : 0
  return `${count} 处`
}

function getContentSearchPreviewHtml(item) {
  const query = contentSearchExecutedQuery.value || normalizedSearchInput.value
  return renderHighlightedSnippet(item?.preview || '', query)
}

watch(
  () => props.open,
  (open) => {
    pickerProps.open = open

    if (open) {
      window.getSelection?.()?.removeAllRanges?.()
      pickerProps.sessionId = sessionId.value
      searchInput.value = ''
      searchMode.value = 'path'
      pickerProps.query = ''
      resetPreviewState()
      resetContentSearchState()
      initializeData()
      focusSearchInput()
      return
    }

    window.getSelection?.()?.removeAllRanges?.()
    searchInput.value = ''
    searchMode.value = 'path'
    resetPreviewState()
    resetContentSearchState()
    resetData()
  },
  { immediate: true }
)

watch(
  sessionId,
  (value) => {
    pickerProps.sessionId = value
    if (props.open) {
      resetPreviewState()
      resetContentSearchState()
      handleSessionChange()
    }
  }
)

watch(
  searchInput,
  (value) => {
    if (isPathSearchMode.value) {
      pickerProps.query = value
      return
    }

    const normalizedValue = String(value || '').trim()
    if (normalizedValue !== String(contentSearchExecutedQuery.value || '').trim()) {
      previewSearchQuery.value = ''
      applyPreviewSearchHighlights()
    }

    scheduleContentSearch()
  }
)

watch(
  () => pickerProps.query,
  () => {
    if (!isPathSearchMode.value) {
      return
    }
    handleQueryChange()
  }
)

watch(contentSearchResultsSignature, () => {
  nextTick(scrollActiveContentSearchItemIntoView)
})

watch(visibleItemsSignature, () => {
  handleVisibleItemsChange()
  if (!hasSearchKeyword.value || !isPathSearchMode.value) {
    return
  }

  nextTick(() => {
    const activeItem = getActiveVisibleSidebarItem()
    if (!activeItem) {
      return
    }

    selectSidebarItem(activeItem, {
      previewMode: 'debounced',
    })
  })
})

watch(
  isDark,
  async () => {
    if (!props.open || !showTextPreview.value) {
      return
    }

    await renderPreviewCode()
    await applyPreviewFocusLine()
  }
)

watch(selectedPreviewLines, () => {
  applyPreviewSelectionStyles()
})

onBeforeUnmount(() => {
  window.getSelection?.()?.removeAllRanges?.()
  clearPreviewLineSelection({ clearBrowserSelection: true })
  clearScheduledPreviewLoad()
})
</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="2"
    panel-class="settings-dialog-panel h-[calc(100dvh-1rem)] sm:h-[96vh] sm:max-h-[96vh] sm:w-[90vw] sm:max-w-[90vw]"
    header-class="settings-dialog-header px-5 py-3.5"
    body-class="settings-dialog-body min-h-0 flex flex-1 flex-col overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div class="min-w-0">
        <div class="theme-heading truncate text-sm font-medium">{{ sessionCwd || t('sourceBrowser.title') }}</div>
      </div>
    </template>

    <div class="source-browser-layout grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[21rem_minmax(0,1fr)]">
      <aside
        class="theme-divider flex min-h-0 flex-col border-b md:border-b-0 md:border-r"
        @keydown="handleSidebarKeydown"
      >
        <div class="theme-divider border-b px-4 py-3">
          <label class="block">
            <span class="sr-only">{{ t('sourceBrowser.searchLabel') }}</span>
            <div class="relative">
              <Search class="theme-muted-text pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2" />
                <input
                  ref="searchInputRef"
                  v-model="searchInput"
                  type="text"
                  class="tool-input w-full pl-9 pr-18 text-[12px]"
                  :placeholder="currentSearchPlaceholder"
                  @keydown.esc="handleEscapeIntent"
                  @keydown.tab.prevent="handleSearchInputTab"
                >
              <LoaderCircle
                v-if="sidebarLoading"
                class="theme-muted-text pointer-events-none absolute right-10 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin"
              />
              <button
                type="button"
                class="tool-button absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center px-0"
                :title="currentSearchModeLabel"
                :aria-label="currentSearchModeLabel"
                @click.stop.prevent="toggleSearchMode"
              >
                <ArrowLeftRight class="h-3.5 w-3.5" />
              </button>
            </div>
          </label>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <div
            v-if="!sessionId"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.noProject') }}
          </div>

          <div
            v-else-if="hasSearchKeyword && isContentSearchMode && contentSearchError"
            class="theme-status-danger rounded-sm border px-3 py-3 text-[12px]"
          >
            {{ contentSearchError }}
          </div>

          <div
            v-else-if="currentError"
            class="theme-status-danger rounded-sm border px-3 py-3 text-[12px]"
          >
            {{ currentError }}
          </div>

          <div
            v-else-if="showPathSearchPromptState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.searchMinKeywordHint', { count: WORKSPACE_SEARCH_MIN_QUERY_LENGTH }) }}
          </div>

          <div
            v-else-if="showPathSearchEmptyState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.searchEmpty') }}
          </div>

          <div
            v-else-if="showContentSearchPromptState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.searchMinKeywordHint', { count: WORKSPACE_SEARCH_MIN_QUERY_LENGTH }) }}
          </div>

          <div
            v-else-if="showContentSearchIdleState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.contentSearchPrompt') }}
          </div>

          <div
            v-else-if="showContentSearchEmptyState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.contentSearchEmpty') }}
          </div>

          <div
            v-else-if="showTreeEmptyState"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.treeEmpty') }}
          </div>

          <div
            v-else-if="hasSearchKeyword && isContentSearchMode && contentSearchLoading && !contentSearchResults.length"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.contentSearching') }}
          </div>

          <div
            v-else-if="currentLoading && !visibleItems.length"
            class="theme-empty-state px-3 py-4 text-[12px]"
          >
            {{ t('sourceBrowser.loadingFiles') }}
          </div>

          <div v-else-if="hasSearchKeyword && isPathSearchMode" class="space-y-1">
            <div
              v-if="recentSearchItems.length"
              class="theme-muted-text px-1 py-0.5 text-[12px] tracking-[0.08em]"
            >
              {{ t('sourceBrowser.recent') }}
            </div>
            <button
              v-for="item in recentSearchItems"
              :key="`recent-${item.path}`"
              :ref="(element) => setItemRef(item.path, element)"
              type="button"
              class="theme-list-row focus:outline-none"
              :class="activeKey === item.path ? 'theme-list-item-active' : 'theme-list-item-hover'"
              @click="handleSelectItem(item)"
            >
              <component
                :is="item.type === 'directory' ? FolderOpen : File"
                class="theme-list-item-icon"
              />
              <div class="min-w-0 flex-1">
                <div>
                  <span
                    class="theme-list-item-title block break-all"
                    v-html="getHighlightedName(item)"
                  />
                </div>
                <div
                  class="theme-list-item-subtitle theme-list-item-subtitle--mono break-all"
                  v-html="getHighlightedPath(item)"
                />
              </div>
            </button>

            <div
              v-if="pickerProps.query.trim() && normalSearchItems.length"
              class="theme-muted-text px-1 py-0.5 text-[12px] tracking-[0.08em]"
            >
              {{ t('sourceBrowser.results') }}
            </div>
            <button
              v-for="item in normalSearchItems"
              :key="`result-${item.path}`"
              :ref="(element) => setItemRef(item.path, element)"
              type="button"
              class="theme-list-row focus:outline-none"
              :class="activeKey === item.path ? 'theme-list-item-active' : 'theme-list-item-hover'"
              @click="handleSelectItem(item)"
            >
              <component
                :is="item.type === 'directory' ? FolderOpen : File"
                class="theme-list-item-icon"
              />
              <div class="min-w-0 flex-1">
                <div>
                  <span
                    class="theme-list-item-title block break-all"
                    v-html="getHighlightedName(item)"
                  />
                </div>
                <div
                  class="theme-list-item-subtitle theme-list-item-subtitle--mono break-all"
                  v-html="getHighlightedPath(item)"
                />
              </div>
            </button>
          </div>

          <div v-else-if="hasSearchKeyword" class="space-y-3">
            <div
              v-for="group in contentSearchGroups"
              :key="group.path"
              class="rounded-sm border border-[var(--theme-borderDefault)] bg-[var(--theme-panel)]"
            >
              <div class="theme-divider flex items-start gap-2.5 border-b px-3 py-2.5">
                <File class="theme-list-item-icon" />
                <div class="min-w-0 flex-1">
                  <div class="theme-list-item-title theme-list-item-title--strong break-all">
                    {{ getContentSearchGroupName(group) }}
                  </div>
                  <div
                    v-if="getContentSearchGroupDirectory(group)"
                    class="theme-list-item-meta truncate"
                  >
                    {{ getContentSearchGroupDirectory(group) }}
                  </div>
                </div>
                <div class="theme-list-item-meta shrink-0 pt-0.5">
                  {{ formatContentSearchGroupCount(group) }}
                </div>
              </div>

              <div class="space-y-1 px-2 py-2">
                <button
                  v-for="item in group.items"
                  :key="getContentSearchItemKey(item)"
                  :ref="(element) => setContentSearchItemRef(getContentSearchItemKey(item), element)"
                  type="button"
                  class="theme-list-row gap-0 focus:outline-none"
                  :class="contentSearchActiveKey === getContentSearchItemKey(item) ? 'theme-list-item-active' : 'theme-list-item-hover'"
                  @click="handleSelectContentSearchItem(item)"
                >
                  <div
                    class="theme-list-item-title min-w-0 flex-1 break-words leading-[1.45rem]"
                    v-html="getContentSearchPreviewHtml(item)"
                  />
                </button>
              </div>
            </div>

            <div
              v-if="contentSearchTruncated"
              class="theme-muted-text px-1 text-[12px]"
            >
              {{ t('sourceBrowser.contentSearchTruncated') }}
            </div>
          </div>

          <div v-else class="space-y-1">
            <div
              v-for="item in treeItems"
              :key="item.path"
              :ref="(element) => setItemRef(item.path, element)"
              class="theme-list-tree-item outline-none focus:outline-none focus-visible:outline-none"
              :class="activeKey === item.path
                ? 'theme-list-item-active'
                : item.type === 'directory' && item.expanded
                  ? 'theme-list-item-expanded'
                  : 'theme-list-item-hover'"
              :style="{ paddingLeft: `${item.depth * 16 + 6}px` }"
              tabindex="-1"
              @click="handleTreeItemClick($event, item)"
            >
              <div class="flex items-start gap-1.5">
                <button
                  v-if="item.type === 'directory'"
                  type="button"
                  class="theme-icon-button h-5 w-5 shrink-0"
                  @click.stop="toggleDirectory(item.path)"
                >
                  <LoaderCircle v-if="item.loading" class="h-3.5 w-3.5 animate-spin" />
                  <ChevronRight v-else class="h-3.5 w-3.5 transition" :class="item.expanded ? 'rotate-90 text-[var(--theme-textPrimary)]' : ''" />
                </button>
                <span v-else class="block h-5 w-5 shrink-0" />

                <button
                  type="button"
                  class="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm px-0.5 py-0.5 text-left outline-none focus:outline-none"
                  @click.stop="handleSelectItem(item)"
                >
                  <component
                    :is="item.type === 'directory' ? FolderOpen : File"
                    class="h-4 w-4 shrink-0"
                    :class="item.type === 'directory' && item.expanded ? 'text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textMuted)]'"
                  />
                  <span
                    class="theme-list-item-title min-w-0 flex-1 truncate"
                    :class="item.type === 'directory' ? 'font-medium text-[var(--theme-textPrimary)]' : 'text-[var(--theme-textPrimary)]'"
                  >
                    {{ getDisplayName(item) }}
                  </span>
                </button>
              </div>
            </div>
          </div>
        </div>
      </aside>

      <section class="flex min-h-0 flex-col overflow-hidden">
        <div class="theme-divider border-b px-4 py-2">
          <div class="flex items-center justify-between gap-3">
            <div class="min-w-0">
              <p v-if="previewMetaLabel" class="theme-muted-text truncate text-[12px]">
                {{ previewMetaLabel }}
              </p>
              <p v-if="showTextPreview" class="theme-muted-text mt-1 text-[11px]">
                {{ t('sourceBrowser.selectCodeLineHint') }}
              </p>
            </div>
          </div>
        </div>

        <div class="min-h-0 flex-1 overflow-auto px-4 py-3">
          <div
            v-if="previewLoading"
            class="theme-empty-state flex h-full min-h-[12rem] items-center justify-center text-[12px]"
          >
            <span>{{ t('sourceBrowser.previewLoading') }}</span>
          </div>

          <div
            v-else-if="previewError"
            class="theme-status-danger rounded-sm border px-4 py-3 text-[12px]"
          >
            {{ previewError }}
          </div>

          <div
            v-else-if="selectedItemType === 'directory'"
            class="theme-empty-state flex h-full min-h-[12rem] items-center justify-center text-[12px]"
          >
            {{ t('sourceBrowser.selectFileHint') }}
          </div>

          <div
            v-else-if="!selectedPath"
            class="theme-empty-state flex h-full min-h-[12rem] items-center justify-center text-[12px]"
          >
            {{ t('sourceBrowser.selectFile') }}
          </div>

          <div
            v-else-if="showImagePreview"
            class="source-browser-image-wrap flex h-full min-h-[12rem] items-center justify-center overflow-hidden rounded-sm border p-4"
          >
            <img
              :src="previewPayload.previewUrl"
              :alt="previewTitle"
              class="source-browser-image object-contain"
            >
          </div>

          <div
            v-else-if="showBinaryState"
            class="theme-empty-state flex h-full min-h-[12rem] flex-col items-center justify-center gap-3 text-[12px]"
          >
            <FileImage class="h-8 w-8" />
            <span>{{ previewPayload?.tooLarge ? t('sourceBrowser.binaryTooLarge') : t('sourceBrowser.binaryUnsupported') }}</span>
          </div>

          <div
            v-else-if="showTextPreview"
            ref="previewContainerRef"
            class="source-browser-code relative rounded-sm border"
            :style="{
              '--source-code-bg': previewCodeBg || 'var(--theme-panel)',
              '--source-code-fg': previewCodeFg || 'var(--theme-textPrimary)',
              '--source-code-gutter-width': previewGutterWidth,
            }"
            @copy="handlePreviewCopy"
            @mouseup="handlePreviewMouseUp"
          >
            <div class="source-code-view">
              <table class="source-code-view__table">
                <tbody v-html="previewCodeHtml" />
              </table>
            </div>
            <SelectionInsertButton
              v-if="open && previewSelectionAction.visible"
              :top="previewSelectionAction.top"
              :left="previewSelectionAction.left"
              :label="t('sourceBrowser.insertSelection')"
              @click="insertSelectedPreviewCodeContext"
            />
          </div>
        </div>
      </section>
    </div>
  </DialogShell>
</template>

<style scoped>
.source-browser-image-wrap {
  border-color: var(--theme-borderDefault);
  background: var(--theme-panel);
}

.source-browser-image {
  display: block;
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
}

.source-browser-code {
  background: var(--source-code-bg);
  border-color: var(--theme-borderDefault);
  color: var(--source-code-fg);
  height: 100%;
  overflow: auto;
}

.source-browser-layout .theme-list-item-title,
.source-browser-layout .theme-list-item-subtitle,
.source-browser-layout .theme-list-item-meta {
  font-size: 12px;
  line-height: 1.5;
}

.source-code-view {
  min-width: max-content;
}

.source-code-view__table {
  border-collapse: separate;
  border-spacing: 0;
  color: inherit;
  font-family: var(--theme-fontMono);
  font-size: var(--theme-codeViewFontSize);
  line-height: 1.6;
  min-width: 100%;
  width: max-content;
}

.source-code-view :deep(.source-code-view__gutter) {
  border-right: 1px solid color-mix(in srgb, var(--theme-borderDefault) 82%, transparent);
  color: color-mix(in srgb, var(--source-code-fg) 50%, transparent);
  font-family: var(--theme-fontMono);
  font-size: var(--theme-codeViewGutterFontSize);
  width: var(--source-code-gutter-width);
  min-width: var(--source-code-gutter-width);
  max-width: var(--source-code-gutter-width);
  padding: 0 0.38rem;
  text-align: right;
  user-select: none;
  vertical-align: top;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.source-code-view :deep(.source-code-view__code) {
  padding: 0 0.8rem;
  vertical-align: top;
  white-space: pre;
  user-select: text;
  -webkit-user-select: text;
}

.source-code-view :deep(.source-code-view__line-inner) {
  display: block;
  min-height: 1.46em;
  user-select: text;
  -webkit-user-select: text;
}

.source-code-view :deep(.source-code-view__line.is-match) {
  background: var(--theme-accentSoft);
  box-shadow: inset 3px 0 0 var(--theme-accent);
}

.source-code-view :deep(.source-code-view__line.is-selected) {
  background: var(--theme-accentSoft);
  box-shadow: inset 3px 0 0 var(--theme-accent);
}

.source-code-view :deep(.source-code-view__search-hit) {
  border-radius: 0.125rem;
  background: var(--theme-warningSoft);
  color: inherit;
}

.source-code-view :deep(.source-code-view__line.is-focus-match) {
  background: color-mix(in srgb, var(--theme-accentSoft) 76%, var(--theme-warningSoft) 24%);
  box-shadow:
    inset 4px 0 0 var(--theme-accent),
    inset 0 0 0 1px color-mix(in srgb, var(--theme-accent) 22%, transparent);
}

.source-code-view :deep(.source-code-view__line.is-focus-match .source-code-view__search-hit) {
  background: color-mix(in srgb, var(--theme-warningSoft) 72%, white 28%);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--theme-warning) 22%, transparent);
}
</style>
