<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { Search } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  diffPayload: {
    type: Object,
    default: null,
  },
  fileSearch: {
    type: String,
    default: '',
  },
  autoFocusSelected: {
    type: Boolean,
    default: false,
  },
  filteredFiles: {
    type: Array,
    default: () => [],
  },
  focusToken: {
    type: Number,
    default: 0,
  },
  getFilterButtonClass: {
    type: Function,
    default: () => '',
  },
  getFilterLabel: {
    type: Function,
    default: (value) => value,
  },
  getStatusClass: {
    type: Function,
    default: () => '',
  },
  getStatusLabel: {
    type: Function,
    default: (value) => value,
  },
  selectedFilePath: {
    type: String,
    default: '',
  },
  showSummarySkeleton: {
    type: Boolean,
    default: false,
  },
  statusCounts: {
    type: Object,
    default: () => ({}),
  },
  statusFilter: {
    type: String,
    default: 'all',
  },
})

const emit = defineEmits([
  'select-file',
  'update:fileSearch',
  'update:statusFilter',
])
const { t } = useI18n()
const fileItemRefs = new Map()
const pendingAutoFocusToken = ref(0)
const lastAutoFocusedToken = ref(0)

const fileSearchModel = computed({
  get: () => props.fileSearch,
  set: (value) => emit('update:fileSearch', value),
})

const statusFilterModel = computed({
  get: () => props.statusFilter,
  set: (value) => emit('update:statusFilter', value),
})

const hasDiffFiles = computed(() => Array.isArray(props.diffPayload?.files) && props.diffPayload.files.length > 0)

function setFileItemRef(path, element) {
  if (element) {
    fileItemRefs.set(path, element)
    return
  }

  fileItemRefs.delete(path)
}

function focusFileItem(path) {
  nextTick(() => {
    const element = fileItemRefs.get(path)
    element?.focus?.()
    element?.scrollIntoView?.({
      block: 'nearest',
      inline: 'nearest',
    })
  })
}

function focusSelectedFileWhenReady() {
  if (!props.autoFocusSelected || !props.selectedFilePath || pendingAutoFocusToken.value === lastAutoFocusedToken.value) {
    return
  }

  lastAutoFocusedToken.value = pendingAutoFocusToken.value
  focusFileItem(props.selectedFilePath)
}

function moveSelectedFile(step = 1, currentPath = '') {
  const files = Array.isArray(props.filteredFiles) ? props.filteredFiles : []
  if (!files.length) {
    return
  }

  const focusedIndex = files.findIndex((file) => file.path === currentPath)
  const selectedIndex = files.findIndex((file) => file.path === props.selectedFilePath)
  const currentIndex = Math.max(0, focusedIndex >= 0 ? focusedIndex : selectedIndex)
  const nextIndex = (currentIndex + step + files.length) % files.length
  const nextFile = files[nextIndex]

  if (!nextFile?.path) {
    return
  }

  emit('select-file', nextFile.path)
  focusFileItem(nextFile.path)
}

function handleFileKeydown(event, path) {
  const key = String(event?.key || '')
  if (key === 'ArrowDown') {
    event.preventDefault()
    moveSelectedFile(1, path)
    return
  }

  if (key === 'ArrowUp') {
    event.preventDefault()
    moveSelectedFile(-1, path)
    return
  }

  if ((key === 'Enter' || key === ' ') && path) {
    event.preventDefault()
    emit('select-file', path)
  }
}

watch(
  () => props.focusToken,
  (token) => {
    pendingAutoFocusToken.value = token
    focusSelectedFileWhenReady()
  },
  { immediate: true }
)

watch(
  () => props.selectedFilePath,
  () => {
    focusSelectedFileWhenReady()
  }
)
</script>

<template>
  <div class="mb-3 grid grid-cols-2 gap-2">
    <button
      v-for="filter in ['all', 'A', 'M', 'D']"
      :key="filter"
      type="button"
      class="inline-flex w-full items-center justify-center gap-1 whitespace-nowrap rounded-sm border px-2 py-1 text-[11px] transition"
      :class="getFilterButtonClass(filter)"
      @click="statusFilterModel = filter"
    >
      {{ getFilterLabel(filter) }} {{ statusCounts[filter] || 0 }}
    </button>
  </div>

  <label class="theme-input-shell mb-3 flex items-center gap-2 rounded-sm border px-3 py-2 text-xs text-[var(--theme-textMuted)]">
    <Search class="h-3.5 w-3.5 shrink-0" />
    <input
      v-model="fileSearchModel"
      type="text"
      :placeholder="t('diffReview.searchFilePath')"
      class="min-w-0 flex-1 bg-transparent text-xs text-[var(--theme-textPrimary)] outline-none placeholder:text-[var(--theme-textMuted)]"
    >
  </label>

  <div
    v-if="showSummarySkeleton"
    class="theme-empty-state theme-empty-state-strong mb-3 px-3 py-2 text-[11px]"
  >
    {{ t('diffReview.statsPending') }}
  </div>

  <div v-if="!hasDiffFiles" class="theme-empty-state px-3 py-4 text-xs">
    {{ t('diffReview.noChanges') }}
  </div>
  <div v-else-if="!filteredFiles.length" class="theme-empty-state px-3 py-4 text-xs">
    {{ t('diffReview.noMatches') }}
  </div>

  <div v-else class="space-y-1">
    <button
      v-for="file in filteredFiles"
      :key="file.path"
      :ref="(element) => setFileItemRef(file.path, element)"
      type="button"
      class="theme-list-row focus:outline-none"
      :class="file.path === selectedFilePath ? 'theme-list-item-active' : 'theme-list-item-hover'"
      @click="emit('select-file', file.path)"
      @keydown="handleFileKeydown($event, file.path)"
    >
      <span class="theme-list-item-badge" :class="getStatusClass(file.status)">
        {{ getStatusLabel(file.status) }}
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-start gap-2">
          <div class="theme-list-item-title min-w-0 flex-1 break-all">{{ file.path }}</div>
          <span
            v-if="file.binary"
            class="theme-status-info inline-flex shrink-0 items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]"
          >
            {{ t('diffReview.binaryTag') }}
          </span>
        </div>
        <div class="theme-list-item-meta mt-1">
          {{ file.binary
            ? (file.binaryPreview?.mimeType || t('diffReview.binaryPreviewTitle'))
            : (file.statsLoaded ? `+${file.additions} / -${file.deletions}` : t('diffReview.statsOnDemand')) }}
        </div>
      </div>
    </button>
  </div>
</template>
