<script setup>
import { computed, defineAsyncComponent, nextTick, ref, watch } from 'vue'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  CircleAlert,
  CircleStop,
  Eye,
  EyeOff,
  FileDiff,
  LoaderCircle,
  PencilLine,
  Plus,
} from 'lucide-vue-next'
import CodexSessionSelect from './CodexSessionSelect.vue'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import ProcessDetailRenderer from './ProcessDetailRenderer.vue'
import CodexSessionSourceBrowserDialog from './CodexSessionSourceBrowserDialog.vue'
import SelectionInsertButton from './SelectionInsertButton.vue'
import { useI18n } from '../composables/useI18n.js'
import { useAsyncRenderedMarkdown } from '../composables/useAsyncRenderedMarkdown.js'
import { useCodeSelectionAction } from '../composables/useCodeSelectionAction.js'
import { useCodexSessionPanel } from '../composables/useCodexSessionPanel.js'
import { getTurnAgentEngine, isShellTurn } from '../composables/codexSessionPanelTurns.js'
import { useCodexTranscriptCollapse } from '../composables/useCodexTranscriptCollapse.js'
import { useTheme } from '../composables/useTheme.js'
import { formatAgentBindingLabel } from '../lib/agentEngines.js'
import { renderCodexMarkdown, renderPlainCodexMarkdown } from '../lib/codexMarkdown.js'
import { aggregateProcessEvents } from '../lib/processEventGrouping.js'

const CodexSessionManagerDialog = defineAsyncComponent(() => import('./CodexSessionManagerDialog.vue'))

const emit = defineEmits([
  'agent-bindings-change',
  'insert-code-context',
  'project-created',
  'selected-session-change',
  'sending-change',
  'open-diff',
  'toast',
  'update:selectedAgentEngine',
])

const props = defineProps({
  prompt: {
    type: String,
    default: '',
  },
  buildPrompt: {
    type: Function,
    default: null,
  },
  buildPromptBlocks: {
    type: Function,
    default: null,
  },
  beforeSend: {
    type: Function,
    default: null,
  },
  afterSend: {
    type: Function,
    default: null,
  },
  taskSlug: {
    type: String,
    default: '',
  },
  selectedSessionId: {
    type: String,
    default: '',
  },
  selectedAgentEngine: {
    type: String,
    default: '',
  },
  active: {
    type: Boolean,
    default: false,
  },
  sessionSelectionLocked: {
    type: Boolean,
    default: false,
  },
  sessionSelectionLockReason: {
    type: String,
    default: '',
  },
  diffSupported: {
    type: Boolean,
    default: false,
  },
  taskRunning: {
    type: Boolean,
    default: false,
  },
})

const {
  closeManager,
  formatTurnTime,
  getProcessCardClass,
  getProcessStatus,
  getTurnAgentLabel,
  getDisplayTurnSummaryItems,
  getTurnSummaryDetail,
  getTurnSummaryStatus,
  handleCreateSession,
  handleDeleteSession,
  handleResetSession,
  handleSelectSession,
  handleSend,
  handleTranscriptScroll,
  handleTranscriptTouchEnd,
  handleTranscriptTouchMove,
  handleTranscriptTouchStart,
  handleUpdateSession,
  helperText,
  loadTurnEvents,
  loading,
  managerBusy,
  openManager,
  refreshSessionsForSelection,
  selectedSessionId,
  sending,
  showProcessLogs,
  stopping,
  hasTurnSummary,
  hasNewerMessages,
  sessionError,
  shouldShowResponse,
  showManager,
  sortedSessions,
  stopSending,
  toggleProcessLogs,
  transcriptRef,
  turns,
  workspaces,
  workingLabel,
  sessions,
  loadSessions,
  currentProjectAgentBindings,
  scheduleScrollToBottom,
  scrollToBottom,
} = useCodexSessionPanel(props, emit)

const COLLAPSED_PREVIEW_CLASS = 'max-h-40 overflow-hidden'
const managerDialogRef = ref(null)
const showSourceBrowser = ref(false)
const sourceBrowserSessionId = ref('')
const previewPromptImageUrl = ref('')
const SELECTED_AGENT_FILTER_STORAGE_KEY = 'promptx:selected-agent-filter-map'

function getPersistedAgentFilterMap() {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(SELECTED_AGENT_FILTER_STORAGE_KEY) || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed
    }
  } catch {
    // ignore
  }
  return {}
}

function persistAgentFilterMap(map) {
  window.localStorage.setItem(SELECTED_AGENT_FILTER_STORAGE_KEY, JSON.stringify(map))
}

const selectedAgentFilter = ref('all')

// 持久化到 localStorage
watch(selectedAgentFilter, (value) => {
  const taskSlug = String(props.taskSlug || '').trim()
  if (!taskSlug) {
    return
  }
  const map = getPersistedAgentFilterMap()
  map[taskSlug] = value
  persistAgentFilterMap(map)
})
const { t } = useI18n()
const { isDark } = useTheme()
const responseThemeKey = computed(() => (isDark.value ? 'dark' : 'light'))

const agentFilterOptions = computed(() => {
  const seen = new Set()
  return (Array.isArray(currentProjectAgentBindings.value) ? currentProjectAgentBindings.value : []).filter((item) => {
    const engine = String(item?.engine || '').trim()
    if (!engine || seen.has(engine)) {
      return false
    }
    seen.add(engine)
    return true
  })
})
const showAgentFilter = computed(() => agentFilterOptions.value.length > 1)
const filteredTurns = computed(() => {
  const filter = String(selectedAgentFilter.value || '').trim()
  if (!showAgentFilter.value || filter === 'all') {
    return turns.value
  }

  return turns.value.filter((turn) => getTurnAgentEngine(turn) === filter)
})

const {
  selectionAction: responseSelectionAction,
  clearSelectionState: clearResponseSelectionAction,
  handleSelectionMouseUp: handleResponseMouseUp,
} = useCodeSelectionAction({
  getContainer: () => transcriptRef.value,
  isActive: () => Boolean(props.active && turns.value.length),
  rowSelector: '[data-response-selection-root]',
  getOrderedRowElements: (container) => [...container.querySelectorAll('[data-response-selection-root]')],
  getCodeLeft: (rowElement) => rowElement?.getBoundingClientRect?.()?.left || 0,
  debounceMs: 72,
})

watch(
  [selectedAgentFilter, () => agentFilterOptions.value.map((item) => item.engine).join('\n')],
  () => {
    if (selectedAgentFilter.value === 'all') {
      return
    }
    if (!agentFilterOptions.value.length) {
      return
    }
    if (agentFilterOptions.value.some((item) => item.engine === selectedAgentFilter.value)) {
      return
    }
    selectedAgentFilter.value = 'all'
  },
  { immediate: true }
)

watch(
  selectedAgentFilter,
  () => {
    clearResponseSelectionAction({ clearBrowserSelection: true })
    scheduleScrollToBottom({ force: true })
  }
)

watch(
  () => props.taskSlug,
  (nextTaskSlug, previousTaskSlug) => {
    if (!String(nextTaskSlug || '').trim() || nextTaskSlug === previousTaskSlug) {
      return
    }

    const map = getPersistedAgentFilterMap()
    const saved = map[nextTaskSlug]
    selectedAgentFilter.value = saved || 'all'
  },
  { immediate: true }
)

function shouldHideSystemEvent(item = {}) {
  if (item?.kind === 'reasoning') {
    return true
  }

  const title = String(item?.title || '').trim()
  if (!title) {
    return false
  }

  return [
    /^已连接项目：/,
    /^工作目录：/,
    /^项目会话已更新$/,
    /^Codex 会话已创建$/,
    /^Claude Code 会话已创建$/,
    /^OpenCode 会话已创建$/,
    /^事件: claude\.system$/,
    /^线程 ID:/,
    /^Thread ID:/,
    /^Connected project:/,
    /^Working directory:/,
    /^Project session updated$/,
    / session created$/,
    /^Event: claude\.system$/,
    / 已返回结果$/,
    / returned a result$/,
    /^本轮执行结束$/,
    /^Run finished$/,
  ].some((pattern) => pattern.test(title))
}

function getTurnPromptTitle(turn = {}) {
  return t('sessionPanel.promptTitleWithAgent', { agent: getTurnAgentLabel(turn) })
}

function getTurnResponseTitle(turn = {}) {
  return turn.errorMessage
    ? t('sessionPanel.errorSuffix', { agent: getTurnAgentLabel(turn) })
    : t('sessionPanel.responseSuffix', { agent: getTurnAgentLabel(turn) })
}

const {
  getTurnEventCollapseKey,
  getTurnEventCount,
  hasTurnEventHistory,
  isTurnEventsCollapsed,
  toggleTurnEvents,
} = useCodexTranscriptCollapse({
  turns,
  loadTurnEvents,
})

function getResponseCacheKey(turn) {
  return String(turn?.runId || turn?.id || '').trim()
}

function openTurnDiff(turn) {
  if (!turn?.runId) {
    return
  }

  emit('open-diff', {
    scope: 'run',
    runId: turn.runId,
  })
}

function openTaskDiff() {
  emit('open-diff', {
    scope: 'workspace',
    runId: '',
  })
}

const { getRenderedHtml: renderResponseBody } = useAsyncRenderedMarkdown({
  items: turns,
  themeKey: responseThemeKey,
  getCacheKey: getResponseCacheKey,
  getSource: (turn) => String(turn?.responseMessage || ''),
  shouldRender: (turn) => Boolean(turn?.responseMessage) && !turn?.errorMessage,
  renderAsync: (source) => renderCodexMarkdown(source, {
    isDark: isDark.value,
    copyLabel: t('sessionPanel.copyCode'),
    copyAriaLabel: t('sessionPanel.copyCodeAria'),
  }),
  renderFallback: (source) => renderPlainCodexMarkdown(source),
  onRendered: (turn) => {
    const latestTurn = turns.value.at(-1) || null
    if (!props.active || !latestTurn?.runId || latestTurn.runId !== turn?.runId) {
      return
    }

    scheduleScrollToBottom()
  },
})

function openPromptImage(url) {
  previewPromptImageUrl.value = String(url || '').trim()
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

function getTurnPromptContent(turn = {}) {
  const promptBlocks = Array.isArray(turn?.promptBlocks) ? turn.promptBlocks : []
  const blockText = promptBlocks
    .filter((item) => item?.type === 'text' || item?.type === 'imported_text')
    .map((item) => String(item?.content || '').replace(/\u200b/g, '').trim())
    .filter(Boolean)
    .join('\n\n')

  if (blockText) {
    return blockText
  }

  return String(turn?.prompt || '').replace(/\u200b/g, '').trim()
}

function insertTurnPrompt(turn = {}) {
  const content = getTurnPromptContent(turn)
  if (!content) {
    return
  }

  emit('insert-code-context', {
    source: 'response',
    content,
  })
}

async function copyResponseCode(event) {
  const button = event?.target?.closest?.('[data-copy-code="1"]')
  if (!button) {
    return
  }

  const block = button.closest('.codex-code-block')
  const codeElement = block?.querySelector?.('pre code')
  const text = String(codeElement?.textContent || '').replace(/\u200b/g, '')
  if (!text) {
    return
  }

  event.preventDefault?.()
  event.stopPropagation?.()

  try {
    await copyText(text)
    emit('toast', {
      message: t('sessionPanel.codeCopied'),
      type: 'success',
    })
  } catch {
    emit('toast', {
      message: t('errors.requestFailed'),
      type: 'warning',
    })
  }
}

function insertSelectedResponseContext() {
  if (!responseSelectionAction.value.visible) {
    return
  }

  const content = String(responseSelectionAction.value.content || '').replace(/\u200b/g, '').trim()
  if (!content) {
    clearResponseSelectionAction({ clearBrowserSelection: true })
    return
  }

  emit('insert-code-context', {
    source: 'response',
    content,
  })

  clearResponseSelectionAction({ clearBrowserSelection: true })
}

function insertTurnResponse(turn = {}) {
  if (turn?.errorMessage) {
    return
  }

  const content = String(turn?.responseMessage || '').replace(/\u200b/g, '').trim()
  if (!content) {
    return
  }

  emit('insert-code-context', {
    source: 'response',
    content,
  })
}

const promptPreviewImages = computed(() => (
  turns.value.flatMap((turn) => (Array.isArray(turn?.promptBlocks) ? turn.promptBlocks : [])
    .filter((item) => item?.type === 'image')
    .map((item) => item.content))
))

function getVisibleTurnEvents(turn) {
  const events = Array.isArray(turn?.events) ? turn.events : []
  const filtered = events.filter((item) => !shouldHideSystemEvent(item))
  return aggregateProcessEvents(filtered)
}

function getTurnVisibleEventCount(turn) {
  return getTurnEventCount(turn)
}

function shouldShowEventToggle(turn) {
  if (!turn?.eventsLoaded) {
    return hasTurnEventHistory(turn)
  }

  return getTurnVisibleEventCount(turn) > 0
}

function shouldShowEventLoading(turn) {
  return Boolean(turn?.eventsLoading)
}

function shouldShowLoadedEvents(turn) {
  return Boolean(turn?.eventsLoaded) && getVisibleTurnEvents(turn).length > 0 && !isTurnEventsCollapsed(turn)
}

function shouldShowCollapsedEventHint(turn) {
  return Boolean(turn?.eventsLoaded) && getTurnVisibleEventCount(turn) > 0 && isTurnEventsCollapsed(turn)
}

function shouldShowDeferredEventHint(turn) {
  return hasTurnEventHistory(turn) && !turn?.eventsLoaded && !turn?.eventsLoading
}

function getAgentFilterLabel(item = {}) {
  return formatAgentBindingLabel(item, {
    defaultLabel: t('sessionPanel.defaultAgent'),
  })
}

function shouldShowProcessCard(turn = {}) {
  return !isShellTurn(turn)
}

function getEventCardClass(item = {}) {
  return 'bg-[var(--theme-appPanelStrong)]'
}

function resolveSourceBrowserSession(candidate = null) {
  const candidateId = String(candidate?.id || '').trim()
  if (candidateId) {
    return sessions.value.find((item) => item.id === candidateId) || null
  }

  const selectedId = String(selectedSessionId.value || '').trim()
  if (selectedId) {
    return sessions.value.find((item) => item.id === selectedId) || null
  }

  return sortedSessions.value[0] || null
}

function openSourceBrowser(session = null) {
  const targetSession = resolveSourceBrowserSession(session)
  if (!targetSession?.cwd) {
    return false
  }

  sourceBrowserSessionId.value = targetSession.id
  showSourceBrowser.value = true
  return true
}

function openProjectManager() {
  if (managerBusy.value) {
    return false
  }

  openManager()
  return true
}

function closeTopDialog() {
  if (showSourceBrowser.value) {
    showSourceBrowser.value = false
    return true
  }

  if (managerDialogRef.value?.closeTopDialog?.()) {
    return true
  }

  if (showManager.value) {
    closeManager()
    return true
  }

  return false
}

defineExpose({
  closeTopDialog,
  openProjectManager,
  openSourceBrowser,
  send: handleSend,
  scrollToBottom,
  stop: stopSending,
})
</script>

<template>
  <section class="workbench-activity-shell panel relative flex h-full min-h-0 flex-col overflow-hidden">
    <CodexSessionSourceBrowserDialog
      :open="showSourceBrowser"
      :session="sessions.find((item) => item.id === sourceBrowserSessionId) || null"
      @insert-code-context="emit('insert-code-context', $event)"
      @close="showSourceBrowser = false"
    />
    <CodexSessionManagerDialog
      ref="managerDialogRef"
      :open="showManager"
      :sessions="sessions"
      :workspaces="workspaces"
      :selected-session-id="selectedSessionId"
      :selection-locked="sessionSelectionLocked"
      :selection-lock-reason="sessionSelectionLockReason"
      :loading="loading"
      :sending="sending"
      :on-refresh="loadSessions"
      :on-create="handleCreateSession"
      :on-update="handleUpdateSession"
      :on-delete="handleDeleteSession"
      :on-reset="handleResetSession"
      @close="closeManager"
      @open-source-browser="openSourceBrowser($event)"
      @project-created="emit('project-created', $event)"
      @select-session="handleSelectSession"
    />

    <div class="workbench-panel-header theme-divider theme-muted-panel border-b p-3">
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <div class="min-w-0 flex-1" :title="helperText || ''">
            <CodexSessionSelect
              v-model="selectedSessionId"
              :sessions="sortedSessions"
              :loading="loading"
              :disabled="sending || managerBusy || sessionSelectionLocked"
              @refresh-intent="refreshSessionsForSelection"
            />
          </div>

          <div class="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              class="tool-button inline-flex h-9 w-9 items-center justify-center whitespace-nowrap px-0 py-0 text-xs"
              :class="showProcessLogs ? 'tool-button-accent-subtle' : ''"
              :aria-pressed="showProcessLogs ? 'true' : 'false'"
              :aria-label="showProcessLogs ? t('sessionPanel.hideProcessToggle') : t('sessionPanel.showProcessToggle')"
              :title="showProcessLogs ? t('sessionPanel.hideProcessToggle') : t('sessionPanel.showProcessToggle')"
              @click="toggleProcessLogs"
            >
              <Eye v-if="showProcessLogs" class="h-4 w-4" />
              <EyeOff v-else class="h-4 w-4" />
            </button>
            <button
              v-if="diffSupported"
              type="button"
              class="tool-button inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-xs sm:gap-2 sm:px-3"
              :disabled="!taskSlug"
              @click="openTaskDiff"
            >
              <FileDiff class="h-4 w-4" />
              <span class="sm:hidden">代码</span>
              <span class="hidden sm:inline">{{ t('sessionPanel.diff') }}</span>
            </button>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-1.5 whitespace-nowrap px-2.5 py-2 text-xs sm:gap-2 sm:px-3"
              :disabled="managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span class="sm:hidden">项目</span>
              <span class="hidden sm:inline">{{ t('sessionPanel.manageProjects') }}</span>
            </button>
          </div>
        </div>

        <div
          v-if="showAgentFilter"
          class="flex max-w-full items-center gap-1.5 overflow-x-auto pb-0.5"
          :aria-label="t('sessionPanel.agentFilter')"
        >
          <button
            type="button"
            class="theme-agent-selector-button"
            :class="selectedAgentFilter === 'all' ? 'theme-filter-active' : 'theme-filter-idle'"
            :aria-pressed="selectedAgentFilter === 'all' ? 'true' : 'false'"
            @click="selectedAgentFilter = 'all'"
          >
            {{ t('sessionPanel.allAgents') }}
          </button>
          <button
            v-for="item in agentFilterOptions"
            :key="item.engine"
            type="button"
            class="theme-agent-selector-button"
            :class="selectedAgentFilter === item.engine ? 'theme-filter-active' : 'theme-filter-idle'"
            :aria-pressed="selectedAgentFilter === item.engine ? 'true' : 'false'"
            :title="getAgentFilterLabel(item)"
            @click="selectedAgentFilter = item.engine"
          >
            {{ getAgentFilterLabel(item) }}
          </button>
        </div>

        <p v-if="sessionError" class="theme-danger-text inline-flex items-center gap-2 text-sm">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div
        ref="transcriptRef"
        data-promptx-transcript="1"
        class="workbench-transcript relative flex h-full flex-col gap-3 overflow-x-hidden overflow-y-auto px-4 py-4"
        @scroll="handleTranscriptScroll"
        @touchstart.passive="handleTranscriptTouchStart"
        @touchmove.passive="handleTranscriptTouchMove"
        @touchend.passive="handleTranscriptTouchEnd"
        @touchcancel.passive="handleTranscriptTouchEnd"
      >
        <div
          v-if="!turns.length"
          class="theme-empty-state px-4 py-6 text-sm"
        >
          {{ t('sessionPanel.empty') }}
        </div>
        <div
          v-else-if="!filteredTurns.length"
          class="theme-empty-state px-4 py-6 text-sm"
        >
          {{ t('sessionPanel.emptyAgentFilter') }}
        </div>

        <div
          v-for="turn in filteredTurns"
          :key="turn.id"
          data-promptx-turn="1"
          :data-turn-id="turn.id"
          :data-run-id="turn.runId || ''"
          class="flex min-w-0 flex-col gap-3"
        >
          <div class="flex justify-end">
            <div class="transcript-card transcript-card--prompt min-w-0 w-full rounded-sm bg-[var(--theme-promptBg)] px-4 py-3 font-mono text-sm text-[var(--theme-promptText)]">
              <div class="flex items-center justify-between gap-3 text-xs opacity-75 font-sans">
                <span class="font-semibold">{{ getTurnPromptTitle(turn) }}</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="getTurnPromptContent(turn)"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] transition hover:bg-[var(--theme-appPanelStrong)]"
                    @click="insertTurnPrompt(turn)"
                  >
                    <Plus class="h-3 w-3" />
                    <span>{{ t('sessionPanel.insert') }}</span>
                  </button>
                  <span>{{ formatTurnTime(turn.startedAt) }}</span>
                </div>
              </div>
              <div class="relative mt-2">
                <div
                  v-if="Array.isArray(turn.promptBlocks) && turn.promptBlocks.length"
                  class="space-y-3"
                >
                  <template v-for="(item, itemIndex) in turn.promptBlocks" :key="`${turn.id}-prompt-${itemIndex}`">
                    <pre
                      v-if="item.type === 'text' || item.type === 'imported_text'"
                      class="whitespace-pre-wrap break-words leading-7"
                    >{{ item.content }}</pre>
                    <button
                      v-else
                      type="button"
                      class="inline-flex cursor-zoom-in justify-center rounded-sm"
                      @click="openPromptImage(item.content)"
                    >
                      <img
                        :src="item.content"
                        :alt="t('sessionPanel.promptImageAlt')"
                        class="max-h-52 w-auto max-w-full rounded-sm object-contain shadow-sm"
                      />
                    </button>
                  </template>
                </div>
                <pre
                  v-else
                  class="whitespace-pre-wrap break-words leading-7"
                >{{ turn.prompt }}</pre>
              </div>
            </div>
          </div>

          <div v-if="showProcessLogs && shouldShowProcessCard(turn)" class="flex min-w-0 justify-start">
            <div class="transcript-card transcript-card--process min-w-0 w-full rounded-sm px-4 py-3" :class="getProcessCardClass(turn)">
              <div class="flex items-center justify-between gap-3 text-xs">
                <span class="font-semibold">{{ t('sessionPanel.processTitle') }}</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="shouldShowEventToggle(turn)"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] transition hover:bg-[var(--theme-appPanelStrong)]"
                    :disabled="turn.eventsLoading"
                    @click="toggleTurnEvents(turn)"
                  >
                    <LoaderCircle v-if="shouldShowEventLoading(turn)" class="h-3 w-3 animate-spin" />
                    <ChevronDown v-else-if="isTurnEventsCollapsed(turn)" class="h-3 w-3" />
                    <ChevronUp v-else class="h-3 w-3" />
                    <span>{{ turn.eventsLoading ? t('sessionPanel.loading') : isTurnEventsCollapsed(turn) ? `${t('sessionPanel.expand')} (${getTurnVisibleEventCount(turn)})` : t('sessionPanel.collapse') }}</span>
                  </button>
                  <span>{{ getProcessStatus(turn) }}</span>
                </div>
              </div>
              <div v-if="shouldShowEventLoading(turn)" class="transcript-card__subtle mt-2 rounded-sm bg-[var(--theme-appPanelStrong)] px-3 py-2 text-xs text-current">
                {{ t('sessionPanel.loadingEvents') }}
              </div>
              <div v-else-if="shouldShowLoadedEvents(turn)" class="mt-2 min-w-0 space-y-2">
                <div
                  v-for="item in getVisibleTurnEvents(turn)"
                  :key="item.id"
                  class="transcript-event-card min-w-0 rounded-sm px-3 py-2"
                  :class="getEventCardClass(item)"
                >
                  <div class="text-sm font-medium leading-6">{{ item.title }}</div>
                  <ProcessDetailRenderer
                    v-if="item.detail || (Array.isArray(item.detailBlocks) && item.detailBlocks.length)"
                    :detail="item.detail"
                    :blocks="item.detailBlocks"
                    :kind="item.kind"
                    class="mt-2"
                  />
                </div>
              </div>
              <div
                v-else-if="shouldShowCollapsedEventHint(turn) || shouldShowDeferredEventHint(turn)"
                class="transcript-card__subtle mt-2 rounded-sm bg-[var(--theme-appPanelStrong)] px-3 py-2 text-xs text-current"
              >
                {{ turn.eventsLoaded
                  ? t('sessionPanel.hiddenEventsLoaded', { count: getTurnVisibleEventCount(turn) })
                  : t('sessionPanel.hiddenEventsLoadLater', { count: getTurnVisibleEventCount(turn) }) }}
              </div>
              <p v-else class="mt-2 text-xs text-current">{{ ['queued', 'starting', 'running', 'stopping'].includes(turn.status) ? t('sessionPanel.waitingEvents', { agent: getTurnAgentLabel(turn) }) : t('sessionPanel.noEvents') }}</p>
              <div
                v-if="hasTurnSummary(turn)"
                class="transcript-card__subtle mt-2 rounded-sm bg-[var(--theme-appPanelStrong)] px-3 py-2 text-xs text-current"
              >
                <div v-if="getTurnSummaryStatus(turn)" class="leading-5">
                  {{ getTurnSummaryStatus(turn) }}
                </div>
                <div v-if="getTurnSummaryDetail(turn)" class="mt-1 whitespace-pre-wrap break-words leading-5">
                  {{ getTurnSummaryDetail(turn) }}
                </div>
                <div v-if="getDisplayTurnSummaryItems(turn).length" class="mt-2 flex flex-wrap gap-2">
                  <span
                    v-for="item in getDisplayTurnSummaryItems(turn)"
                    :key="item.key"
                    class="transcript-card__pill inline-flex items-center gap-1 rounded-sm border border-dashed border-[var(--theme-borderDefault)] px-2 py-1"
                  >
                    <span>{{ item.label }}</span>
                    <span class="font-medium">{{ item.value }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="transcript-card transcript-card--response min-w-0 w-full rounded-sm px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'bg-[var(--theme-dangerSoft)] text-[var(--theme-dangerText)]'
                : 'bg-[var(--theme-responseBg)] text-[var(--theme-responseText)]'"
            >
              <div class="flex items-center justify-between gap-3 text-xs opacity-75 font-sans">
                <span class="font-semibold">{{ getTurnResponseTitle(turn) }}</span>
                <div class="flex items-center gap-2">
                  <button
                    v-if="diffSupported && turn.runId"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] transition hover:bg-[var(--theme-appPanelStrong)]"
                    @click="openTurnDiff(turn)"
                  >
                    <FileDiff class="h-3 w-3" />
                    <span>{{ t('sessionPanel.view') }}</span>
                  </button>
                  <button
                    v-if="turn.responseMessage && !turn.errorMessage"
                    type="button"
                    class="transcript-card__toggle inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] transition hover:bg-[var(--theme-appPanelStrong)]"
                    @click="insertTurnResponse(turn)"
                  >
                    <Plus class="h-3 w-3" />
                    <span>{{ t('sessionPanel.insert') }}</span>
                  </button>
                  <span>{{ formatTurnTime(turn.finishedAt || turn.startedAt) }}</span>
                </div>
              </div>
              <div class="relative mt-2">
                <div
                  v-if="turn.errorMessage"
                  class="whitespace-pre-wrap break-words"
                >{{ turn.errorMessage }}</div>
                <div
                  v-else
                  class="prose-like codex-markdown"
                  :data-response-selection-root="'1'"
                  @mouseup="handleResponseMouseUp"
                  @click="copyResponseCode"
                  v-html="renderResponseBody(turn)"
                />
              </div>
            </div>
          </div>
        </div>

        <SelectionInsertButton
          v-if="responseSelectionAction.visible"
          :top="responseSelectionAction.top"
          :left="responseSelectionAction.left"
          :label="t('sourceBrowser.insertSelection')"
          @click="insertSelectedResponseContext"
        />
      </div>

      <div class="pointer-events-none absolute bottom-1 right-1 z-10 flex flex-col items-end gap-1.5 sm:bottom-3 sm:right-3">
        <button
          v-if="hasNewerMessages"
          type="button"
          :class="sending ? 'mb-10 sm:mb-8' : ''"
          class="tool-button pointer-events-auto inline-flex items-center gap-1.5 border-[var(--theme-borderStrong)] bg-[var(--theme-appOverlay)] px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur"
          @click="scrollToBottom"
        >
          <ArrowDown class="h-3.5 w-3.5" />
          <span>{{ t('sessionPanel.jumpToLatest') }}</span>
        </button>
        <button
          v-if="sending"
          type="button"
          class="tool-button tool-button-warning-subtle pointer-events-auto inline-flex items-center gap-1.5 border-[var(--theme-borderStrong)] bg-[var(--theme-appOverlay)] px-2.5 py-1.5 text-[11px] shadow-sm backdrop-blur"
          :disabled="stopping"
          @click="stopSending"
        >
          <LoaderCircle v-if="stopping" class="h-3.5 w-3.5 animate-spin" />
          <CircleStop v-else class="h-3.5 w-3.5" />
          <span>{{ stopping ? t('sessionPanel.stopping') : t('sessionPanel.stop') }}</span>
          <span v-if="!stopping" class="task-loading-dots" aria-hidden="true">
            <span class="task-loading-dots__dot"></span>
            <span class="task-loading-dots__dot"></span>
            <span class="task-loading-dots__dot"></span>
          </span>
        </button>
      </div>
    </div>

    <ImagePreviewOverlay
      v-model="previewPromptImageUrl"
      :images="promptPreviewImages"
    />
  </section>
</template>
