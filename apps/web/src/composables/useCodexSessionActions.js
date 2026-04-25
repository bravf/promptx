import { computed } from 'vue'
import { extractShellCommandIntent } from '../../../../packages/shared/src/index.js'
import {
  createCodexSession,
  createTaskCodexRun,
  deleteCodexSession,
  listCodexSessions,
  listCodexWorkspaces,
  resetCodexSession,
  stopCodexRun,
  updateCodexSession,
} from '../lib/api.js'
import { translate } from './useI18n.js'
import { sortSessions } from './codexSessionPanelTurns.js'

const SESSION_REFRESH_TTL = 1500
const WORKSPACE_REFRESH_TTL = 30000

export function useCodexSessionActions(options = {}) {
  const {
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
    getActiveAgentBinding = null,
  } = options

  let sessionsLoadPromise = null
  let workspacesLoadPromise = null
  let lastSessionsLoadedAt = 0
  let lastWorkspacesLoadedAt = 0

  const hasPrompt = computed(() => typeof props.buildPrompt === 'function' || Boolean(String(props.prompt || '').trim()))
  const hasSessions = computed(() => sessions.value.length > 0)
  const sortedSessions = computed(() => sortSessions(sessions.value, selectedSessionId.value))
  const helperText = computed(() => {
    if (!hasSessions.value) {
      return translate('projectManager.noProjects')
    }
    return ''
  })

  async function loadSessions(options = {}) {
    const { force = false } = options

    if (sessionsLoadPromise) {
      return sessionsLoadPromise
    }

    const now = Date.now()
    if (!force && lastSessionsLoadedAt && now - lastSessionsLoadedAt < SESSION_REFRESH_TTL) {
      return {
        items: sessions.value,
        workspaces: workspaces.value,
      }
    }

    sessionsLoadPromise = (async () => {
      loading.value = true
      sessionError.value = ''

      try {
        const sessionPayload = await listCodexSessions()
        const nextSessions = sessionPayload.items || []

        sessions.value = nextSessions
        lastSessionsLoadedAt = Date.now()

        return {
          items: nextSessions,
          workspaces: workspaces.value,
        }
      } catch (err) {
        sessionError.value = err.message
        throw err
      } finally {
        loading.value = false
        sessionsLoadPromise = null
      }
    })()

    return sessionsLoadPromise
  }

  async function loadWorkspaces(options = {}) {
    const { force = false } = options

    if (workspacesLoadPromise) {
      return workspacesLoadPromise
    }

    const now = Date.now()
    if (!force && lastWorkspacesLoadedAt && now - lastWorkspacesLoadedAt < WORKSPACE_REFRESH_TTL) {
      return {
        items: workspaces.value,
      }
    }

    workspacesLoadPromise = (async () => {
      try {
        const workspacePayload = await listCodexWorkspaces()
        workspaces.value = workspacePayload.items || []
        lastWorkspacesLoadedAt = Date.now()
        return {
          items: workspaces.value,
        }
      } finally {
        workspacesLoadPromise = null
      }
    })()

    return workspacesLoadPromise
  }

  async function loadSessionResources(options = {}) {
    const { forceSessions = false, forceWorkspaces = false } = options
    const [sessionPayload, workspacePayload] = await Promise.all([
      loadSessions({ force: forceSessions }),
      loadWorkspaces({ force: forceWorkspaces }),
    ])

    return {
      items: sessionPayload?.items || sessions.value,
      workspaces: workspacePayload?.items || workspaces.value,
    }
  }

  function upsertWorkspace(cwd = '') {
    const normalized = String(cwd || '').trim()
    if (!normalized || workspaces.value.includes(normalized)) {
      return
    }
    workspaces.value = [normalized, ...workspaces.value]
  }

  function openManager() {
    showManager.value = true
    loadWorkspaces().catch(() => {})
  }

  function closeManager() {
    showManager.value = false
  }

  function handleSelectSession(sessionId) {
    const normalizedSessionId = String(sessionId || '').trim()
    if (
      props.sessionSelectionLocked
      && normalizedSessionId
      && normalizedSessionId !== selectedSessionId.value
    ) {
      sessionError.value = props.sessionSelectionLockReason || translate('taskActions.sessionLocked')
      return
    }

    selectedSessionId.value = normalizedSessionId
  }

  function refreshSessionsForSelection() {
    loadSessionResources({
      forceSessions: true,
      forceWorkspaces: true,
    }).catch(() => {})
  }

  async function handleCreateSession(payload) {
    managerBusy.value = true
    sessionError.value = ''

    try {
      const session = await createCodexSession(payload)
      mergeSession(session)
      upsertWorkspace(session.cwd)
      selectedSessionId.value = session.id
      return session
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleUpdateSession(sessionId, payload) {
    managerBusy.value = true
    sessionError.value = ''

    try {
      const session = await updateCodexSession(sessionId, payload)
      mergeSession(session)
      upsertWorkspace(session.cwd)
      return session
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleDeleteSession(sessionId) {
    const targetId = String(sessionId || '').trim()
    if (!targetId) {
      return {
        deletedSessionId: '',
        selectedSessionId: selectedSessionId.value,
      }
    }

    managerBusy.value = true
    sessionError.value = ''

    try {
      await deleteCodexSession(targetId)
      const remainingSessions = sessions.value.filter((session) => session.id !== targetId)
      sessions.value = remainingSessions

      let nextSelectedSessionId = selectedSessionId.value
      if (selectedSessionId.value === targetId) {
        nextSelectedSessionId = sortSessions(remainingSessions, '')[0]?.id || ''
        selectedSessionId.value = nextSelectedSessionId
      }

      return {
        deletedSessionId: targetId,
        selectedSessionId: nextSelectedSessionId,
      }
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleResetSession(sessionId) {
    const targetId = String(sessionId || '').trim()
    if (!targetId) {
      return null
    }

    managerBusy.value = true
    sessionError.value = ''

    try {
      const result = await resetCodexSession(targetId)
      if (result?.session) {
        mergeSession(result.session)
      }
      markFallbackSessionPollNow()
      await Promise.all([
        refreshRunHistory({ force: true }),
        loadSessions({ force: true }),
      ])
      showToast?.({
        message: translate('projectManager.sessionReset'),
        type: 'success',
      })
      return result
    } catch (err) {
      sessionError.value = err.message
      throw err
    } finally {
      managerBusy.value = false
    }
  }

  async function handleSend() {
    if (!props.taskSlug || !hasPrompt.value || sending.value || stopping.value) {
      return false
    }

    if (!selectedSessionId.value) {
      const message = translate('projectManager.selectProject')
      sessionError.value = message
      showToast?.({
        message,
        type: 'warning',
      })
      return false
    }

    sessionError.value = ''

    try {
      await loadSessionResources({
        forceSessions: true,
      })

      const latestSelectedSession = sessions.value.find((session) => session.id === selectedSessionId.value) || null
      if (!latestSelectedSession) {
        sessionError.value = translate('projectManager.projectMissing')
        return false
      }

      if (latestSelectedSession.running) {
        sessionError.value = translate('sessionTurns.currentProjectRunning')
        return false
      }

      const prompt = typeof props.buildPrompt === 'function'
        ? await props.buildPrompt()
        : props.prompt
      const promptBlocks = typeof props.buildPromptBlocks === 'function'
        ? await props.buildPromptBlocks()
        : []
      const shellIntent = extractShellCommandIntent({
        prompt,
        promptBlocks,
      })

      if (shellIntent.reason) {
        const shellIntentReason = shellIntent.reason === 'unsupported_blocks'
          ? translate('sessionPanel.shellUnsupportedBlocks')
          : translate('sessionPanel.shellEmptyCommand')
        sessionError.value = shellIntentReason
        showToast?.({
          message: shellIntentReason,
          type: 'warning',
        })
        return false
      }

      if (!String(prompt || '').trim()) {
        sessionError.value = translate('sessionTurns.noPromptToSend')
        return false
      }

      const projectAgentBindings = getProjectAgentBindings(latestSelectedSession)
      const currentBinding = typeof getActiveAgentBinding === 'function'
        ? getActiveAgentBinding(latestSelectedSession)
        : null
      const currentEngine = String(currentBinding?.engine || '').trim()
      if (currentEngine && !projectAgentBindings.some((item) => item.engine === currentEngine)) {
        const message = translate('sessionPanel.agentNotEnabled')
        sessionError.value = message
        showToast?.({ message, type: 'warning' })
        return false
      }

      const nextBinding = currentBinding
      const targetSessionId = String(
        shellIntent.mode === 'shell'
          ? selectedSessionId.value
          : (nextBinding?.sessionRecordId || selectedSessionId.value)
      ).trim()
      const result = await createTaskCodexRun(props.taskSlug, {
        projectSessionId: selectedSessionId.value,
        sessionId: targetSessionId,
        displayEngine: currentEngine,
        prompt: shellIntent.mode === 'shell' ? shellIntent.prompt : prompt,
        promptBlocks,
        commandMode: shellIntent.mode,
        command: shellIntent.command,
      })
      applyCreatedRun(result)
      if (typeof props.afterSend === 'function') {
        Promise.resolve(props.afterSend()).catch((err) => {
          console.error('[promptx] afterSend failed', err)
        })
      }

      if (!supportsServerEvents) {
        markFallbackSessionPollNow()
        Promise.all([
          refreshRunHistory({ force: true }),
          loadSessions({ force: true }),
        ]).catch((err) => {
          sessionError.value = err.message
        })
      }
      return true
    } catch (err) {
      sessionError.value = err.message
      return false
    }
  }

  async function stopSending() {
    if (!currentRunningRunId.value || stopping.value) {
      return
    }

    try {
      stopping.value = true
      await stopCodexRun(currentRunningRunId.value)
      if (!supportsServerEvents) {
        markFallbackSessionPollNow()
        await Promise.all([
          refreshRunHistory({ force: true }),
          loadSessions({ force: true }),
        ])
      }
    } catch (err) {
      stopping.value = false
      sessionError.value = err.message
    }
  }

  return {
    closeManager,
    handleCreateSession,
    handleDeleteSession,
    handleResetSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    hasPrompt,
    helperText,
    loadSessions,
    loadSessionResources,
    loadWorkspaces,
    openManager,
    refreshSessionsForSelection,
    sortedSessions,
    stopSending,
  }
}

function getProjectAgentBindings(session = {}) {
  if (Array.isArray(session?.agentBindings) && session.agentBindings.length) {
    return session.agentBindings
  }

  if (!session?.id) {
    return []
  }

  return [{
    engine: normalizeActionAgentEngine(session.engine),
    sessionRecordId: session.id,
    sessionId: session.sessionId || '',
    isDefault: true,
    running: Boolean(session.running),
    started: Boolean(session.started),
  }]
}

function normalizeActionAgentEngine(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (normalized === 'claude' || normalized === 'claudecode') {
    return 'claude-code'
  }
  if (normalized === 'opencode' || normalized === 'open-code') {
    return 'opencode'
  }
  if (normalized === 'kimi' || normalized === 'kimicode' || normalized === 'kimi-code') {
    return 'kimi-code'
  }
  if (normalized === 'claude-code') {
    return 'claude-code'
  }
  return 'codex'
}
