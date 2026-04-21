<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { ChevronDown, ChevronUp } from 'lucide-vue-next'
import SelectionInsertButton from './SelectionInsertButton.vue'
import TaskDiffBinaryPreview from './TaskDiffBinaryPreview.vue'
import { useCodeSelectionAction } from '../composables/useCodeSelectionAction.js'
import { useI18n } from '../composables/useI18n.js'
import { useTheme } from '../composables/useTheme.js'
import {
  DIFF_HIGHLIGHT_LIMITS,
  exceedsHighlightThresholdForLines,
  inferPreviewLanguageFromPath,
  renderHighlightedCodeLines,
  renderPlainCodeLines,
} from '../lib/sourceCodePreview.js'

const props = defineProps({
  activeHunkIndex: {
    type: Number,
    default: 0,
  },
  getPatchLineClass: {
    type: Function,
    default: () => '',
  },
  getFileBlobUrl: {
    type: Function,
    default: () => '',
  },
  getStatusClass: {
    type: Function,
    default: () => '',
  },
  getStatusLabel: {
    type: Function,
    default: (value) => value,
  },
  jumpToAdjacentHunk: {
    type: Function,
    default: () => {},
  },
  patchLoading: {
    type: Boolean,
    default: false,
  },
  selectedFile: {
    type: Object,
    default: null,
  },
  selectedPatchHunks: {
    type: Array,
    default: () => [],
  },
  selectedPatchLines: {
    type: Array,
    default: () => [],
  },
  setPatchLineRef: {
    type: Function,
    default: () => {},
  },
  setPatchViewportRef: {
    type: Function,
    default: () => {},
  },
})
const emit = defineEmits(['insert-code-context'])
const { t } = useI18n()
const { isDark } = useTheme()
const renderedPatchLines = ref([])
const selectedLanguage = computed(() => inferPreviewLanguageFromPath(props.selectedFile?.path || ''))
const patchViewportElement = ref(null)
const patchRowElements = new Map()
const isBinaryPreview = computed(() => Boolean(props.selectedFile?.binary && props.selectedFile?.binaryPreview))

function isSelectableLine(line = {}) {
  return ['add', 'delete', 'context'].includes(String(line?.kind || '').trim())
}

function resolveRenderedPatchLineById(lineId = '') {
  const normalizedLineId = String(lineId || '').trim()
  if (!normalizedLineId) {
    return null
  }

  return renderedPatchLines.value.find((line) => line.id === normalizedLineId) || null
}

const {
  selectedRows: selectedDiffRows,
  selectionAction,
  clearSelectionState: clearSelectionAction,
  handleSelectionMouseUp: handleViewportMouseUp,
  updateSelectionActionFromDom,
} = useCodeSelectionAction({
  getContainer: () => patchViewportElement.value,
  isActive: () => Boolean(props.selectedFile && props.selectedPatchLines.length),
  rowSelector: '.task-diff-row[data-line-id]',
  getOrderedRowElements: (container) => [...container.querySelectorAll('.task-diff-row[data-line-id]')]
    .filter((rowElement) => isSelectableLine(resolveRenderedPatchLineById(rowElement.getAttribute('data-line-id')))),
  mapRowElement: (rowElement) => resolveRenderedPatchLineById(rowElement?.getAttribute?.('data-line-id') || ''),
  getCodeLeft: (rowElement) => {
    const codeElement = rowElement?.querySelector?.('.task-diff-line')
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

function getSelectedRangeMetrics(rows = []) {
  const numbers = rows.flatMap((line) => [
    Number(line?.oldNumber || 0),
    Number(line?.newNumber || 0),
  ]).filter((line) => line > 0)
  if (!numbers.length) {
    return {
      start: 0,
      end: 0,
      label: '',
    }
  }

  const start = Math.min(...numbers)
  const end = Math.max(...numbers)
  return {
    start,
    end,
    label: start === end ? `L${start}` : `L${start}-L${end}`,
  }
}

function getSelectedRowsText(rows = []) {
  return rows
    .map((line) => String(line?.content || ''))
    .join('\n')
    .replace(/\u200b/g, '')
    .trim()
}

function insertSelectedCodeContext() {
  if (!props.selectedFile || !selectionAction.value.visible || !selectedDiffRows.value.length) {
    return
  }

  const range = getSelectedRangeMetrics(selectedDiffRows.value)
  emit('insert-code-context', {
    source: 'diff',
    filePath: String(props.selectedFile.path || ''),
    language: 'diff',
    rangeLabel: range.label,
    lineStart: range.start,
    lineEnd: range.end,
    content: getSelectedRowsText(selectedDiffRows.value)
      || String(selectionAction.value.content || '').trim(),
  })

  window.getSelection?.()?.removeAllRanges?.()
  clearSelectionAction()
}

function setCombinedPatchLineRef(lineId, element) {
  props.setPatchLineRef(lineId, element)

  if (!lineId) {
    return
  }

  if (element) {
    patchRowElements.set(lineId, element)
    return
  }

  patchRowElements.delete(lineId)
}

function setPatchViewportElement(element) {
  patchViewportElement.value = element || null
  props.setPatchViewportRef(element)
}

function handleViewportCopy(event) {
  const selection = window.getSelection?.()
  const container = patchViewportElement.value
  if (!selection || selection.rangeCount < 1 || selection.isCollapsed || !container) {
    return
  }

  updateSelectionActionFromDom()

  const range = selection.getRangeAt(0)
  const commonAncestor = range.commonAncestorContainer
  if (!container.contains(commonAncestor?.nodeType === 1 ? commonAncestor : commonAncestor?.parentNode)) {
    return
  }

  const rows = selectedDiffRows.value
  if (!rows.length) {
    return
  }

  const text = getSelectedRowsText(rows)
  if (!text) {
    return
  }

  event?.clipboardData?.setData?.('text/plain', text)
  event?.preventDefault?.()
}

function getLinePrefix(line) {
  if (line?.kind === 'add') {
    return '+'
  }
  if (line?.kind === 'delete') {
    return '-'
  }
  if (line?.kind === 'context') {
    return ' '
  }
  return ''
}

function getLineBody(line) {
  const content = String(line?.content || '')
  if (line?.kind === 'add' || line?.kind === 'delete' || line?.kind === 'context') {
    return content.slice(1)
  }
  return content
}

function escapeHtml(value = '') {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function buildRenderedPatchLine(line, bodyHtml = '') {
  if (line?.kind === 'add' || line?.kind === 'delete' || line?.kind === 'context') {
    const prefix = getLinePrefix(line)
    const kindClass = `task-diff-line__prefix--${line.kind}`

    return {
      ...line,
      renderedHtml: `<span class="task-diff-line__prefix ${kindClass}">${escapeHtml(prefix || ' ')}</span><span class="task-diff-line__body">${bodyHtml || '&#8203;'}</span>`,
    }
  }

  return {
    ...line,
    renderedHtml: escapeHtml(String(line?.content || '')),
  }
}

async function renderPatchLines() {
  const lines = Array.isArray(props.selectedPatchLines) ? props.selectedPatchLines : []
  const codeEntries = []

  lines.forEach((line, index) => {
    if (line?.kind === 'add' || line?.kind === 'delete' || line?.kind === 'context') {
      codeEntries.push({
        lineIndex: index,
        body: getLineBody(line),
      })
    }
  })

  const plainBodies = renderPlainCodeLines(codeEntries.map((entry) => entry.body))
  let plainBodyIndex = 0
  renderedPatchLines.value = lines.map((line) => {
    if (line?.kind === 'add' || line?.kind === 'delete' || line?.kind === 'context') {
      const bodyHtml = plainBodies[plainBodyIndex] || '&#8203;'
      plainBodyIndex += 1
      return buildRenderedPatchLine(line, bodyHtml)
    }

    return buildRenderedPatchLine(line)
  })

  if (!codeEntries.length) {
    return
  }
  
  if (exceedsHighlightThresholdForLines(codeEntries.map((entry) => entry.body), DIFF_HIGHLIGHT_LIMITS)) {
    return
  }

  const highlightedBodies = await renderHighlightedCodeLines(codeEntries.map((entry) => entry.body), {
    isDark: isDark.value,
    language: selectedLanguage.value,
    maxHighlightLines: DIFF_HIGHLIGHT_LIMITS.maxLines,
    maxHighlightChars: DIFF_HIGHLIGHT_LIMITS.maxChars,
  })

  let highlightedIndex = 0
  renderedPatchLines.value = lines.map((line) => {
    if (line?.kind === 'add' || line?.kind === 'delete' || line?.kind === 'context') {
      const bodyHtml = highlightedBodies[highlightedIndex] || '&#8203;'
      highlightedIndex += 1
      return buildRenderedPatchLine(line, bodyHtml)
    }

    return buildRenderedPatchLine(line)
  })
}

watch(
  () => [props.selectedPatchLines, props.selectedFile?.path, isDark.value],
  () => {
    clearSelectionAction()
    renderPatchLines()
  },
  { immediate: true, deep: true }
)

onBeforeUnmount(() => {
  window.getSelection?.()?.removeAllRanges?.()
  clearSelectionAction({ clearBrowserSelection: true })
  patchRowElements.clear()
})
</script>

<template>
  <div v-if="selectedFile" class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="theme-divider theme-secondary-text border-b px-4 py-3 text-[12px]">
      <div class="space-y-3 sm:hidden">
        <div class="flex items-start gap-2">
          <span class="inline-flex shrink-0 rounded-sm border px-1.5 py-0.5 text-[12px]" :class="getStatusClass(selectedFile.status)">
            {{ getStatusLabel(selectedFile.status) }}
          </span>
          <span class="min-w-0 break-all font-medium text-[var(--theme-textPrimary)]">{{ selectedFile.path }}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <div class="min-w-0">
            <div class="opacity-75">
              {{ selectedFile.statsLoaded ? `+${selectedFile.additions} / -${selectedFile.deletions}` : t('diffReview.statsOnDemand') }}
            </div>
            <div v-if="!isBinaryPreview" class="theme-muted-text mt-1 text-[11px]">{{ t('diffReview.selectCodeLineHint') }}</div>
          </div>
          <div
            class="inline-flex h-8 shrink-0 items-center gap-1 rounded-sm border px-1.5 py-1"
            :class="selectedPatchHunks.length
              ? 'theme-inline-panel'
              : 'pointer-events-none invisible border-transparent'"
          >
            <button
              type="button"
              class="theme-icon-button h-6 w-6 disabled:opacity-50"
              :disabled="activeHunkIndex <= 0"
              @click="jumpToAdjacentHunk(-1)"
            >
              <ChevronUp class="h-4 w-4" />
            </button>
            <span class="min-w-[64px] text-center text-[12px] text-[var(--theme-textSecondary)]">
              {{ t('diffReview.changeIndex', { current: Math.min(activeHunkIndex + 1, selectedPatchHunks.length), total: selectedPatchHunks.length }) }}
            </span>
            <button
              type="button"
              class="theme-icon-button h-6 w-6 disabled:opacity-50"
              :disabled="activeHunkIndex >= selectedPatchHunks.length - 1"
              @click="jumpToAdjacentHunk(1)"
            >
              <ChevronDown class="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      <div class="hidden items-center gap-3 sm:flex">
        <div class="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <span class="inline-flex rounded-sm border px-1.5 py-0.5 text-[12px]" :class="getStatusClass(selectedFile.status)">
            {{ getStatusLabel(selectedFile.status) }}
          </span>
          <span class="break-all font-medium text-[var(--theme-textPrimary)]">{{ selectedFile.path }}</span>
          <span class="opacity-75">
            {{ selectedFile.statsLoaded ? `+${selectedFile.additions} / -${selectedFile.deletions}` : t('diffReview.statsOnDemand') }}
          </span>
          <span v-if="!isBinaryPreview" class="theme-muted-text text-[11px]">{{ t('diffReview.selectCodeLineHint') }}</span>
        </div>
        <div
          class="inline-flex h-8 w-[132px] shrink-0 items-center gap-1 rounded-sm border px-1.5 py-1"
          :class="selectedPatchHunks.length
            ? 'theme-inline-panel'
            : 'pointer-events-none invisible border-transparent'"
        >
          <button
            type="button"
            class="theme-icon-button h-6 w-6 disabled:opacity-50"
            :disabled="activeHunkIndex <= 0"
            @click="jumpToAdjacentHunk(-1)"
          >
            <ChevronUp class="h-4 w-4" />
          </button>
          <span class="min-w-[64px] text-center text-[12px] text-[var(--theme-textSecondary)]">
            {{ t('diffReview.changeIndex', { current: Math.min(activeHunkIndex + 1, selectedPatchHunks.length), total: selectedPatchHunks.length }) }}
          </span>
          <button
            type="button"
            class="theme-icon-button h-6 w-6 disabled:opacity-50"
            :disabled="activeHunkIndex >= selectedPatchHunks.length - 1"
            @click="jumpToAdjacentHunk(1)"
          >
            <ChevronDown class="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>

    <TaskDiffBinaryPreview
      v-if="selectedFile.binary && selectedFile.binaryPreview"
      :get-file-blob-url="getFileBlobUrl"
      :selected-file="selectedFile"
    />
    <div v-else-if="selectedFile.message && !selectedPatchLines.length" class="theme-secondary-text flex-1 overflow-y-auto px-4 py-4 text-[12px]">
      <div class="theme-empty-state px-4 py-4">
        {{ selectedFile.message }}
      </div>
    </div>
    <div v-else-if="patchLoading && !selectedFile.patchLoaded" class="theme-muted-text flex-1 overflow-y-auto px-4 py-4 text-[12px]">{{ t('diffReview.loadingFileDiff') }}</div>
    <div
      v-else-if="selectedPatchLines.length"
      :ref="setPatchViewportElement"
      class="relative flex-1 overflow-auto"
      @copy="handleViewportCopy"
      @mouseup="handleViewportMouseUp"
    >
      <div class="task-diff-view min-w-max px-4 py-4 font-mono">
        <div
          v-if="selectedFile.message"
          class="theme-inline-panel theme-secondary-text mb-3 rounded-sm border border-dashed px-3 py-2 text-[12px]"
        >
          {{ selectedFile.message }}
        </div>
        <div
          v-for="line in renderedPatchLines"
          :key="line.id"
          :ref="(element) => setCombinedPatchLineRef(line.id, element)"
          class="task-diff-row grid"
          :data-line-id="line.id"
          :data-line-kind="line.kind"
          :class="[
            getPatchLineClass(line.kind),
            line.kind === 'hunk' && selectedPatchHunks[activeHunkIndex]?.id === line.id
              ? 'ring-1 ring-inset ring-[var(--theme-warning)]'
              : '',
          ]"
        >
          <span class="task-diff-row__number select-none">
            {{ line.oldNumber }}
          </span>
          <span class="task-diff-row__number select-none">
            {{ line.newNumber }}
          </span>
          <pre
            class="task-diff-line overflow-visible whitespace-pre px-3 py-0.5"
            :class="line.kind === 'meta' || line.kind === 'hunk' ? 'task-diff-line--plain' : ''"
            v-html="line.renderedHtml"
          />
        </div>
      </div>
      <SelectionInsertButton
        v-if="selectionAction.visible"
        :top="selectionAction.top"
        :left="selectionAction.left"
        :label="t('diffReview.insertSelection')"
        @click="insertSelectedCodeContext"
      />
    </div>
    <div v-else class="theme-secondary-text flex-1 overflow-y-auto px-4 py-4 text-[12px]">
      <div class="theme-empty-state px-4 py-4">
        {{ t('diffReview.noFileDiffContent') }}
      </div>
    </div>
  </div>

  <div v-else class="theme-muted-text flex h-full items-center justify-center px-5 text-[12px]">
    {{ t('diffReview.selectFile') }}
  </div>
</template>

<style scoped>
.task-diff-row {
  grid-template-columns: 3.1rem 3.1rem minmax(0, 1fr);
}

.task-diff-view {
  font-size: var(--theme-codeViewFontSize);
  line-height: var(--theme-codeViewLineHeight);
}

.task-diff-row__number {
  border-right: 1px solid var(--theme-borderMuted);
  color: color-mix(in srgb, var(--theme-textPrimary) 52%, transparent);
  font-size: var(--theme-codeViewGutterFontSize);
  font-variant-numeric: tabular-nums;
  padding: 0.125rem 0.5rem;
  text-align: right;
}

.task-diff-line {
  color: inherit;
  user-select: text;
  -webkit-user-select: text;
}

.task-diff-line :deep(.task-diff-line__prefix) {
  display: inline-block;
  font-weight: 600;
  user-select: none;
  width: 1ch;
}

.task-diff-line :deep(.task-diff-line__prefix--add) {
  color: var(--theme-successText);
}

.task-diff-line :deep(.task-diff-line__prefix--delete) {
  color: var(--theme-dangerText);
}

.task-diff-line :deep(.task-diff-line__prefix--context) {
  color: color-mix(in srgb, var(--theme-textPrimary) 35%, transparent);
}

.task-diff-line :deep(.task-diff-line__body) {
  display: inline;
}

.task-diff-line--plain {
  color: inherit;
}
</style>
