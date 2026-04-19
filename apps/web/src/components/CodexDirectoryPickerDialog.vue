<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  Check,
  ChevronRight,
  FolderOpen,
  LoaderCircle,
  Search,
} from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import { useI18n } from '../composables/useI18n.js'
import {
  listCodexDirectoryTree,
  searchCodexDirectories,
} from '../lib/api.js'
import {
  isAbortError,
  WORKSPACE_PATH_SEARCH_DEBOUNCE_MS,
  WORKSPACE_SEARCH_MIN_QUERY_LENGTH,
} from '../lib/workspaceSearch.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  initialPath: {
    type: String,
    default: '',
  },
  suggestions: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['close', 'select'])
const { t } = useI18n()

const homePath = ref('')
const rootNode = ref(null)
const treeLoading = ref(false)
const treeError = ref('')
const searchLoading = ref(false)
const searchError = ref('')
const searchResults = ref([])
const searchTruncated = ref(false)
const query = ref('')
const selectedPath = ref('')
const searchInputRef = ref(null)

let searchTimer = null
let searchRequestId = 0
let searchAbortController = null
const itemRefs = new Map()

const treeItems = computed(() => flattenTreeNodes(rootNode.value ? [rootNode.value] : []))
const normalizedQuery = computed(() => String(query.value || '').trim())
const isQueryReady = computed(() => normalizedQuery.value.length >= WORKSPACE_SEARCH_MIN_QUERY_LENGTH)
const isSearchMode = computed(() => Boolean(normalizedQuery.value))
const visibleItems = computed(() => (isSearchMode.value ? searchResults.value : treeItems.value))
const visibleItemsSignature = computed(() => visibleItems.value
  .map((item) => {
    const path = normalizePathForCompare(item?.path || '')
    const expanded = item?.expanded ? 1 : 0
    const loading = item?.loading ? 1 : 0
    return `${path}:${expanded}:${loading}`
  })
  .join('|'))
const showSearchPromptState = computed(() => isSearchMode.value && !isQueryReady.value && !searchLoading.value && !searchError.value)
const showSearchEmptyState = computed(() => isSearchMode.value && isQueryReady.value && !searchLoading.value && !searchError.value && !searchResults.value.length)
const showTreeEmptyState = computed(() => !isSearchMode.value && !treeLoading.value && !treeError.value && !treeItems.value.length)

function isWindowsPath(value = '') {
  const text = String(value || '').trim()
  return /^[a-z]:[\\/]/i.test(text) || text.includes('\\')
}

function normalizePathForCompare(value = '') {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const windows = isWindowsPath(raw)
  let normalized = raw.replace(/\\/g, '/')

  if (normalized.length > 1 && !/^[a-z]:\/?$/i.test(normalized) && normalized !== '/') {
    normalized = normalized.replace(/\/+$/, '')
  }

  return windows ? normalized.toLowerCase() : normalized
}

function pathStartsWith(targetPath = '', basePath = '') {
  const target = normalizePathForCompare(targetPath)
  const base = normalizePathForCompare(basePath)
  if (!target || !base) {
    return false
  }

  return target === base || target.startsWith(`${base}/`)
}

function joinPath(basePath = '', segment = '') {
  const base = String(basePath || '').trim()
  const child = String(segment || '').trim()
  if (!base) {
    return child
  }
  if (!child) {
    return base
  }

  if (isWindowsPath(base)) {
    if (/^[a-z]:\\?$/i.test(base)) {
      return `${base.replace(/[\\/]+$/, '')}\\${child}`
    }
    return `${base.replace(/[\\/]+$/, '')}\\${child}`
  }

  if (base === '/') {
    return `/${child}`
  }

  return `${base.replace(/\/+$/, '')}/${child}`
}

function getRelativeSegments(basePath = '', targetPath = '') {
  const base = normalizePathForCompare(basePath)
  const target = normalizePathForCompare(targetPath)
  if (!base || !target || !pathStartsWith(target, base)) {
    return []
  }

  const remainder = target === base ? '' : target.slice(base.length).replace(/^\//, '')
  return remainder ? remainder.split('/').filter(Boolean) : []
}

function getParentPath(pathValue = '') {
  const raw = String(pathValue || '').trim()
  if (!raw || normalizePathForCompare(raw) === normalizePathForCompare(homePath.value)) {
    return ''
  }

  const windows = isWindowsPath(raw)
  const normalized = raw.replace(/\\/g, '/')

  if (windows) {
    const trimmed = normalized.replace(/\/+$/, '')
    const index = trimmed.lastIndexOf('/')
    if (index <= 2) {
      return ''
    }
    const parent = trimmed.slice(0, index).replace(/\//g, '\\')
    return pathStartsWith(parent, homePath.value) ? parent : ''
  }

  const trimmed = normalized.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  if (index <= 0) {
    return ''
  }
  const parent = trimmed.slice(0, index) || '/'
  return pathStartsWith(parent, homePath.value) ? parent : ''
}

function getDisplayName(item) {
  return item?.name || item?.path || t('directoryPicker.unnamedDirectory')
}

function getRootDisplayName(pathValue = '') {
  const normalized = String(pathValue || '').trim()
  if (!normalized) {
    return 'Home'
  }

  const segments = normalized.split(/[\\/]/).filter(Boolean)
  return segments.at(-1) || normalized
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function findHighlightRange(text = '', keyword = '') {
  const source = String(text || '')
  const queryText = String(keyword || '').trim().toLowerCase()
  if (!source || !queryText) {
    return null
  }

  const normalizedSource = source.toLowerCase()
  const directIndex = normalizedSource.indexOf(queryText)
  if (directIndex >= 0) {
    return { start: directIndex, end: directIndex + queryText.length }
  }

  const tokens = queryText
    .split(/[\\/\s_.-]+/)
    .filter(Boolean)
    .sort((left, right) => right.length - left.length)

  for (const token of tokens) {
    if (token.length < 2) {
      continue
    }

    const tokenIndex = normalizedSource.indexOf(token)
    if (tokenIndex >= 0) {
      return { start: tokenIndex, end: tokenIndex + token.length }
    }
  }

  return null
}

function renderHighlightedText(text = '', keyword = '') {
  const source = String(text || '')
  const range = findHighlightRange(source, keyword)
  if (!range) {
    return escapeHtml(source)
  }

  return `${escapeHtml(source.slice(0, range.start))}<mark class="theme-search-highlight">${escapeHtml(source.slice(range.start, range.end))}</mark>${escapeHtml(source.slice(range.end))}`
}

function getHighlightedName(item) {
  return renderHighlightedText(getDisplayName(item), query.value)
}

function getHighlightedPath(item) {
  return renderHighlightedText(item?.path || '', query.value)
}

function createTreeNode(entry, depth = 0) {
  return {
    ...entry,
    depth,
    expanded: false,
    loaded: false,
    loading: false,
    children: [],
  }
}

function flattenTreeNodes(nodes = [], output = []) {
  nodes.forEach((node) => {
    output.push(node)
    if (node.expanded && node.children.length) {
      flattenTreeNodes(node.children, output)
    }
  })
  return output
}

function refreshTree() {
  if (rootNode.value) {
    rootNode.value = { ...rootNode.value }
  }
}

function clearSearchRequest() {
  if (searchTimer) {
    window.clearTimeout(searchTimer)
    searchTimer = null
  }
  if (searchAbortController) {
    searchAbortController.abort()
    searchAbortController = null
  }
}

function findTreeNode(targetPath, nodes = rootNode.value ? [rootNode.value] : []) {
  const compareKey = normalizePathForCompare(targetPath)
  if (!compareKey) {
    return null
  }

  for (const node of nodes) {
    if (normalizePathForCompare(node.path) === compareKey) {
      return node
    }
    if (node.children.length) {
      const nested = findTreeNode(targetPath, node.children)
      if (nested) {
        return nested
      }
    }
  }

  return null
}

function updateSelectedDirectory(item) {
  selectedPath.value = String(item?.path || '').trim()
}

function getItemRefKey(pathValue = '') {
  return normalizePathForCompare(pathValue)
}

function setItemRef(pathValue, element) {
  const key = getItemRefKey(pathValue)
  if (!key) {
    return
  }

  if (element) {
    itemRefs.set(key, element)
    return
  }

  itemRefs.delete(key)
}

function scrollActiveItemIntoView() {
  const target = itemRefs.get(getItemRefKey(selectedPath.value))
  target?.scrollIntoView?.({ block: 'nearest' })
}

function focusSearchInput() {
  nextTick(() => {
    searchInputRef.value?.focus?.()
  })
}

function syncSelectedDirectory() {
  const items = visibleItems.value
  if (!items.length) {
    selectedPath.value = ''
    return
  }

  const selectedKey = getItemRefKey(selectedPath.value)
  if (selectedKey && items.some((item) => getItemRefKey(item?.path || '') === selectedKey)) {
    return
  }

  updateSelectedDirectory(items[0])
}

function getCurrentActiveIndex() {
  const items = visibleItems.value
  if (!items.length) {
    return -1
  }

  const selectedKey = getItemRefKey(selectedPath.value)
  const index = items.findIndex((item) => getItemRefKey(item?.path || '') === selectedKey)
  return index >= 0 ? index : 0
}

function getActiveItem() {
  const items = visibleItems.value
  const index = getCurrentActiveIndex()
  if (index < 0 || !items.length) {
    return null
  }

  return items[index] || null
}

function moveActive(step = 1) {
  const items = visibleItems.value
  if (!items.length) {
    return false
  }

  const currentIndex = getCurrentActiveIndex()
  const nextIndex = currentIndex < 0
    ? 0
    : (currentIndex + step + items.length) % items.length

  updateSelectedDirectory(items[nextIndex])
  nextTick(scrollActiveItemIntoView)
  return true
}

async function expandActiveDirectory() {
  if (isSearchMode.value) {
    return false
  }

  const item = getActiveItem()
  if (!item || !item.hasChildren) {
    return false
  }

  if (!item.expanded) {
    await toggleDirectory(item)
    return true
  }

  const items = visibleItems.value
  const currentIndex = getCurrentActiveIndex()
  const nextItem = items[currentIndex + 1]
  if (nextItem && getParentPath(nextItem.path) === item.path) {
    updateSelectedDirectory(nextItem)
    nextTick(scrollActiveItemIntoView)
    return true
  }

  return false
}

function collapseActiveDirectory() {
  if (isSearchMode.value) {
    return false
  }

  const item = getActiveItem()
  if (!item) {
    return false
  }

  if (item.expanded && item.hasChildren) {
    item.expanded = false
    refreshTree()
    updateSelectedDirectory(item)
    return true
  }

  const parentPath = getParentPath(item.path)
  if (!parentPath) {
    return false
  }

  const parentNode = findTreeNode(parentPath)
  if (!parentNode) {
    return false
  }

  updateSelectedDirectory(parentNode)
  nextTick(scrollActiveItemIntoView)
  return true
}

function handleEscapeIntent(event) {
  event?.preventDefault?.()

  if (normalizedQuery.value) {
    event?.stopPropagation?.()
    query.value = ''
    return
  }

  event?.stopPropagation?.()
  emit('close')
}

function handleListKeydown(event) {
  const key = String(event?.key || '')
  if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape'].includes(key)) {
    return
  }

  if (isSearchMode.value && (key === 'ArrowLeft' || key === 'ArrowRight')) {
    return
  }

  if (key === 'ArrowDown') {
    event.preventDefault()
    moveActive(1)
    return
  }

  if (key === 'ArrowUp') {
    event.preventDefault()
    moveActive(-1)
    return
  }

  if (key === 'Escape') {
    handleEscapeIntent(event)
    return
  }

  if (isSearchMode.value) {
    if (key === 'Enter') {
      event.preventDefault()
      const activeItem = getActiveItem()
      if (activeItem) {
        handleSearchSelect(activeItem)
      }
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
    handlePick()
  }
}

async function loadDirectoryNode(node, options = {}) {
  if (!node || node.loading) {
    return
  }

  if (node.loaded && !options.force) {
    return
  }

  node.loading = true
  treeError.value = ''
  refreshTree()

  try {
    const payload = await listCodexDirectoryTree({
      path: node.path,
      limit: 240,
    })
    node.children = (payload.items || []).map((item) => createTreeNode(item, node.depth + 1))
    node.loaded = true
  } catch (err) {
    treeError.value = err.message || t('directoryPicker.loadFailed')
  } finally {
    node.loading = false
    refreshTree()
  }
}

async function loadHomeRoot() {
  treeLoading.value = true
  treeError.value = ''

  try {
    const payload = await listCodexDirectoryTree({
      limit: 240,
    })
    homePath.value = String(payload.path || '')
    rootNode.value = createTreeNode({
      name: getRootDisplayName(payload.path || ''),
      path: String(payload.path || ''),
      type: 'directory',
      hasChildren: true,
      isHomeRoot: true,
    }, 0)
    rootNode.value.children = (payload.items || []).map((item) => createTreeNode(item, 1))
    rootNode.value.loaded = true
    rootNode.value.expanded = true
    updateSelectedDirectory(rootNode.value)
  } catch (err) {
    treeError.value = err.message || t('directoryPicker.treeLoadFailed')
    rootNode.value = null
    homePath.value = ''
  } finally {
    treeLoading.value = false
  }
}

async function expandToPath(targetPath = '') {
  const normalizedTarget = String(targetPath || '').trim()
  if (!normalizedTarget || !homePath.value || !pathStartsWith(normalizedTarget, homePath.value)) {
    return
  }

  let node = rootNode.value
  if (!node) {
    return
  }

  updateSelectedDirectory(node)

  const segments = getRelativeSegments(homePath.value, normalizedTarget)
  for (const segment of segments) {
    await loadDirectoryNode(node)
    node.expanded = true
    refreshTree()
    const nextNode = findTreeNode(joinPath(node.path, segment), node.children)
    if (!nextNode) {
      break
    }
    node = nextNode
    updateSelectedDirectory(node)
  }
}

async function initializePicker() {
  query.value = ''
  searchResults.value = []
  searchError.value = ''
  searchTruncated.value = false
  selectedPath.value = ''

  await loadHomeRoot()

  const targetPath = String(props.initialPath || '').trim()
  if (targetPath && pathStartsWith(targetPath, homePath.value)) {
    await expandToPath(targetPath)
  }
}

async function toggleDirectory(item) {
  if (!item?.path) {
    return
  }

  updateSelectedDirectory(item)

  if (!item.hasChildren) {
    return
  }

  if (!item.loaded) {
    item.expanded = true
    refreshTree()
    await loadDirectoryNode(item)
    return
  }

  item.expanded = !item.expanded
  refreshTree()
}

function handleTreeSelect(item) {
  if (!item?.path) {
    return
  }

  updateSelectedDirectory(item)
}

async function refreshSearch() {
  const keyword = String(query.value || '').trim()
  searchRequestId += 1
  const requestId = searchRequestId
  clearSearchRequest()

  if (!props.open || !keyword || !homePath.value || !isQueryReady.value) {
    searchLoading.value = false
    searchError.value = ''
    searchResults.value = []
    searchTruncated.value = false
    return
  }

  searchLoading.value = true
  searchError.value = ''
  searchAbortController = new AbortController()

  try {
    const payload = await searchCodexDirectories(keyword, {
      path: homePath.value,
      limit: 80,
      signal: searchAbortController.signal,
    })

    if (requestId !== searchRequestId) {
      return
    }

    searchResults.value = Array.isArray(payload.items) ? payload.items : []
    searchTruncated.value = Boolean(payload.truncated)
  } catch (err) {
    if (isAbortError(err)) {
      return
    }
    if (requestId !== searchRequestId) {
      return
    }

    searchError.value = err.message || t('directoryPicker.searchFailed')
    searchResults.value = []
    searchTruncated.value = false
  } finally {
    if (requestId === searchRequestId) {
      searchAbortController = null
    }
    if (requestId === searchRequestId) {
      searchLoading.value = false
    }
  }
}

function scheduleSearch() {
  clearSearchRequest()

  if (!String(query.value || '').trim() || !isQueryReady.value) {
    searchLoading.value = false
    searchError.value = ''
    searchResults.value = []
    searchTruncated.value = false
    return
  }

  searchLoading.value = true
  searchError.value = ''
  searchTimer = window.setTimeout(() => {
    searchTimer = null
    refreshSearch()
  }, WORKSPACE_PATH_SEARCH_DEBOUNCE_MS)
}

async function handleSearchSelect(item) {
  if (!item?.path) {
    return
  }

  await expandToPath(item.path)
  query.value = ''
}

function handlePick() {
  if (!selectedPath.value) {
    return
  }

  emit('select', selectedPath.value)
  emit('close')
}

watch(query, () => {
  scheduleSearch()
})

watch(
  visibleItemsSignature,
  () => {
    syncSelectedDirectory()
    nextTick(scrollActiveItemIntoView)
  },
  { immediate: true }
)

watch(
  () => props.open,
  (open) => {
    if (open) {
      initializePicker().catch(() => {})
      focusSearchInput()
      return
    }

    clearSearchRequest()
  }
)

onBeforeUnmount(() => {
  clearSearchRequest()
})

</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="1"
    panel-class="settings-dialog-panel h-[calc(100dvh-1rem)] max-w-4xl sm:h-[96vh] sm:max-h-[96vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body flex min-h-0 flex-1 flex-col overflow-hidden px-4 py-4 sm:px-5"
    :close-disabled="treeLoading || searchLoading"
    :close-on-backdrop="!(treeLoading || searchLoading)"
    :close-on-escape="!(treeLoading || searchLoading)"
    @close="emit('close')"
  >
    <template #title>
      <div>
        <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
          <FolderOpen class="h-4 w-4" />
          <span>{{ t('directoryPicker.title') }}</span>
        </div>
        <p class="theme-muted-text mt-1 text-xs leading-5">
          {{ t('directoryPicker.intro') }}
        </p>
      </div>
    </template>

    <div class="flex min-h-0 flex-1 flex-col overflow-hidden" @keydown="handleListKeydown">
      <div class="theme-divider mt-4 rounded-sm border border-dashed px-3 py-2">
        <div class="flex items-start gap-2 text-xs leading-5">
          <span class="theme-muted-text shrink-0">{{ t('directoryPicker.currentSelection') }}</span>
          <span class="min-w-0 break-all font-mono text-[var(--theme-textPrimary)]">
            {{ selectedPath || t('directoryPicker.selectionPlaceholder') }}
          </span>
        </div>
      </div>

      <label class="theme-muted-text mt-4 block text-xs">
        <span>{{ t('directoryPicker.searchLabel') }}</span>
        <div
          class="theme-input-shell mt-1 flex h-10 items-center gap-2 rounded-sm border px-3 transition focus-within:ring-2"
        >
          <Search class="h-4 w-4 shrink-0 text-[var(--theme-textMuted)]" />
          <input
            ref="searchInputRef"
            v-model="query"
            type="text"
            :placeholder="t('directoryPicker.searchPlaceholder')"
            class="min-w-0 flex-1 border-0 bg-transparent px-0 text-sm text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
            @keydown.esc="handleEscapeIntent"
          >
        </div>
      </label>

      <div class="theme-content-panel mt-3 min-h-0 flex-1 overflow-y-auto p-2">
        <div
          v-if="isSearchMode && searchError"
          class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
        >
          {{ searchError }}
        </div>

        <div
          v-else-if="!isSearchMode && treeError"
          class="theme-status-danger rounded-sm border border-dashed px-3 py-3 text-xs"
        >
          {{ treeError }}
        </div>

        <div
          v-else-if="isSearchMode && searchLoading"
          class="theme-empty-state flex items-center justify-center gap-2 px-3 py-8 text-sm"
        >
          <LoaderCircle class="h-4 w-4 animate-spin" />
          <span>{{ t('directoryPicker.searching') }}</span>
        </div>

        <div
          v-else-if="!isSearchMode && treeLoading"
          class="theme-empty-state flex items-center justify-center gap-2 px-3 py-8 text-sm"
        >
          <LoaderCircle class="h-4 w-4 animate-spin" />
          <span>{{ t('directoryPicker.treeLoading') }}</span>
        </div>

        <div
          v-else-if="showSearchPromptState"
          class="theme-empty-state px-3 py-8 text-sm"
        >
          {{ t('directoryPicker.searchMinKeywordHint', { count: WORKSPACE_SEARCH_MIN_QUERY_LENGTH }) }}
        </div>

        <div
          v-else-if="showSearchEmptyState"
          class="theme-empty-state px-3 py-8 text-sm"
        >
          {{ t('directoryPicker.noSearchResults') }}
        </div>

        <div
          v-else-if="showTreeEmptyState"
          class="theme-empty-state px-3 py-8 text-sm"
        >
          {{ t('directoryPicker.emptyTree') }}
        </div>

        <div v-else-if="isSearchMode" class="space-y-1">
          <button
            v-for="item in searchResults"
            :key="item.path"
            :ref="(element) => setItemRef(item.path, element)"
            type="button"
            class="theme-list-row focus:outline-none"
            :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
              ? 'theme-list-item-active'
              : 'theme-list-item-hover'"
            @click="handleSearchSelect(item)"
          >
            <FolderOpen class="theme-list-item-icon" />
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
          <p v-if="searchTruncated" class="theme-muted-text px-1 pt-2 text-xs">
            {{ t('directoryPicker.truncatedHint') }}
          </p>
        </div>

        <div v-else class="space-y-1">
          <div
            v-for="item in treeItems"
            :key="item.path"
            :ref="(element) => setItemRef(item.path, element)"
            class="theme-list-tree-item outline-none focus:outline-none focus-visible:outline-none"
            :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
              ? 'theme-list-item-active'
              : item.expanded
                ? 'theme-list-item-expanded'
                : 'theme-list-item-hover'"
            :style="{ paddingLeft: `${item.depth * 16 + 6}px` }"
          >
            <div class="flex items-start gap-1.5">
              <button
                type="button"
                class="theme-icon-button h-5 w-5 shrink-0"
                :class="!item.hasChildren ? 'invisible pointer-events-none' : ''"
                @click.stop="toggleDirectory(item)"
              >
                <LoaderCircle v-if="item.loading" class="h-3.5 w-3.5 animate-spin" />
                <ChevronRight
                  v-else
                  class="h-3.5 w-3.5 transition"
                  :class="item.expanded ? 'rotate-90 text-[var(--theme-textPrimary)]' : ''"
                />
              </button>

              <button
                type="button"
                class="flex min-w-0 flex-1 items-start gap-1.5 rounded-sm px-0.5 py-0.5 text-left"
                @click="handleTreeSelect(item)"
              >
                <FolderOpen
                  class="h-4 w-4 shrink-0"
                  :class="normalizePathForCompare(selectedPath) === normalizePathForCompare(item.path)
                    ? 'text-[var(--theme-textPrimary)]'
                    : 'text-[var(--theme-textMuted)]'"
                />
                <div class="min-w-0 flex-1">
                  <div
                    class="theme-list-item-title truncate"
                    :class="item.isHomeRoot
                      ? 'font-medium text-[var(--theme-textSecondary)]'
                      : 'font-medium text-[var(--theme-textPrimary)]'"
                  >
                    {{ getDisplayName(item) }}
                  </div>
                  <div
                    v-if="item.isHomeRoot"
                    class="theme-list-item-subtitle theme-list-item-subtitle--mono break-all"
                  >
                    {{ item.path }}
                  </div>
                </div>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="theme-divider flex flex-col-reverse gap-2 border-t border-dashed px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-5">
      <div class="flex flex-col-reverse gap-2 sm:flex-row sm:items-center">
        <button
          type="button"
          class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
          :disabled="treeLoading || searchLoading"
          @click="emit('close')"
        >
          {{ t('directoryPicker.cancel') }}
        </button>
        <button
          type="button"
          class="tool-button tool-button-primary inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-xs sm:w-auto"
          :disabled="treeLoading || searchLoading || !selectedPath"
          @click="handlePick"
        >
          <Check class="h-4 w-4" />
          <span>{{ t('directoryPicker.useCurrentDirectory') }}</span>
        </button>
      </div>
    </div>
  </DialogShell>
</template>
