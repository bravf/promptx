<script setup>
import { computed, ref, watch } from 'vue'
import { ChevronDown, ChevronUp, MessageSquarePlus } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import { useTheme } from '../composables/useTheme.js'
import { buildReviewCommentSnippet } from '../lib/reviewComments.js'
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
  commentingEnabled: {
    type: Boolean,
    default: false,
  },
  getPatchLineClass: {
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
const emit = defineEmits(['request-review-comment'])
const { t } = useI18n()
const { isDark } = useTheme()
const renderedPatchLines = ref([])
let longPressTimer = null
const selectedLanguage = computed(() => inferPreviewLanguageFromPath(props.selectedFile?.path || ''))

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
    renderPatchLines()
  },
  { immediate: true, deep: true }
)

function canCommentOnLine(line = {}) {
  if (!props.commentingEnabled) {
    return false
  }

  return ['add', 'delete', 'context'].includes(String(line?.kind || '').trim())
}

function buildReviewCommentPayload(line = {}) {
  if (!props.selectedFile || !canCommentOnLine(line)) {
    return null
  }

  const snippet = buildReviewCommentSnippet(props.selectedPatchLines, line.id)
  if (!snippet) {
    return null
  }

  return {
    anchorLineId: String(line.id || ''),
    anchorOldNumber: line.oldNumber ?? '',
    anchorNewNumber: line.newNumber ?? '',
    content: String(line.content || '').trim(),
    filePath: String(props.selectedFile.path || ''),
    fileStatus: String(props.selectedFile.status || ''),
    snippet,
  }
}

function requestReviewComment(line = {}) {
  const payload = buildReviewCommentPayload(line)
  if (!payload) {
    return
  }

  emit('request-review-comment', payload)
}

function clearLongPressTimer() {
  if (longPressTimer) {
    clearTimeout(longPressTimer)
    longPressTimer = null
  }
}

function handleLineTouchStart(line) {
  clearLongPressTimer()
  if (!canCommentOnLine(line)) {
    return
  }

  longPressTimer = setTimeout(() => {
    longPressTimer = null
    requestReviewComment(line)
  }, 450)
}
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
          <span class="opacity-75">
            {{ selectedFile.statsLoaded ? `+${selectedFile.additions} / -${selectedFile.deletions}` : t('diffReview.statsOnDemand') }}
          </span>
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

    <div v-if="selectedFile.message" class="theme-secondary-text flex-1 overflow-y-auto px-4 py-4 text-[12px]">
      <div class="theme-empty-state px-4 py-4">
        {{ selectedFile.message }}
      </div>
    </div>
    <div v-else-if="patchLoading && !selectedFile.patchLoaded" class="theme-muted-text flex-1 overflow-y-auto px-4 py-4 text-[12px]">{{ t('diffReview.loadingFileDiff') }}</div>
    <div v-else-if="selectedPatchLines.length" :ref="setPatchViewportRef" class="flex-1 overflow-auto">
      <div class="task-diff-view min-w-max px-4 py-4 font-mono">
        <div
          v-for="line in renderedPatchLines"
          :key="line.id"
          :ref="(element) => setPatchLineRef(line.id, element)"
          class="task-diff-row group relative grid"
          :class="[
            getPatchLineClass(line.kind),
            line.kind === 'hunk' && selectedPatchHunks[activeHunkIndex]?.id === line.id
              ? 'ring-1 ring-inset ring-[var(--theme-warning)]'
              : '',
          ]"
          @touchstart="handleLineTouchStart(line)"
          @touchend="clearLongPressTimer"
          @touchcancel="clearLongPressTimer"
          @touchmove="clearLongPressTimer"
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
          <button
            v-if="canCommentOnLine(line)"
            type="button"
            class="theme-icon-button absolute right-2 top-1 hidden h-7 w-7 items-center justify-center opacity-0 transition group-hover:opacity-100 sm:inline-flex"
            :title="t('reviewComments.addAction')"
            @click="requestReviewComment(line)"
          >
            <MessageSquarePlus class="h-4 w-4" />
          </button>
        </div>
      </div>
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
