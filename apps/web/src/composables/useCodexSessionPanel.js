import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import {
  clearTaskCodexRuns,
  createCodexSession,
  createTaskCodexRun,
  deleteCodexSession,
  listCodexSessions,
  listCodexWorkspaces,
  listTaskCodexRuns,
  stopCodexRun,
  updateCodexSession,
} from '../lib/api.js'
import { subscribeServerEvents } from '../lib/serverEvents.js'

const SESSION_REFRESH_TTL = 1500
const SERVER_SYNC_DELAY = 150

function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function sortSessions(items = [], currentSessionId = '') {
  return [...items].sort((left, right) => {
    const runningDiff = Number(Boolean(right?.running)) - Number(Boolean(left?.running))
    if (runningDiff) {
      return runningDiff
    }

    const currentDiff = Number(right?.id === currentSessionId) - Number(left?.id === currentSessionId)
    if (currentDiff) {
      return currentDiff
    }

    const updatedDiff = getDateOrderValue(right.updatedAt) - getDateOrderValue(left.updatedAt)
    if (updatedDiff) {
      return updatedDiff
    }

    return String(left.title || left.cwd || left.id).localeCompare(String(right.title || right.cwd || right.id), 'zh-CN')
  })
}

function formatCommandOutput(output = '', limit = 500) {
  const text = String(output || '').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatTodoItems(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return ''
  }

  return list
    .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text || '未命名任务'}`)
    .join('\n')
}

export function formatCodexEvent(event = {}) {
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (!eventType) {
    return { title: '收到 Codex 事件', detail: '' }
  }

  if (eventType === 'thread.started') {
    return {
      title: 'Codex 线程已创建',
      detail: event.thread_id ? `线程 ID: ${event.thread_id}` : '',
    }
  }

  if (eventType === 'turn.started') {
    return { title: 'Codex 开始执行', detail: '' }
  }

  if (eventType === 'turn.completed') {
    const usage = event.usage
      ? `输入 ${event.usage.input_tokens || 0} / 输出 ${event.usage.output_tokens || 0}`
      : ''
    return {
      title: 'Codex 执行完成',
      detail: usage,
    }
  }

  if (eventType === 'item.started') {
    if (item.type === 'command_execution') {
      return {
        kind: 'command',
        title: '开始执行命令',
        detail: item.command || '',
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `开始处理 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  if (eventType === 'item.updated' && item.type === 'todo_list') {
    return {
      kind: 'todo',
      title: '更新待办列表',
      detail: formatTodoItems(item.items),
    }
  }

  if (eventType === 'item.completed') {
    if (item.type === 'agent_message' && item.text) {
      return {
        kind: 'result',
        title: 'Codex 已返回结果',
        detail: '',
      }
    }

    if (item.type === 'command_execution') {
      const success = item.exit_code === 0 || item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success ? '命令执行完成' : `命令执行失败(exit ${item.exit_code ?? '?'})`,
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '更新待办列表',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `完成 ${item.type || '未知项目'}`,
      detail: '',
    }
  }

  return {
    title: `事件: ${eventType}`,
    detail: '',
  }
}

export function getProcessStatus(turn) {
  if (turn.status === 'running') {
    return '进行中'
  }
  if (turn.status === 'error') {
    return '失败'
  }
  if (turn.status === 'stopped') {
    return '已停止'
  }
  return '已完成'
}

function normalizeLogEntry(entry = {}, nextLogId) {
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) {
      return null
    }
    return {
      id: nextLogId(),
      kind: 'info',
      title: text,
      detail: '',
    }
  }

  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  if (!title && !detail) {
    return null
  }

  return {
    id: nextLogId(),
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
  }
}

function createBaseTurn(run = {}, nextTurnId) {
  return {
    id: nextTurnId(),
    runId: String(run.id || '').trim(),
    prompt: String(run.prompt || '').trim(),
    status: 'completed',
    startedAt: run.startedAt || run.createdAt || '',
    events: [],
    responseMessage: '',
    errorMessage: '',
    lastEventSeq: 0,
  }
}

function appendTurnEvent(turn, entry, nextLogId) {
  const normalized = normalizeLogEntry(entry, nextLogId)
  if (!normalized) {
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
}

export function applyRunPayloadToTurn(turn, payload = {}, nextLogId, mergeSession = () => {}) {
  if (payload.type === 'session') {
    mergeSession(payload.session)
    appendTurnEvent(turn, {
      title: `已连接 PromptX 会话：${payload.session?.title || '未命名会话'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    }, nextLogId)
    return
  }

  if (payload.type === 'session.updated') {
    mergeSession(payload.session)
    appendTurnEvent(turn, {
      title: '会话线程已更新',
      detail: payload.session?.started ? '后续请求会继续复用当前 PromptX 会话。' : '',
    }, nextLogId)
    return
  }

  if (payload.type === 'status') {
    appendTurnEvent(turn, {
      title: payload.message || '状态已更新',
      detail: '',
    }, nextLogId)
    return
  }

  if (payload.type === 'stderr') {
    appendTurnEvent(turn, {
      kind: 'error',
      title: 'stderr',
      detail: payload.text,
    }, nextLogId)
    return
  }

  if (payload.type === 'stdout') {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    }, nextLogId)
    return
  }

  if (payload.type === 'codex') {
    appendTurnEvent(turn, formatCodexEvent(payload.event), nextLogId)
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    return
  }

  if (payload.type === 'completed') {
    appendTurnEvent(turn, {
      kind: 'result',
      title: '本轮执行结束',
      detail: '',
    }, nextLogId)
    if (payload.message) {
      turn.responseMessage = payload.message
    }
    return
  }

  if (payload.type === 'stopped') {
    appendTurnEvent(turn, {
      title: payload.message || '执行已手动停止',
      detail: '',
    }, nextLogId)
    return
  }

  if (payload.type === 'error') {
    appendTurnEvent(turn, {
      kind: 'error',
      title: '执行失败',
      detail: payload.message || 'Codex 执行失败',
    }, nextLogId)
  }
}

export function syncTurnStateFromRun(turn, run = {}) {
  turn.status = run.status || 'completed'
  turn.responseMessage = String(run.responseMessage || turn.responseMessage || '')
  turn.errorMessage = String(run.errorMessage || '')

  if (turn.status === 'completed' && !turn.responseMessage) {
    turn.responseMessage = '本轮 Codex 执行已完成，没有返回额外文本。'
  }

  return turn
}

export function applyRunEventToTurn(turn, event = {}, nextLogId, mergeSession = () => {}) {
  const nextSeq = Math.max(0, Number(event?.seq) || 0)
  if (nextSeq && nextSeq <= Number(turn.lastEventSeq || 0)) {
    return false
  }

  const payload = event?.payload || {}
  applyRunPayloadToTurn(turn, payload, nextLogId, mergeSession)

  if (payload.type === 'completed') {
    turn.status = 'completed'
  } else if (payload.type === 'stopped') {
    turn.status = 'stopped'
    turn.errorMessage = ''
  } else if (payload.type === 'error') {
    turn.status = 'error'
    turn.errorMessage = String(payload.message || turn.errorMessage || 'Codex 执行失败')
  }

  if (nextSeq) {
    turn.lastEventSeq = nextSeq
  }

  return true
}

export function createTurnFromRun(run, nextTurnId, nextLogId, mergeSession) {
  const turn = createBaseTurn(run, nextTurnId)

  ;(run.events || []).forEach((event) => {
    applyRunEventToTurn(turn, event, nextLogId, mergeSession)
  })

  return syncTurnStateFromRun(turn, run)
}

export function useCodexSessionPanel(props, emit) {
  const sessions = ref([])
  const workspaces = ref([])
  const loading = ref(false)
  const managerBusy = ref(false)
  const sending = ref(false)
  const sessionError = ref('')
  const turns = ref([])
  const transcriptRef = ref(null)
  const sendingStartedAt = ref(0)
  const sendingElapsedSeconds = ref(0)
  const showManager = ref(false)
  const currentRunningRunId = ref('')
  const supportsServerEvents = typeof window !== 'undefined' && typeof window.EventSource !== 'undefined'

  let turnId = 0
  let logId = 0
  let sendingTimer = null
  let sessionsLoadPromise = null
  let lastSessionsLoadedAt = 0
  let runsLoadPromise = null
  let runPollTimer = null
  let lastRunFingerprint = ''
  let unsubscribeServerEvents = null
  let serverSyncTimer = null
  let pendingServerSync = {
    sessions: false,
    runs: false,
  }

  const hasPrompt = computed(() => typeof props.buildPrompt === 'function' || Boolean(String(props.prompt || '').trim()))
  const hasSessions = computed(() => sessions.value.length > 0)
  const selectedSessionId = computed({
    get() {
      return String(props.selectedSessionId || '').trim()
    },
    set(value) {
      emit('selected-session-change', String(value || '').trim())
    },
  })
  const sortedSessions = computed(() => sortSessions(sessions.value, selectedSessionId.value))
  const helperText = computed(() => {
    if (!hasSessions.value) {
      return '还没有 PromptX 会话，请先在管理弹窗里新建一个固定工作目录。'
    }
    return ''
  })
  const workingLabel = computed(() => `处理中 (${sendingElapsedSeconds.value}s)`)

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

  function clearRunPollTimer() {
    if (runPollTimer) {
      window.clearInterval(runPollTimer)
      runPollTimer = null
    }
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

  function scheduleScrollToBottom() {
    nextTick(() => {
      if (!transcriptRef.value) {
        return
      }

      const run = () => {
        if (!transcriptRef.value) {
          return
        }
        transcriptRef.value.scrollTop = transcriptRef.value.scrollHeight
      }

      run()
      requestAnimationFrame(() => {
        run()
        requestAnimationFrame(run)
      })
    })
  }

  function scrollToBottom() {
    scheduleScrollToBottom()
  }

  function openManager() {
    showManager.value = true
  }

  function closeManager() {
    showManager.value = false
  }

  function mergeSession(nextSession) {
    if (!nextSession?.id) {
      return
    }

    const nextList = [...sessions.value]
    const index = nextList.findIndex((item) => item.id === nextSession.id)
    if (index >= 0) {
      nextList[index] = nextSession
    } else {
      nextList.unshift(nextSession)
    }
    sessions.value = nextList
  }

  function nextTurnIdValue() {
    turnId += 1
    return turnId
  }

  function nextLogIdValue() {
    logId += 1
    return logId
  }

  function syncRunningStateFromTurns() {
    const runningTurn = [...turns.value].reverse().find((turn) => turn.status === 'running') || null

    currentRunningRunId.value = runningTurn?.runId || ''
    sending.value = Boolean(runningTurn)
    if (runningTurn?.startedAt) {
      const startedAt = Date.parse(String(runningTurn.startedAt || ''))
      sendingStartedAt.value = Number.isFinite(startedAt) ? startedAt : Date.now()
      return
    }

    sendingStartedAt.value = 0
  }

  function applyIncomingRunEvent(runId, event) {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId || !event) {
      return false
    }

    const turnIndex = turns.value.findIndex((turn) => turn.runId === normalizedRunId)
    if (turnIndex < 0) {
      return false
    }

    const turn = turns.value[turnIndex]
    const didApply = applyRunEventToTurn(turn, event, nextLogIdValue, mergeSession)
    if (!didApply) {
      return true
    }

    turns.value = [...turns.value]
    syncRunningStateFromTurns()
    scheduleScrollToBottom()
    return true
  }

  function updatePollingState() {
    clearRunPollTimer()
    if (supportsServerEvents || !props.active || !sending.value || !props.taskSlug) {
      return
    }

    runPollTimer = window.setInterval(() => {
      refreshRunHistory({ force: true }).catch(() => {})
      loadSessions({ force: true }).catch(() => {})
    }, 1200)
  }

  function rebuildTurns(runs = []) {
    const nextSessions = [...sessions.value]
    const mergeRunSession = (session) => {
      if (!session?.id) {
        return
      }

      const index = nextSessions.findIndex((item) => item.id === session.id)
      if (index >= 0) {
        nextSessions[index] = session
      } else {
        nextSessions.unshift(session)
      }
    }

    turnId = 0
    logId = 0
    turns.value = [...(runs || [])]
      .reverse()
      .map((run) => createTurnFromRun(run, nextTurnIdValue, nextLogIdValue, mergeRunSession))
    sessions.value = nextSessions
    syncRunningStateFromTurns()
  }

  async function refreshRunHistory(options = {}) {
    const { force = false } = options
    const taskSlug = String(props.taskSlug || '').trim()
    if (!taskSlug || (!props.active && !force)) {
      return
    }

    if (runsLoadPromise && !force) {
      return runsLoadPromise
    }

    runsLoadPromise = (async () => {
      try {
        const payload = await listTaskCodexRuns(taskSlug, { limit: 20 })
        const items = payload.items || []
        const fingerprint = JSON.stringify(items.map((item) => ({
          id: item.id,
          status: item.status,
          updatedAt: item.updatedAt,
          eventCount: Array.isArray(item.events) ? item.events.length : 0,
        })))
        const shouldScroll = lastRunFingerprint && fingerprint !== lastRunFingerprint

        rebuildTurns(items)
        lastRunFingerprint = fingerprint
        updatePollingState()

        if (shouldScroll) {
          scheduleScrollToBottom()
        }
      } catch (err) {
        sessionError.value = err.message
      } finally {
        runsLoadPromise = null
      }
    })()

    return runsLoadPromise
  }

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
        const [sessionPayload, workspacePayload] = await Promise.all([
          listCodexSessions(),
          listCodexWorkspaces(),
        ])
        const nextSessions = sessionPayload.items || []

        sessions.value = nextSessions
        workspaces.value = workspacePayload.items || []
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

  function upsertWorkspace(cwd = '') {
    const normalized = String(cwd || '').trim()
    if (!normalized || workspaces.value.includes(normalized)) {
      return
    }
    workspaces.value = [normalized, ...workspaces.value]
  }

  function handleSelectSession(sessionId) {
    selectedSessionId.value = String(sessionId || '').trim()
  }

  function refreshSessionsForSelection() {
    loadSessions({ force: true }).catch(() => {})
  }

  function handleServerEvent(event = {}) {
    const eventType = String(event.type || '').trim()
    const eventTaskSlug = String(event.taskSlug || '').trim()
    const currentTaskSlug = String(props.taskSlug || '').trim()

    if (!eventType) {
      return
    }

    if (eventType === 'ready') {
      if (props.active || showManager.value) {
        scheduleServerSync({
          sessions: true,
          runs: Boolean(currentTaskSlug),
        })
      }
      return
    }

    if (eventType === 'sessions.changed') {
      if (props.active || showManager.value) {
        scheduleServerSync({ sessions: true })
      }
      return
    }

    if (eventType === 'runs.changed' && eventTaskSlug && eventTaskSlug === currentTaskSlug) {
      if (props.active) {
        scheduleServerSync({
          sessions: true,
          runs: true,
        })
      }
      return
    }

    if (eventType === 'run.event' && eventTaskSlug && eventTaskSlug === currentTaskSlug && props.active) {
      const applied = applyIncomingRunEvent(event.runId, event.event)
      if (!applied) {
        scheduleServerSync({
          sessions: true,
          runs: true,
        })
      }
    }
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

  async function handleSend() {
    if (!props.taskSlug || !hasPrompt.value || sending.value) {
      return false
    }

    if (!selectedSessionId.value) {
      openManager()
      sessionError.value = '请先选择一个 PromptX 会话。'
      return false
    }

    sessionError.value = ''

    try {
      await loadSessions({ force: true })

      const latestSelectedSession = sessions.value.find((session) => session.id === selectedSessionId.value) || null
      if (!latestSelectedSession) {
        sessionError.value = '当前会话不存在，请重新选择。'
        return false
      }

      if (latestSelectedSession.running) {
        sessionError.value = '当前会话正在执行中，请等待完成后再发送。'
        return false
      }

      const prompt = typeof props.buildPrompt === 'function'
        ? await props.buildPrompt()
        : props.prompt

      if (!String(prompt || '').trim()) {
        sessionError.value = '没有可发送的提示词。'
        return false
      }

      await createTaskCodexRun(props.taskSlug, {
        sessionId: selectedSessionId.value,
        prompt,
      })

      await Promise.all([
        refreshRunHistory({ force: true }),
        loadSessions({ force: true }),
      ])
      scheduleScrollToBottom()
      return true
    } catch (err) {
      sessionError.value = err.message
      return false
    }
  }

  async function stopSending() {
    if (!currentRunningRunId.value) {
      return
    }

    try {
      await stopCodexRun(currentRunningRunId.value)
      await Promise.all([
        refreshRunHistory({ force: true }),
        loadSessions({ force: true }),
      ])
    } catch (err) {
      sessionError.value = err.message
    }
  }

  async function clearTurns() {
    if (!props.taskSlug || sending.value) {
      return
    }

    try {
      await clearTaskCodexRuns(props.taskSlug)
      turns.value = []
      currentRunningRunId.value = ''
      lastRunFingerprint = ''
      scheduleScrollToBottom()
    } catch (err) {
      sessionError.value = err.message
    }
  }

  function formatTurnTime(value = '') {
    if (!value) {
      return ''
    }

    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      return ''
    }

    return date.toLocaleTimeString('zh-CN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
  }

  function getProcessCardClass(turn) {
    if (turn.status === 'error') {
      return 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
    }
    if (turn.status === 'stopped') {
      return 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200'
    }
    if (turn.status === 'completed') {
      return 'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'
    }
    return 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
  }

  function shouldShowResponse(turn) {
    return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
  }

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
      }
      updatePollingState()
      emit('sending-change', value)
    },
    { immediate: true }
  )

  watch(
    () => props.active,
    (active) => {
      if (active) {
        loadSessions({ force: true }).catch(() => {})
        refreshRunHistory({ force: true }).catch(() => {})
        return
      }

      clearServerSyncTimer()
      clearRunPollTimer()
    },
    { immediate: true }
  )

  watch(
    () => props.taskSlug,
    () => {
      turns.value = []
      currentRunningRunId.value = ''
      lastRunFingerprint = ''
      showManager.value = false
      sessionError.value = ''
      if (props.active) {
        refreshRunHistory({ force: true }).catch(() => {})
      }
    },
    { immediate: true }
  )

  onBeforeUnmount(() => {
    clearSendingTimer()
    clearRunPollTimer()
    clearServerSyncTimer()
    unsubscribeServerEvents?.()
  })

  if (typeof window !== 'undefined' && !unsubscribeServerEvents) {
    unsubscribeServerEvents = subscribeServerEvents((event) => {
      handleServerEvent(event)
    })
  }

  return {
    clearTurns,
    closeManager,
    formatTurnTime,
    getProcessCardClass,
    getProcessStatus,
    handleCreateSession,
    handleDeleteSession,
    handleSelectSession,
    handleSend,
    handleUpdateSession,
    helperText,
    loading,
    managerBusy,
    openManager,
    refreshSessionsForSelection,
    selectedSessionId,
    sending,
    sessionError,
    shouldShowResponse,
    showManager,
    sortedSessions,
    stopSending,
    transcriptRef,
    turns,
    workspaces,
    workingLabel,
    sessions,
    loadSessions,
    scrollToBottom,
  }
}
