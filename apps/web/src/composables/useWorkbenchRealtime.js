import { reactive, ref } from 'vue'
import { subscribeServerEvents } from '../lib/serverEvents.js'

const readyVersion = ref(0)
const listSyncVersion = ref(0)
const listSyncTaskSlug = ref('')
const listSyncReason = ref('')
const sessionsSyncVersion = ref(0)
const taskRunSyncVersionMap = reactive({})
const taskDiffSyncVersionMap = reactive({})
const taskRunChangeMap = reactive({})
const runEventListenersByTaskSlug = new Map()

let started = false
let unsubscribeServerEvents = null

const TASK_LIST_SYNC_REASONS = new Set([
  'created',
  'updated',
  'deleted',
  'reordered',
  'session-linked',
  'session-cleared',
])

const TERMINAL_RUN_STATUSES = new Set([
  'completed',
  'error',
  'stopped',
  'interrupted',
  'stop_timeout',
  'failed',
  'cancelled',
  'timeout',
])

function bumpVersion(versionMap, taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return
  }

  versionMap[normalizedTaskSlug] = Math.max(0, Number(versionMap[normalizedTaskSlug]) || 0) + 1
}

export function getRealtimeEventSyncFlags(event = {}) {
  const eventType = String(event.type || '').trim()
  const reason = String(event.reason || '').trim()

  return {
    updatesTaskList: eventType === 'runs.changed'
      || (eventType === 'tasks.changed' && TASK_LIST_SYNC_REASONS.has(reason)),
    updatesSessions: eventType === 'ready' || eventType === 'runs.changed' || eventType === 'sessions.changed',
    updatesTaskRuns: eventType === 'runs.changed',
    updatesTaskDiff: eventType === 'runs.changed' || (eventType === 'tasks.changed' && (reason === 'session-linked' || reason === 'session-cleared')),
  }
}

function isRepeatedTerminalRunChange(previousChange = null, nextChange = null) {
  const previousRunId = String(previousChange?.runId || '').trim()
  const previousStatus = String(previousChange?.status || '').trim()
  const nextRunId = String(nextChange?.runId || '').trim()
  const nextStatus = String(nextChange?.status || '').trim()

  if (!previousRunId || !nextRunId || previousRunId !== nextRunId) {
    return false
  }

  if (!previousStatus || previousStatus !== nextStatus) {
    return false
  }

  return TERMINAL_RUN_STATUSES.has(nextStatus)
}

function dispatchTaskRunEvent(taskSlug = '', payload = {}) {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return
  }

  const listeners = runEventListenersByTaskSlug.get(normalizedTaskSlug)
  if (!listeners?.size) {
    return
  }

  listeners.forEach((listener) => {
    try {
      listener(payload)
    } catch {
      // Ignore listener failures to avoid breaking the shared realtime dispatcher.
    }
  })
}

function handleServerEvent(event = {}) {
  const eventType = String(event.type || '').trim()
  const taskSlug = String(event.taskSlug || '').trim()
  const syncFlags = getRealtimeEventSyncFlags(event)

  if (!eventType) {
    return
  }

  if (eventType === 'ready') {
    readyVersion.value += 1
    listSyncTaskSlug.value = ''
    listSyncReason.value = ''
    sessionsSyncVersion.value += 1
    return
  }

  if (eventType === 'tasks.changed') {
    listSyncTaskSlug.value = taskSlug
    listSyncReason.value = String(event.reason || '').trim()
    if (syncFlags.updatesTaskList) {
      listSyncVersion.value += 1
    }
    if (syncFlags.updatesTaskDiff) {
      bumpVersion(taskDiffSyncVersionMap, taskSlug)
    }
    return
  }

  if (eventType === 'runs.changed') {
    listSyncTaskSlug.value = taskSlug
    listSyncReason.value = ''
    const nextRunChange = {
      runId: String(event.runId || '').trim(),
      status: String(event.status || '').trim(),
      sentAt: String(event.sentAt || '').trim(),
    }
    const previousRunChange = taskSlug ? taskRunChangeMap[taskSlug] || null : null
    const skipListAndDiffRefresh = isRepeatedTerminalRunChange(previousRunChange, nextRunChange)
    if (taskSlug) {
      taskRunChangeMap[taskSlug] = nextRunChange
    }
    if (syncFlags.updatesTaskList && !skipListAndDiffRefresh) {
      listSyncVersion.value += 1
    }
    if (syncFlags.updatesSessions) {
      sessionsSyncVersion.value += 1
    }
    if (syncFlags.updatesTaskRuns) {
      bumpVersion(taskRunSyncVersionMap, taskSlug)
    }
    if (syncFlags.updatesTaskDiff && !skipListAndDiffRefresh) {
      bumpVersion(taskDiffSyncVersionMap, taskSlug)
    }
    return
  }

  if (eventType === 'sessions.changed') {
    listSyncReason.value = ''
    if (syncFlags.updatesSessions) {
      sessionsSyncVersion.value += 1
    }
    return
  }

  if (eventType === 'run.event') {
    dispatchTaskRunEvent(taskSlug, {
      taskSlug,
      runId: String(event.runId || '').trim(),
      event: event.event || null,
    })
  }
}

function ensureWorkbenchRealtimeStarted() {
  if (started || typeof window === 'undefined') {
    return
  }

  unsubscribeServerEvents = subscribeServerEvents((event) => {
    handleServerEvent(event)
  })
  started = true
}

export function getTaskRunSyncVersion(taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return 0
  }

  return Math.max(0, Number(taskRunSyncVersionMap[normalizedTaskSlug]) || 0)
}

export function getTaskDiffSyncVersion(taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return 0
  }

  return Math.max(0, Number(taskDiffSyncVersionMap[normalizedTaskSlug]) || 0)
}

export function getTaskRunChange(taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return null
  }

  return taskRunChangeMap[normalizedTaskSlug] || null
}

export function subscribeTaskRunEvents(taskSlug = '', listener) {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug || typeof listener !== 'function') {
    return () => {}
  }

  ensureWorkbenchRealtimeStarted()

  const listeners = runEventListenersByTaskSlug.get(normalizedTaskSlug) || new Set()
  listeners.add(listener)
  runEventListenersByTaskSlug.set(normalizedTaskSlug, listeners)

  return () => {
    const currentListeners = runEventListenersByTaskSlug.get(normalizedTaskSlug)
    if (!currentListeners) {
      return
    }

    currentListeners.delete(listener)
    if (!currentListeners.size) {
      runEventListenersByTaskSlug.delete(normalizedTaskSlug)
    }
  }
}

export function useWorkbenchRealtime() {
  ensureWorkbenchRealtimeStarted()

  return {
    readyVersion,
    listSyncVersion,
    listSyncTaskSlug,
    listSyncReason,
    sessionsSyncVersion,
    getTaskRunSyncVersion,
    getTaskRunChange,
    getTaskDiffSyncVersion,
  }
}
