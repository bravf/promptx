<script setup>
import { ref, watch } from 'vue'
import { Check, CircleAlert, FileDiff, FolderOpen, GitBranch, RefreshCw } from 'lucide-vue-next'
import { formatDateTime, useI18n } from '../composables/useI18n.js'
import { useMediaQuery } from '../composables/useMediaQuery.js'
import { useTaskDiffReviewData } from '../composables/useTaskDiffReviewData.js'
import TaskDiffFileList from './TaskDiffFileList.vue'
import TaskDiffPatchView from './TaskDiffPatchView.vue'
import WorkbenchSelect from './WorkbenchSelect.vue'

const props = defineProps({
  taskSlug: {
    type: String,
    default: '',
  },
  preferredScope: {
    type: String,
    default: 'workspace',
  },
  preferredRunId: {
    type: String,
    default: '',
  },
  focusToken: {
    type: Number,
    default: 0,
  },
  active: {
    type: Boolean,
    default: false,
  },
})
const emit = defineEmits(['insert-code-context'])

const {
  activeHunkIndex,
  baselineMetaText,
  diffPayload,
  diffScope,
  error,
  fileSearch,
  filteredFiles,
  formatRunOptionLabel,
  getFilterButtonClass,
  getFilterLabel,
  getFileBlobUrl,
  getPatchLineClass,
  getRunStatusLabel,
  getStatusClass,
  getStatusLabel,
  jumpToAdjacentHunk,
  loading,
  patchLoading,
  patchViewportRef,
  refreshDiff,
  selectedFile,
  selectedFilePath,
  selectedPatchHunks,
  selectedPatchLines,
  selectedRunId,
  setPatchLineRef,
  showSummarySkeleton,
  statsLoading,
  statusCounts,
  statusFilter,
  terminalRuns,
} = useTaskDiffReviewData(props)

const { matches: isMobileLayout } = useMediaQuery('(max-width: 767px)')
const mobilePanelTab = ref('files')
const { t } = useI18n()

function handleSelectFile(path) {
  selectedFilePath.value = path
  if (isMobileLayout.value) {
    mobilePanelTab.value = 'patch'
  }
}

function setPatchViewportElement(element) {
  patchViewportRef.value = element || null
}

watch(
  isMobileLayout,
  (matches) => {
    if (!matches) {
      mobilePanelTab.value = 'files'
    }
  },
  { immediate: true }
)

watch(selectedFilePath, (value) => {
  if (!value && isMobileLayout.value) {
    mobilePanelTab.value = 'files'
  }
})

watch(diffScope, () => {
  if (isMobileLayout.value) {
    mobilePanelTab.value = 'files'
  }
})
</script>

<template>
  <section class="panel flex h-full min-h-0 flex-col overflow-hidden">
    <div class="theme-divider border-b px-4 py-3">
      <div class="flex flex-col gap-2">
        <div class="grid grid-cols-4 gap-2 sm:flex sm:flex-wrap sm:items-center">
          <button
            type="button"
            class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
            :class="diffScope === 'workspace' ? 'theme-filter-active' : ''"
            @click="diffScope = 'workspace'"
          >
            <span class="sm:hidden">{{ t('diffReview.scopeCurrentShort') }}</span>
            <span class="hidden sm:inline">{{ t('diffReview.scopeCurrent') }}</span>
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
            :class="diffScope === 'task' ? 'theme-filter-active' : ''"
            @click="diffScope = 'task'"
          >
            <span class="sm:hidden">{{ t('diffReview.scopeTaskShort') }}</span>
            <span class="hidden sm:inline">{{ t('diffReview.scopeTask') }}</span>
          </button>
          <button
            type="button"
            class="tool-button inline-flex items-center justify-center gap-2 px-3 py-2 text-xs"
            :class="diffScope === 'run' ? 'theme-filter-active' : ''"
            @click="diffScope = 'run'"
          >
            <span>{{ t('diffReview.scopeRun') }}</span>
          </button>
          <button
            type="button"
            class="tool-button tool-button-info-subtle inline-flex shrink-0 items-center justify-center gap-2 px-3 py-2 text-xs"
            :disabled="loading"
            @click="refreshDiff"
          >
            <RefreshCw class="h-3.5 w-3.5 sm:hidden" :class="loading ? 'animate-spin' : ''" />
            <span class="sm:hidden">{{ t('diffReview.refresh') }}</span>
            <RefreshCw class="hidden h-3.5 w-3.5 sm:inline-block" :class="loading ? 'animate-spin' : ''" />
            <span class="hidden sm:inline">{{ loading ? t('diffReview.refreshing') : statsLoading ? t('diffReview.computing') : t('diffReview.refresh') }}</span>
          </button>
        </div>

        <WorkbenchSelect
          v-if="diffScope === 'run'"
          v-model="selectedRunId"
          class="min-w-0 sm:max-w-[360px]"
          :options="terminalRuns"
          :loading="loading"
          :get-option-value="(run) => run?.id || ''"
          :placeholder="t('diffReview.selectRun')"
          :empty-text="t('diffReview.noRuns')"
        >
          <template #trigger="{ selectedOption }">
            <div class="truncate text-xs text-[var(--theme-textPrimary)]">
              {{ selectedOption ? formatRunOptionLabel(selectedOption) : t('diffReview.selectRun') }}
            </div>
          </template>

          <template #header>
            <div class="theme-divider theme-muted-text border-b border-dashed px-3 py-2 text-[11px]">
              {{ t('diffReview.runCount', { count: terminalRuns.length }) }}
            </div>
          </template>

          <template #option="{ option, selected, select }">
            <button
              type="button"
              class="w-full rounded-sm border border-dashed px-3 py-2 text-left transition"
              :class="selected ? 'theme-filter-active' : 'theme-filter-idle'"
                  @click="select"
            >
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <div class="truncate text-xs font-medium text-[var(--theme-textPrimary)]">
                    {{ formatDateTime(option.startedAt || option.createdAt, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}
                  </div>
                  <div class="theme-muted-text mt-1 text-[11px]">
                    {{ getRunStatusLabel(option) }}
                  </div>
                </div>

                <Check
                  v-if="selected"
                  class="mt-0.5 h-4 w-4 shrink-0 text-[var(--theme-textSecondary)]"
                />
              </div>
            </button>
          </template>
        </WorkbenchSelect>
      </div>
    </div>

    <div v-if="error" class="theme-divider theme-danger-text border-b px-4 py-3 text-sm">
      <div class="inline-flex items-start gap-2">
        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="break-all">{{ error }}</span>
      </div>
    </div>

    <div v-if="loading && !diffPayload" class="theme-muted-text flex flex-1 items-center justify-center px-5 text-sm">{{ t('diffReview.loading') }}</div>

    <div v-else-if="diffPayload && !diffPayload.supported" class="flex flex-1 items-center justify-center px-5">
      <div class="theme-empty-state w-full max-w-xl px-4 py-5 text-sm text-[var(--theme-textSecondary)]">
        <div class="theme-heading inline-flex items-center gap-2 font-medium">
          <FileDiff class="h-4 w-4" />
          <span>{{ t('diffReview.unavailableTitle') }}</span>
        </div>
        <p class="mt-2 break-all leading-7">{{ diffPayload.reason || t('diffReview.unavailableReason') }}</p>
        <div v-if="diffPayload.repoRoot" class="mt-3 flex flex-wrap gap-2 text-xs">
          <div class="theme-status-neutral inline-flex items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5">
            <FolderOpen class="h-3.5 w-3.5 shrink-0" />
            <span class="break-all">{{ diffPayload.repoRoot }}</span>
          </div>
          <div
            v-if="diffPayload.branch"
            class="theme-status-success inline-flex items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5"
          >
            <GitBranch class="h-3.5 w-3.5 shrink-0" />
            <span>{{ diffPayload.branch }}</span>
          </div>
        </div>
      </div>
    </div>

    <div v-else-if="diffPayload" class="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div class="theme-divider theme-secondary-text border-b px-4 py-3 text-xs">
        <div class="flex flex-wrap items-center gap-2">
          <div
            v-if="diffPayload.repoRoot"
            class="theme-status-info inline-flex min-w-0 items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5"
          >
            <FolderOpen class="h-3.5 w-3.5 shrink-0" />
            <span class="min-w-0 break-all">{{ diffPayload.repoRoot }}</span>
          </div>
          <div
            class="theme-status-success inline-flex items-center gap-2 rounded-sm border border-dashed px-2.5 py-1.5"
          >
            <GitBranch class="h-3.5 w-3.5 shrink-0" />
            <span>{{ diffPayload.branch || t('diffReview.unknownBranch') }}</span>
            <span class="opacity-50">•</span>
            <span class="text-[var(--theme-textPrimary)]">{{ t('diffReview.fileCount', { count: diffPayload.summary?.fileCount || 0 }) }}</span>
            <template v-if="diffPayload.summary?.statsComplete">
              <span class="opacity-50">•</span>
              <span class="font-medium text-[var(--theme-success)]">+{{ diffPayload.summary?.additions || 0 }}</span>
              <span class="font-medium text-[var(--theme-danger)]">-{{ diffPayload.summary?.deletions || 0 }}</span>
            </template>
            <template v-else-if="showSummarySkeleton">
              <span class="opacity-50">•</span>
              <span class="h-3 w-10 animate-pulse rounded bg-[var(--theme-successSoft)]" />
              <span class="h-3 w-10 animate-pulse rounded bg-[var(--theme-dangerSoft)]" />
            </template>
            <span v-else class="opacity-75">{{ t('diffReview.waitingStats') }}</span>
          </div>
        </div>
        <p v-if="baselineMetaText" class="mt-2 break-all text-[11px] opacity-75">
          {{ baselineMetaText }}
        </p>
        <div v-if="diffPayload.warnings?.length" class="mt-2 flex flex-col gap-1">
          <p
            v-for="warning in diffPayload.warnings"
            :key="warning"
            class="text-[11px] text-[var(--theme-warningText)]"
          >
            {{ warning }}
          </p>
        </div>
      </div>

      <div v-if="isMobileLayout" class="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div class="theme-divider border-b px-3 py-3">
          <div class="grid grid-cols-2 gap-2">
            <button
              type="button"
              class="tool-button px-3 py-2 text-sm"
              :class="mobilePanelTab === 'files' ? 'tool-button-accent-subtle' : ''"
              @click="mobilePanelTab = 'files'"
            >
              {{ t('diffReview.filesTab') }}
            </button>
            <button
              type="button"
              class="tool-button px-3 py-2 text-sm"
              :class="mobilePanelTab === 'patch' ? 'tool-button-accent-subtle' : ''"
              :disabled="!selectedFile"
              @click="mobilePanelTab = 'patch'"
            >
              {{ t('diffReview.diffTab') }}
            </button>
          </div>
        </div>

        <div v-show="mobilePanelTab === 'files'" class="theme-divider theme-muted-panel min-h-0 flex-1 overflow-y-auto p-3">
          <TaskDiffFileList
            :auto-focus-selected="active && mobilePanelTab === 'files'"
            :diff-payload="diffPayload"
            :file-search="fileSearch"
            :focus-token="focusToken"
            :filtered-files="filteredFiles"
            :get-filter-button-class="getFilterButtonClass"
            :get-filter-label="getFilterLabel"
            :get-status-class="getStatusClass"
            :get-status-label="getStatusLabel"
            :selected-file-path="selectedFilePath"
            :show-summary-skeleton="showSummarySkeleton"
            :status-counts="statusCounts"
            :status-filter="statusFilter"
            @update:file-search="fileSearch = $event"
            @update:status-filter="statusFilter = $event"
            @select-file="handleSelectFile"
          />
        </div>

        <div v-show="mobilePanelTab === 'patch'" class="min-h-0 flex-1 overflow-hidden bg-[var(--theme-appPanelStrong)]">
          <TaskDiffPatchView
            :active-hunk-index="activeHunkIndex"
            :get-file-blob-url="getFileBlobUrl"
            :get-patch-line-class="getPatchLineClass"
            :get-status-class="getStatusClass"
            :get-status-label="getStatusLabel"
            :jump-to-adjacent-hunk="jumpToAdjacentHunk"
            :patch-loading="patchLoading"
            :selected-file="selectedFile"
            :selected-patch-hunks="selectedPatchHunks"
            :selected-patch-lines="selectedPatchLines"
            :set-patch-line-ref="setPatchLineRef"
            :set-patch-viewport-ref="setPatchViewportElement"
            @insert-code-context="emit('insert-code-context', $event)"
          />
        </div>
      </div>

      <div v-else class="grid min-h-0 flex-1 grid-cols-[320px_minmax(0,1fr)] overflow-hidden">
        <div class="theme-divider theme-muted-panel min-h-0 overflow-y-auto border-r p-3">
          <TaskDiffFileList
            :auto-focus-selected="active"
            :diff-payload="diffPayload"
            :file-search="fileSearch"
            :focus-token="focusToken"
            :filtered-files="filteredFiles"
            :get-filter-button-class="getFilterButtonClass"
            :get-filter-label="getFilterLabel"
            :get-status-class="getStatusClass"
            :get-status-label="getStatusLabel"
            :selected-file-path="selectedFilePath"
            :show-summary-skeleton="showSummarySkeleton"
            :status-counts="statusCounts"
            :status-filter="statusFilter"
            @update:file-search="fileSearch = $event"
            @update:status-filter="statusFilter = $event"
            @select-file="selectedFilePath = $event"
          />
        </div>

        <div class="min-h-0 overflow-hidden bg-[var(--theme-appPanelStrong)]">
          <TaskDiffPatchView
            :active-hunk-index="activeHunkIndex"
            :get-file-blob-url="getFileBlobUrl"
            :get-patch-line-class="getPatchLineClass"
            :get-status-class="getStatusClass"
            :get-status-label="getStatusLabel"
            :jump-to-adjacent-hunk="jumpToAdjacentHunk"
            :patch-loading="patchLoading"
            :selected-file="selectedFile"
            :selected-patch-hunks="selectedPatchHunks"
            :selected-patch-lines="selectedPatchLines"
            :set-patch-line-ref="setPatchLineRef"
            :set-patch-viewport-ref="setPatchViewportElement"
            @insert-code-context="emit('insert-code-context', $event)"
          />
        </div>
      </div>
    </div>
  </section>
</template>
