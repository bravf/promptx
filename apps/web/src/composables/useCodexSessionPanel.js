import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  subscribeTaskRunEvents,
  useWorkbenchRealtime,
} from './useWorkbenchRealtime.js'
import { useCodexRunHistory } from './useCodexRunHistory.js'
import { useCodexSessionActions } from './useCodexSessionActions.js'
import { useTranscriptAutoScroll } from './useTranscriptAutoScroll.js'
import { getCurrentLocale, translate } from './useI18n.js'

const SERVER_SYNC_DELAY = 150
const PROCESS_VISIBILITY_STORAGE_KEY = 'promptx:session-panel:show-process'

export function normalizeStoredProcessVisibility(value) {
  if (value === '0' || value === 'false') {
    return false
  }
  if (value === '1' || value === 'true') {
    return true
  }
  return true
}

export function getStoredProcessVisibility() {
  if (typeof window === 'undefined') {
    return true
  }

  try {
    return normalizeStoredProcessVisibility(window.localStorage.getItem(PROCESS_VISIBILITY_STORAGE_KEY))
  } catch {
    return true
  }
}

export {
  applyRunEventToTurn,
  applyRunEventsPayloadToTurns,
  classifyCodexIssue,
  createTurnFromRun,
  extractCodexEventErrorText,
  findTurnByRunId,
  formatCodexEvent,
  formatCodexIssueMessage,
  formatElapsedDuration,
  getProcessStatus,
  getTurnAgentLabel,
  getTurnSummaryDetail,
  getTurnSummaryItems,
  getTurnSummaryStatus,
  hasTurnSummary,
  isShellTurn,
  sortSessions,
  syncTurnStateFromRun,
} from './codexSessionPanelTurns.js'

import {
  formatElapsedDuration,
  getProcessStatus,
  getTurnAgentLabel,
  getTurnSummaryDetail,
  getTurnSummaryItems,
  getTurnSummaryStatus,
  hasTurnSummary,
} from './codexSessionPanelTurns.js'

export function mergeCodexSessionRecord(currentSession, nextSession, options = {}) {
  const { preserveRunning = false } = options
  if (!nextSession?.id) {
    return currentSession || null
  }

  const mergedSession = {
    ...(currentSession || {}),
    ...nextSession,
  }

  if (
    (!Array.isArray(nextSession?.agentBindings) || !nextSession.agentBindings.length)
    && Array.isArray(currentSession?.agentBindings)
    && currentSession.agentBindings.length
  ) {
    mergedSession.agentBindings = currentSession.agentBindings
  }

  if (preserveRunning) {
    mergedSession.running = Boolean(currentSession?.running)
  }

  return mergedSession
}

export function useCodexSessionPanel(props, emit) {
  const realtime = useWorkbenchRealtime()
  const sessions = ref([])
  const workspaces = ref([])
  const loading = ref(false)
  const managerBusy = ref(false)
  const sending = ref(false)
  const stopping = ref(false)
  const sessionError = ref('')
  const turns = ref([])
  const transcriptRef = ref(null)
  const sendingStartedAt = ref(0)
  const sendingElapsedSeconds = ref(0)
  const showManager = ref(false)
  const currentRunningRunId = ref('')
  const hasNewerMessages = ref(false)
  const showProcessLogs = ref(getStoredProcessVisibility())
  const supportsServerEvents = typeof window !== 'undefined' && typeof window.EventSource !== 'undefined'

  function showToast(payload = '') {
    const normalizedMessage = typeof payload === 'object' && payload !== null
      ? String(payload.message || '').trim()
      : String(payload || '').trim()
    if (!normalizedMessage) {
      return
    }

    emit('toast', typeof payload === 'object' && payload !== null
      ? {
          ...payload,
          message: normalizedMessage,
        }
      : normalizedMessage)
  }

  let sendingTimer = null
  let unsubscribeTaskRunEvents = null
  let serverSyncTimer = null
  let pendingServerSync = {
    sessions: false,
    runs: false,
  }

  const selectedSessionId = computed({
    get() {
      return String(props.selectedSessionId || '').trim()
    },
    set(value) {
      emit('selected-session-change', String(value || '').trim())
    },
  })

  const workingLabel = computed(() => (
    stopping.value
      ? translate('sessionPanel.stopping')
      : `${translate('projectManager.running')} (${formatElapsedDuration(sendingElapsedSeconds.value)})`
  ))
  const currentProjectSession = computed(() => (
    sessions.value.find((session) => session.id === selectedSessionId.value) || null
  ))
  const currentProjectAgentBindings = computed(() => {
    if (Array.isArray(currentProjectSession.value?.agentBindings) && currentProjectSession.value.agentBindings.length) {
      return currentProjectSession.value.agentBindings
    }

    const session = currentProjectSession.value
    if (!session?.id) {
      return []
    }

    return [{
      engine: session.engine,
      sessionRecordId: session.id,
      sessionId: session.sessionId || '',
      started: Boolean(session.started),
      running: Boolean(session.running),
      isDefault: true,
    }]
  })
  const activeAgentEngine = computed({
    get() {
      const remembered = normalizeRememberedAgentEngine(
        props.selectedAgentEngine,
        currentProjectAgentBindings.value
      )
      if (remembered) {
        return remembered
      }

      return currentProjectAgentBindings.value.find((item) => item.isDefault)?.engine
        || currentProjectAgentBindings.value[0]?.engine
        || ''
    },
    set(value) {
      const normalized = normalizeRememberedAgentEngine(value, currentProjectAgentBindings.value)
      if (!normalized) {
        return
      }

      emit('update:selectedAgentEngine', normalized)
    },
  })
  const activeAgentBinding = computed(() => (
    currentProjectAgentBindings.value.find((item) => item.engine === activeAgentEngine.value)
    || currentProjectAgentBindings.value[0]
    || null
  ))

  const {
    beginForceFollowWindow,
    destroy: destroyTranscriptAutoScroll,
    handleTranscriptScroll,
    handleTranscriptTouchEnd,
    handleTranscriptTouchMove,
    handleTranscriptTouchStart,
    resetAutoStickToBottom,
    scheduleScrollToBottom,
    scrollToBottom,
  } = useTranscriptAutoScroll({
    transcriptRef,
    hasNewerMessages,
  })

  function mergeSessionRecord(currentSession, nextSession, options = {}) {
    return mergeCodexSessionRecord(currentSession, nextSession, options)
  }

  function mergeSession(nextSession, options = {}) {
    if (!nextSession?.id) {
      return
    }

    const nextList = [...sessions.value]
    const index = nextList.findIndex((item) => item.id === nextSession.id)
    if (index >= 0) {
      nextList[index] = mergeSessionRecord(nextList[index], nextSession, options)
    } else {
      nextList.unshift(mergeSessionRecord(null, nextSession, options))
    }
    sessions.value = nextList
  }

  const {
    applyCreatedRun,
    applyIncomingRunEvent,
    clearRealtimeReconcileTimer,
    clearRunPollTimer,
    clearTurns,
    loadTurnEvents,
    markFallbackSessionPollNow,
    refreshRunHistory,
    resetRunHistoryState,
    syncRunningStateFromTurns,
    updatePollingState,
  } = useCodexRunHistory({
    props,
    turns,
    sessions,
    sending,
    sendingStartedAt,
    currentRunningRunId,
    sessionError,
    supportsServerEvents,
    scheduleScrollToBottom,
    resetAutoStickToBottom,
    showProcessLogs,
    mergeSessionRecord,
    mergeSession,
    loadSessions: (...args) => loadSessions(...args),
  })

  const {
    closeManager,
    handleCreateSession,
    handleDeleteSession,
    handleResetSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    helperText,
    loadSessions,
    loadSessionResources,
    loadWorkspaces,
    openManager,
    refreshSessionsForSelection,
    sortedSessions,
    stopSending,
  } = useCodexSessionActions({
    props,
    sessions,
    workspaces,
    loading,
    managerBusy,
    sending,
    stopping,
    sessionError,
    showManager,
    selectedSessionId,
    currentRunningRunId,
    supportsServerEvents,
    mergeSession,
    applyCreatedRun,
    refreshRunHistory,
    markFallbackSessionPollNow,
    showToast,
    getActiveAgentBinding: () => activeAgentBinding.value,
  })

  function clearSendingTimer() {
    if (sendingTimer) {
      window.clearInterval(sendingTimer)
      sendingTimer = null
    }
  }

  function startSendingTimer() {
    clearSendingTimer()
    if (!sendingStartedAt.value) {
      sendingStartedAt.value = Date.now()
    }
    sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    sendingTimer = window.setInterval(() => {
      sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
    }, 1000)
  }

  function clearServerSyncTimer() {
    if (serverSyncTimer) {
      window.clearTimeout(serverSyncTimer)
      serverSyncTimer = null
    }
  }

  function flushServerSync() {
    clearServerSyncTimer()

    const nextSync = pendingServerSync
    pendingServerSync = {
      sessions: false,
      runs: false,
    }

    if (nextSync.sessions) {
      loadSessions({ force: true }).catch(() => {})
    }

    if (nextSync.runs) {
      refreshRunHistory({ force: true }).catch(() => {})
    }
  }

  function scheduleServerSync(options = {}) {
    if (typeof window === 'undefined') {
      return
    }

    pendingServerSync = {
      sessions: pendingServerSync.sessions || Boolean(options.sessions),
      runs: pendingServerSync.runs || Boolean(options.runs),
    }

    if (serverSyncTimer || (!pendingServerSync.sessions && !pendingServerSync.runs)) {
      return
    }

    serverSyncTimer = window.setTimeout(() => {
      flushServerSync()
    }, SERVER_SYNC_DELAY)
  }

  function getDisplayTurnSummaryItems(turn) {
    return getTurnSummaryItems(turn, {
      currentRunningRunId: currentRunningRunId.value,
      runningElapsedSeconds: sendingElapsedSeconds.value,
      nowMs: Date.now(),
    })
  }

  function formatTurnTime(value = '') {
    if (!value) {
      return ''
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return ''
    }

    return date.toLocaleTimeString(getCurrentLocale(), {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  function getProcessCardClass(turn) {
    if (turn.status === 'error' || turn.status === 'stop_timeout') {
      return 'theme-process-error'
    }
    if (turn.status === 'interrupted' || turn.status === 'stopped') {
      return 'theme-process-stopped'
    }
    if (turn.status === 'completed') {
      return 'theme-process-completed'
    }
    return 'theme-process-running'
  }

  function toggleProcessLogs() {
    showProcessLogs.value = !showProcessLogs.value
  }

  function shouldShowResponse(turn) {
    return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
  }

  watch(
    showProcessLogs,
    (value) => {
      if (typeof window === 'undefined') {
        return
      }

      try {
        window.localStorage.setItem(PROCESS_VISIBILITY_STORAGE_KEY, value ? 'true' : 'false')
      } catch {
        // ignore storage failures
      }
    },
    { immediate: true }
  )

  watch(
    sending,
    (value) => {
      if (value) {
        if (!sendingStartedAt.value) {
          sendingStartedAt.value = Date.now()
        }
        startSendingTimer()
      } else {
        clearSendingTimer()
        sendingStartedAt.value = 0
        sendingElapsedSeconds.value = 0
        stopping.value = false
      }
      updatePollingState()
      emit('sending-change', value)
    },
    { immediate: true }
  )

  watch(sendingElapsedSeconds, (newVal, oldVal) => {
    if (props.active && oldVal === 0 && newVal > 0) {
      scheduleScrollToBottom()
    }
  })

  watch(
    () => Boolean(props.taskRunning),
    (taskRunning) => {
      if (!props.active || taskRunning || !sending.value) {
        return
      }

      scheduleServerSync({
        sessions: true,
        runs: true,
      })
    }
  )

  watch(
    () => props.active,
    (active) => {
      if (active) {
        loadSessionResources({
          forceSessions: true,
        }).catch(() => {})
        return
      }

      clearServerSyncTimer()
      clearRealtimeReconcileTimer()
      clearRunPollTimer()
    },
    { immediate: true }
  )

  watch(
    () => props.taskSlug,
    () => {
      resetRunHistoryState()
      showManager.value = false
      sessionError.value = ''
      if (props.active) {
        beginForceFollowWindow()
        refreshRunHistory({ force: true, scrollToLatest: true }).catch(() => {})
      }
    },
    { immediate: true }
  )

  watch(
    () => [
      currentProjectSession.value?.id || '',
      currentProjectAgentBindings.value.map((item) => item.engine).join(','),
      props.selectedAgentEngine || '',
    ].join('\n'),
    () => {
      const projectId = String(currentProjectSession.value?.id || '').trim()
      const bindings = currentProjectAgentBindings.value
      const selectedEngine = activeAgentEngine.value
      emit('agent-bindings-change', {
        sessionId: projectId,
        bindings,
        selectedEngine,
      })
      if (!projectId) {
        return
      }

      const normalized = normalizeRememberedAgentEngine(
        props.selectedAgentEngine,
        bindings
      )
      if (normalized) {
        return
      }

      const nextEngine = bindings.find((item) => item.isDefault)?.engine
        || bindings[0]?.engine
        || ''
      if (!nextEngine) {
        return
      }

      emit('update:selectedAgentEngine', nextEngine)
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    clearSendingTimer()
    clearRealtimeReconcileTimer()
    clearRunPollTimer()
    clearServerSyncTimer()
    destroyTranscriptAutoScroll()
    unsubscribeTaskRunEvents?.()
  })

  watch(
    () => realtime.readyVersion.value,
    () => {
      const currentTaskSlug = String(props.taskSlug || '').trim()
      if (!props.active && !showManager.value) {
        return
      }

      if (showManager.value) {
        loadWorkspaces().catch(() => {})
      }

      scheduleServerSync({
        sessions: true,
        runs: Boolean(currentTaskSlug),
      })
    }
  )

  watch(
    () => realtime.sessionsSyncVersion.value,
    () => {
      if (!props.active && !showManager.value) {
        return
      }

      scheduleServerSync({ sessions: true })
    }
  )

  watch(
    () => realtime.getTaskRunSyncVersion(props.taskSlug),
    () => {
      if (!props.active || !props.taskSlug) {
        return
      }

      scheduleServerSync({
        sessions: true,
        runs: true,
      })
    }
  )

  watch(
    () => String(props.taskSlug || '').trim(),
    (taskSlug) => {
      unsubscribeTaskRunEvents?.()
      unsubscribeTaskRunEvents = null

      if (!taskSlug) {
        return
      }

      unsubscribeTaskRunEvents = subscribeTaskRunEvents(taskSlug, ({ runId, event }) => {
        if (!props.active) {
          return
        }

        const applied = applyIncomingRunEvent(runId, event)
        if (!applied) {
          scheduleServerSync({
            sessions: true,
            runs: true,
          })
        }
      })
    },
    { immediate: true }
  )

  return {
    activeAgentBinding,
    activeAgentEngine,
    clearTurns,
    closeManager,
    formatTurnTime,
    getProcessCardClass,
    getProcessStatus,
    getTurnAgentLabel,
    getTurnSummaryDetail,
    getDisplayTurnSummaryItems,
    getTurnSummaryStatus,
    handleCreateSession,
    handleDeleteSession,
    handleResetSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    loadTurnEvents,
    hasTurnSummary,
    helperText,
    loading,
    managerBusy,
    openManager,
    refreshSessionsForSelection,
    selectedSessionId,
    sending,
    showProcessLogs,
    stopping,
    sessionError,
    shouldShowResponse,
    showManager,
    sortedSessions,
    stopSending,
    toggleProcessLogs,
    hasNewerMessages,
    transcriptRef,
    turns,
    workspaces,
    workingLabel,
    sessions,
    loadSessions,
    currentProjectAgentBindings,
    handleTranscriptScroll,
    handleTranscriptTouchEnd,
    handleTranscriptTouchMove,
    handleTranscriptTouchStart,
    scheduleScrollToBottom,
    scrollToBottom,
  }
}

function normalizeRememberedAgentEngine(value = '', bindings = []) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return ''
  }

  return bindings.some((item) => item.engine === normalized) ? normalized : ''
}
