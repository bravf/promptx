<script setup>
import { computed, defineAsyncComponent, inject, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { projectTimelineRows } from '@promptx/protocol/timeline-projection'
import { ArrowDown, ArrowLeft, Bot, CircleAlert, Columns2, FileDiff, Files, Info, LoaderCircle, TerminalSquare, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'
import { createTaskEventSource } from '../lib/taskEventSource.js'
import { isTimelineAtBottom } from '../lib/timelineViewport.js'
import { createTurnTimingMap, groupedTurnTiming, groupTimelineTurns, isTimelineTurnRunning } from '../lib/timelinePresentation.js'
import { useTheme } from '../composables/useTheme.js'
import AgentComposer from './AgentComposer.vue'
const TaskTerminal = defineAsyncComponent(() => import('./TaskTerminal.vue'))
import PxButton from './PxButton.vue'
import PxIconButton from './PxIconButton.vue'
import TimelineTurn from './TimelineTurn.vue'
import TimelineSubagents from './TimelineSubagents.vue'
import { groupBackgroundTasks, sessionActivity } from '../lib/backgroundTaskPresentation.js'
import WorkspaceInspector from './WorkspaceInspector.vue'
import TaskDetailsDrawer from './TaskDetailsDrawer.vue'

const props = defineProps({
  task: { type: Object, default: null },
  project: { type: Object, default: null },
  focused: { type: Boolean, default: false },
  splitEnabled: { type: Boolean, default: false },
  mobile: { type: Boolean, default: false },
  tabbed: { type: Boolean, default: false },
  visible: { type: Boolean, default: true },
})
const emit = defineEmits(['focus', 'back', 'split', 'close', 'agent-event', 'changed', 'open-tab'])

const parentTimelineVisible = inject('timelineVisible', ref(true))
provide('timelineVisible', computed(() => props.visible && parentTimelineVisible.value))
const taskDrafts = new Map()

const { isDark } = useTheme()
const rows = ref([])
const turns = ref([])
const draftContent = ref([])
const displayedTaskId = ref('')
const timelineLoading = ref(false)
const timelineSyncing = ref(false)
const timelineSyncError = ref('')
const sending = ref(false)
const agentControl = ref(null)
const controlLoading = ref(false)
const sendBlockedReason = ref('')
const settingsLoading = ref(false)
const error = ref('')
const timelineEpoch = ref('')
const hasOlderHistory = ref(false)
const loadingOlderHistory = ref(false)
const followingTimeline = ref(true)
const hasNewTimelineItems = ref(false)
const timelineElement = ref(null)
const inspectorDrawer = ref(null)
const drawerMode = ref(null)
const terminalOpen = ref(false)

let eventSource = null
let timelineRequestVersion = 0
let positioningTimeline = false
let markdownScrollFrame = null
let timelineBottomPinTimer = null
let timelineBottomPinVersion = 0
let lastTimelineScrollTop = 0
let inspectorRefreshTimer = null
let timelineWakeSyncAt = 0

const timelineCache = new Map()
const turnReconcilePending = new Set()
const MAX_TIMELINE_CACHE_SIZE = 10
const INITIAL_TIMELINE_LIMIT = 30
const TIMELINE_SYNC_RETRY_DELAY = 500

const activeTaskId = computed(() => props.task?.id || '')
const activity = computed(() => sessionActivity(props.task))
const isRunning = computed(() => props.task?.lifecycle === 'running')
const backgroundGroups = computed(() => groupBackgroundTasks(props.task?.backgroundTasks))
const stoppingTasks = ref(false)
const entries = computed(() => groupTimelineTurns(projectTimelineRows(rows.value)))
const turnTimings = computed(() => createTurnTimingMap(rows.value, turns.value))
const latestTurnId = computed(() => rows.value.findLast((row) => row.turnId)?.turnId || '')
const timelineHasContent = computed(() => displayedTaskId.value === activeTaskId.value && Boolean(timelineEpoch.value || rows.value.length || turns.value.length))
const projectDirectoryName = computed(() => {
  const cwd = String(props.project?.repositoryRoot || '').replace(/[\\/]+$/, '')
  return cwd.split(/[\\/]/).pop() || props.project?.displayName || ''
})

function cacheTimeline(taskId = displayedTaskId.value || activeTaskId.value) {
  if (!taskId || displayedTaskId.value !== taskId || !timelineEpoch.value) return
  const snapshot = {
    rows: [...rows.value],
    turns: [...turns.value],
    epoch: timelineEpoch.value,
    maxSeq: rows.value.at(-1)?.seq || 0,
    hasOlderHistory: hasOlderHistory.value,
  }
  timelineCache.delete(taskId)
  timelineCache.set(taskId, snapshot)
  while (timelineCache.size > MAX_TIMELINE_CACHE_SIZE) timelineCache.delete(timelineCache.keys().next().value)
}

function restoreTimelineCache(taskId) {
  const snapshot = timelineCache.get(taskId)
  if (!snapshot) return false
  timelineCache.delete(taskId)
  timelineCache.set(taskId, snapshot)
  rows.value = [...snapshot.rows]
  turns.value = [...snapshot.turns]
  timelineEpoch.value = snapshot.epoch
  hasOlderHistory.value = snapshot.hasOlderHistory
  displayedTaskId.value = taskId
  return true
}

function resetTimeline() {
  timelineRequestVersion += 1
  releaseTimelineBottomPin()
  positioningTimeline = true
  displayedTaskId.value = ''
  agentControl.value = null
  settingsLoading.value = false
  rows.value = []
  turns.value = []
  draftContent.value = []
  timelineEpoch.value = ''
  hasOlderHistory.value = false
  loadingOlderHistory.value = false
  timelineLoading.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  timelineSyncing.value = false
  timelineSyncError.value = ''
  sending.value = false
  drawerMode.value = null
  closeEvents()
}

function saveTaskDraft(content) {
  const taskId = activeTaskId.value
  if (!taskId) return
  const snapshot = Array.isArray(content) ? content.map((item) => ({ ...item })) : []
  taskDrafts.set(taskId, snapshot)
  draftContent.value = snapshot
}

function upsertTurn(turn) {
  if (!turn?.id) return
  const index = turns.value.findIndex((item) => item.id === turn.id)
  if (index >= 0) turns.value[index] = turn
  else turns.value.unshift(turn)
  cacheTimeline()
}

function processIsRunning(entry) {
  const turnId = (entry.turnIds || [entry.turnId]).includes(latestTurnId.value) ? latestTurnId.value : entry.turnId
  const timing = turnTimings.value.get(turnId)
  return isTimelineTurnRunning({
    agentRunning: isRunning.value || sending.value,
    latestTurnId: latestTurnId.value,
    turnId,
    turnStatus: timing?.status,
  })
}

async function reconcileTerminalTaskTurns(task = props.task) {
  if (!task || task.id !== activeTaskId.value || task.lifecycle === 'running') return
  if (!turns.value.some((turn) => ['queued', 'running'].includes(turn.status))) return
  if (turnReconcilePending.has(task.id)) return
  const requestVersion = timelineRequestVersion
  turnReconcilePending.add(task.id)
  try {
    const result = await v2Api.listTaskTurns(task.id, 1000)
    if (requestVersion === timelineRequestVersion && activeTaskId.value === task.id) {
      turns.value = result.turns
      cacheTimeline(task.id)
    }
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === task.id) error.value = cause.message
  } finally {
    turnReconcilePending.delete(task.id)
  }
}

function applyTaskAgentEvent(agent) {
  if (!agent || agent.taskId !== activeTaskId.value) return
  const wasRunning = isRunning.value || sending.value
  const shouldPinAfterCompletion = wasRunning && agent.lifecycle !== 'running' && followingTimeline.value
  sending.value = agent.lifecycle === 'running'
  emit('agent-event', agent)
  reconcileTerminalTaskTurns({ ...props.task, ...agent, id: agent.taskId })
  if (shouldPinAfterCompletion) {
    pinTimelineToBottom(timelineRequestVersion)
    scrollToBottom({ force: true })
  }
}

async function stopAllTasks() {
  if (stoppingTasks.value) return
  stoppingTasks.value = true
  try { await v2Api.cancelTask(activeTaskId.value, true) }
  catch (cause) { error.value = cause.message || '停止后台任务失败' }
  finally { stoppingTasks.value = false }
}

async function selectTask(taskId) {
  if (!taskId) {
    resetTimeline()
    positioningTimeline = false
    return
  }
  const requestVersion = ++timelineRequestVersion
  releaseTimelineBottomPin()
  positioningTimeline = true
  draftContent.value = taskDrafts.get(taskId)?.map((item) => ({ ...item })) || []
  const hasCachedTimeline = restoreTimelineCache(taskId)
  const cachedTimeline = timelineCache.get(taskId)
  if (!hasCachedTimeline) {
    displayedTaskId.value = ''
    rows.value = []
    turns.value = []
    timelineEpoch.value = ''
    hasOlderHistory.value = false
  }
  timelineLoading.value = !hasCachedTimeline
  timelineSyncing.value = true
  timelineSyncError.value = ''
  error.value = ''
  sendBlockedReason.value = ''
  agentControl.value = null
  settingsLoading.value = false
  loadingOlderHistory.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  closeEvents()
  if (cachedTimeline) openEvents(taskId, cachedTimeline.epoch, cachedTimeline.maxSeq)
  loadTaskControl(taskId, requestVersion)
  try {
    const [result, turnResult] = await Promise.all([
      v2Api.getTaskTimeline(taskId, { limit: INITIAL_TIMELINE_LIMIT, mode: 'presented' }),
      v2Api.listTaskTurns(taskId, 1000),
    ])
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== taskId) return
    rows.value = result.timeline.rows
    turns.value = turnResult.turns
    timelineEpoch.value = result.timeline.epoch
    hasOlderHistory.value = result.timeline.hasOlder
    displayedTaskId.value = taskId
    cacheTimeline(taskId)
    pinTimelineToBottom(requestVersion)
    await scrollToBottom({ force: true })
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== taskId) return
    positioningTimeline = false
    closeEvents()
    openEvents(taskId, result.timeline.epoch, result.timeline.window.maxSeq)
    fillTimelineViewport()
  } catch (cause) {
    if (requestVersion === timelineRequestVersion) {
      timelineSyncError.value = cause.message
      if (!hasCachedTimeline) {
        displayedTaskId.value = ''
        rows.value = []
        turns.value = []
        timelineEpoch.value = ''
        hasOlderHistory.value = false
      }
    }
  } finally {
    if (requestVersion === timelineRequestVersion) {
      positioningTimeline = false
      timelineLoading.value = false
      timelineSyncing.value = false
    }
  }
}

async function loadTaskControl(taskId, requestVersion = timelineRequestVersion) {
  controlLoading.value = true
  try {
    const result = await v2Api.getTaskControl(taskId)
    if (requestVersion === timelineRequestVersion && activeTaskId.value === taskId) agentControl.value = result.control
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === taskId) error.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === taskId) controlLoading.value = false
  }
}

async function loadOlderHistory() {
  const taskId = activeTaskId.value
  const epoch = timelineEpoch.value
  const beforeSeq = rows.value[0]?.seq
  if (!taskId || !epoch || !beforeSeq || !hasOlderHistory.value || loadingOlderHistory.value) return
  const requestVersion = timelineRequestVersion
  let shouldContinueFilling = false
  loadingOlderHistory.value = true
  try {
    const result = await v2Api.getTaskTimeline(taskId, { direction: 'before', cursor: `${epoch}:${beforeSeq}`, limit: 300, mode: 'presented' })
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== taskId) return
    if (result.timeline.reset || result.timeline.epoch !== epoch) {
      await selectTask(taskId)
      return
    }
    const existingSeqs = new Set(rows.value.map((row) => row.seq))
    const olderRows = result.timeline.rows.filter((row) => !existingSeqs.has(row.seq))
    const element = timelineElement.value
    const previousHeight = element?.scrollHeight || 0
    const previousTop = element?.scrollTop || 0
    positioningTimeline = true
    rows.value = [...olderRows, ...rows.value]
    hasOlderHistory.value = result.timeline.hasOlder
    cacheTimeline(taskId)
    await nextTick()
    if (element) {
      element.scrollTop = previousTop + element.scrollHeight - previousHeight
      shouldContinueFilling = olderRows.length > 0 && hasOlderHistory.value && element.scrollHeight <= element.clientHeight
    }
  } catch (cause) {
    if (requestVersion === timelineRequestVersion) error.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion) {
      loadingOlderHistory.value = false
      positioningTimeline = false
      if (shouldContinueFilling) loadOlderHistory()
    }
  }
}

function fillTimelineViewport() {
  const element = timelineElement.value
  if (element && element.scrollHeight <= element.clientHeight) loadOlderHistory()
}

function timelineIsPinnedToBottom() {
  return timelineBottomPinVersion > 0 && timelineBottomPinVersion === timelineRequestVersion
}

function releaseTimelineBottomPin() {
  if (timelineBottomPinTimer) clearTimeout(timelineBottomPinTimer)
  timelineBottomPinTimer = null
  timelineBottomPinVersion = 0
}

function pinTimelineToBottom(requestVersion = timelineRequestVersion) {
  releaseTimelineBottomPin()
  timelineBottomPinVersion = requestVersion
  timelineBottomPinTimer = setTimeout(() => {
    if (timelineBottomPinVersion === requestVersion) releaseTimelineBottomPin()
  }, 3000)
}

function handleTimelineScroll(event) {
  if (!props.visible) return
  const element = event.currentTarget
  const previousScrollTop = lastTimelineScrollTop
  lastTimelineScrollTop = element.scrollTop
  if (positioningTimeline) return
  if (timelineIsPinnedToBottom()) {
    if (element.scrollTop + 1 >= previousScrollTop) return
    releaseTimelineBottomPin()
  }
  const atBottom = isTimelineAtBottom(element)
  followingTimeline.value = atBottom
  if (atBottom) hasNewTimelineItems.value = false
  if (element.scrollTop <= 64) loadOlderHistory()
}

async function syncVisibleTimeline() {
  if (!props.visible || document.visibilityState !== 'visible' || !activeTaskId.value) return
  const now = Date.now()
  if (now - timelineWakeSyncAt < 2_000) return
  timelineWakeSyncAt = now
  const taskId = activeTaskId.value
  const requestVersion = timelineRequestVersion
  timelineSyncing.value = true
  timelineSyncError.value = ''
  try {
    let result
    try {
      result = await v2Api.syncTaskTimeline(taskId)
    } catch (cause) {
      const statusCode = Number(cause?.statusCode || 0)
      const retryable = !statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500
      if (!retryable) throw cause
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_SYNC_RETRY_DELAY))
      if (requestVersion !== timelineRequestVersion || activeTaskId.value !== taskId || document.visibilityState !== 'visible') return
      result = await v2Api.syncTaskTimeline(taskId)
    }
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== taskId) return
    if (result.sync?.status === 'unavailable') timelineSyncError.value = 'Provider 历史记录暂时不可用。'
    else if (result.sync?.status === 'unsupported') timelineSyncError.value = '当前 Provider 不支持历史同步。'
    else timelineSyncError.value = ''
    applyTimelineSyncResult(result.sync, taskId)
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === taskId) timelineSyncError.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === taskId) timelineSyncing.value = false
  }
}

function applyTimelineSyncResult(sync, taskId) {
  if (!sync || activeTaskId.value !== taskId) return
  if (sync.turns) turns.value = sync.turns
  const timeline = sync.timeline
  if (timeline) {
    if (!timelineEpoch.value || timeline.reset || timeline.epoch !== timelineEpoch.value) {
      rows.value = timeline.rows
      hasOlderHistory.value = timeline.hasOlder
    } else {
      const bySeq = new Map(rows.value.map((row) => [row.seq, row]))
      for (const row of timeline.rows) bySeq.set(row.seq, row)
      rows.value = [...bySeq.values()].sort((left, right) => left.seq - right.seq)
      hasOlderHistory.value = Boolean(rows.value.length && rows.value[0].seq > timeline.window.minSeq)
    }
    timelineEpoch.value = timeline.epoch
    displayedTaskId.value = taskId
  }
  cacheTimeline(taskId)
}

function openEvents(taskId, epoch, seq) {
  closeEvents()
  if (!props.visible) return
  eventSource = createTaskEventSource(taskId, epoch ? `${epoch}:${seq || 0}` : '')
  eventSource.addEventListener('timeline', (event) => {
    if (!props.visible || activeTaskId.value !== taskId) return
    const { row } = JSON.parse(event.data)
    if (rows.value.some((item) => item.seq === row.seq)) return
    const shouldFollow = isTimelineAtBottom(timelineElement.value)
    rows.value.push(row)
    cacheTimeline(taskId)
    if (row.item?.type === 'tool_call' && ['completed', 'failed', 'canceled'].includes(row.item.status)) scheduleInspectorRefresh()
    followingTimeline.value = shouldFollow
    if (shouldFollow) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
  eventSource.addEventListener('agent', (event) => applyTaskAgentEvent(JSON.parse(event.data).agent))
  eventSource.addEventListener('turn', (event) => {
    if (activeTaskId.value !== taskId) return
    const turn = JSON.parse(event.data).turn
    upsertTurn(turn)
    if (['completed', 'failed', 'canceled'].includes(turn.status)) scheduleInspectorRefresh()
  })
  eventSource.addEventListener('timeline-synced', (event) => {
    if (activeTaskId.value !== taskId) return
    timelineSyncError.value = ''
    applyTimelineSyncResult(JSON.parse(event.data).sync, taskId)
  })
  eventSource.addEventListener('timeline-sync-warning', (event) => {
    if (activeTaskId.value !== taskId) return
    const { sync } = JSON.parse(event.data)
    timelineSyncError.value = sync?.error || (sync?.status === 'unavailable' ? 'Provider 历史尚未落盘，稍后会再次同步。' : 'Provider 历史确认失败。')
    if (sync?.turn) upsertTurn(sync.turn)
  })
  eventSource.addEventListener('control', (event) => {
    if (activeTaskId.value === taskId) agentControl.value = JSON.parse(event.data).control
  })
  eventSource.addEventListener('reset', (event) => {
    if (activeTaskId.value !== taskId) return
    const { timeline } = JSON.parse(event.data)
    rows.value = timeline.rows
    timelineEpoch.value = timeline.epoch
    hasOlderHistory.value = timeline.hasOlder
    displayedTaskId.value = taskId
    cacheTimeline(taskId)
    if (followingTimeline.value) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
}

function closeEvents() {
  eventSource?.close()
  eventSource = null
}

function scheduleInspectorRefresh() {
  if (!drawerMode.value) return
  if (inspectorRefreshTimer) clearTimeout(inspectorRefreshTimer)
  inspectorRefreshTimer = setTimeout(() => {
    inspectorRefreshTimer = null
    inspectorDrawer.value?.refreshGit({ preserveDiff: true })
  }, 250)
}

async function openProjectPath(target) {
  if (props.tabbed) { emit('open-tab', target); return }
  drawerMode.value = target.intent === 'diff' ? 'diff' : 'files'
  await nextTick()
  inspectorDrawer.value?.openPath(target)
}

function toggleDrawer(mode) {
  if (props.tabbed) { emit('open-tab', { type: mode }); return }
  drawerMode.value = drawerMode.value === mode ? null : mode
}

async function submitPrompt(content) {
  if (!content.length || !activeTaskId.value || isRunning.value) return
  sending.value = true
  error.value = ''
  try {
    const result = await v2Api.startTaskTurn(activeTaskId.value, content, crypto.randomUUID())
    sendBlockedReason.value = ''
    upsertTurn(result.turn)
  } catch (cause) {
    if (cause.code === 'codex_thread_active_writer') sendBlockedReason.value = cause.message
    else error.value = cause.message
    throw cause
  } finally {
    sending.value = false
  }
}

async function updateAgentSettings(input) {
  if (!activeTaskId.value || settingsLoading.value || isRunning.value) return
  settingsLoading.value = true
  error.value = ''
  try {
    const result = await v2Api.updateTaskSettings(activeTaskId.value, input)
    emit('agent-event', result.agent)
    agentControl.value = result.control
  } catch (cause) {
    error.value = cause.message
  } finally {
    settingsLoading.value = false
  }
}

async function scrollToBottom({ force = false, behavior = 'auto' } = {}) {
  await nextTick()
  if (!force && !followingTimeline.value) return
  const element = timelineElement.value
  if (!props.visible) return
  element?.scrollTo({ top: element.scrollHeight, behavior })
  if (element) lastTimelineScrollTop = element.scrollTop
  followingTimeline.value = true
  hasNewTimelineItems.value = false
}

function jumpToLatest() {
  followingTimeline.value = true
  scrollToBottom({ force: true, behavior: 'smooth' })
}

function handleMarkdownRendered() {
  if ((!followingTimeline.value && !timelineIsPinnedToBottom()) || markdownScrollFrame) return
  markdownScrollFrame = requestAnimationFrame(() => {
    markdownScrollFrame = null
    const force = timelineIsPinnedToBottom()
    if (followingTimeline.value || force) scrollToBottom({ force })
  })
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && props.focused && drawerMode.value) drawerMode.value = null
}

watch(activeTaskId, (taskId) => {
  terminalOpen.value = false
  drawerMode.value = null
  if (props.visible) selectTask(taskId)
}, { immediate: true })
watch(() => props.visible, async (visible) => {
  if (!visible) { closeEvents(); releaseTimelineBottomPin(); return }
  if (!timelineEpoch.value) { selectTask(activeTaskId.value); return }
  await nextTick()
  if (timelineElement.value) timelineElement.value.scrollTop = lastTimelineScrollTop
  openEvents(activeTaskId.value, timelineEpoch.value, rows.value.at(-1)?.seq || 0)
  loadTaskControl(activeTaskId.value)
  if (followingTimeline.value) scrollToBottom()
})
watch(() => props.task?.lifecycle, (lifecycle, previous) => {
  if (previous === 'running' && lifecycle !== 'running') reconcileTerminalTaskTurns()
})

onMounted(() => {
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('visibilitychange', syncVisibleTimeline)
})
onBeforeUnmount(() => {
  timelineRequestVersion += 1
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('visibilitychange', syncVisibleTimeline)
  closeEvents()
  if (markdownScrollFrame) cancelAnimationFrame(markdownScrollFrame)
  releaseTimelineBottomPin()
  if (inspectorRefreshTimer) clearTimeout(inspectorRefreshTimer)
})
</script>

<template>
  <section
    class="task-timeline-pane panel relative flex min-h-0 min-w-0 flex-col overflow-hidden"
    :class="{ 'is-focused': focused, 'is-split': splitEnabled }"
    @pointerdown.capture="emit('focus')"
  >
    <header class="timeline-header flex h-14 shrink-0 items-center gap-2 border-b px-3">
      <PxIconButton v-if="mobile" class="h-8 w-8" label="返回项目列表" @click="emit('back')"><ArrowLeft class="h-4 w-4" /></PxIconButton>
      <div v-if="task" class="pane-heading min-w-0 flex-1" :title="task.title">
        <span class="pane-title block truncate text-xs font-medium">{{ task.title }}</span>
        <span class="theme-muted-text block truncate text-[9px]">{{ projectDirectoryName }}</span>
      </div>
      <div v-else class="theme-muted-text min-w-0 flex-1 truncate text-xs">选择会话</div>
      <div class="ml-auto flex shrink-0 items-center gap-1">
        <div v-if="timelineSyncing" class="timeline-sync-status theme-muted-text flex h-8 w-8 items-center justify-center" title="正在同步 Timeline" aria-label="正在同步 Timeline"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /></div>
        <div v-if="task" :title="activity.label" :aria-label="activity.label" class="status-chip flex items-center gap-1.5 px-1 py-1 text-[10px]"><span class="status-dot h-1.5 w-1.5 rounded-full" :class="activity.running ? 'status-dot-running' : ''" /><span class="status-text">{{ activity.label }}</span></div>
        <PxIconButton v-if="task" class="drawer-trigger h-8 w-8" :class="terminalOpen ? 'is-active' : ''" label="终端" :aria-pressed="terminalOpen" @click="tabbed ? emit('open-tab', { type: 'terminal' }) : (terminalOpen = !terminalOpen)"><TerminalSquare class="h-4 w-4" /></PxIconButton>
        <PxIconButton v-if="task" class="drawer-trigger h-8 w-8" :class="drawerMode === 'files' ? 'is-active' : ''" :label="drawerMode === 'files' ? '关闭文件抽屉' : '浏览文件'" :aria-pressed="drawerMode === 'files'" @click="toggleDrawer('files')"><Files class="h-4 w-4" /></PxIconButton>
        <PxIconButton v-if="task" class="drawer-trigger h-8 w-8" :class="drawerMode === 'diff' ? 'is-active' : ''" :label="drawerMode === 'diff' ? '关闭 Diff 抽屉' : '查看 Diff'" :aria-pressed="drawerMode === 'diff'" @click="toggleDrawer('diff')"><FileDiff class="h-4 w-4" /></PxIconButton>
        <PxIconButton v-if="task" class="drawer-trigger h-8 w-8" :class="drawerMode === 'task-details' ? 'is-active' : ''" label="任务详情" :aria-pressed="drawerMode === 'task-details'" @click="toggleDrawer('task-details')"><Info class="h-4 w-4" /></PxIconButton>
        <PxIconButton v-if="!mobile && !tabbed" class="split-trigger h-8 w-8" :label="splitEnabled ? '关闭此窗格' : '拆分 Timeline'" @click="splitEnabled ? emit('close') : emit('split')"><X v-if="splitEnabled" class="h-4 w-4" /><Columns2 v-else class="h-4 w-4" /></PxIconButton>
      </div>
    </header>

    <template v-if="task">
      <div class="relative min-h-0 flex-1">
        <div ref="timelineElement" class="timeline h-full overflow-y-auto" @scroll.passive="handleTimelineScroll">
          <div v-if="timelineSyncError && !timelineHasContent" class="flex h-full items-center justify-center p-8 text-center"><div class="max-w-sm"><p class="error-row rounded-sm border px-3 py-2 text-left text-xs">Timeline 同步失败：{{ timelineSyncError }}</p><PxButton variant="secondary" size="sm" class="mt-3" @click="selectTask(activeTaskId)">重试</PxButton></div></div>
          <div v-else-if="!entries.length" class="flex h-full items-center justify-center p-8 text-center"><div><Bot class="theme-muted-text mx-auto h-8 w-8" /><p class="mt-3 text-sm font-medium">开始一段新的协作</p><p class="theme-muted-text mt-1 text-xs">消息会在当前工作区内执行</p></div></div>
          <div v-else class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <template v-for="entry in entries" :key="entry.key || `${entry.seqStart}-${entry.item?.type || ''}`">
              <TimelineTurn v-if="entry.presentationType === 'turn'" :turn="entry" :timing="groupedTurnTiming(entry, turnTimings)" :running="processIsRunning(entry)" :active-turn-id="latestTurnId" :is-dark="isDark" :workspace-cwd="task.environment?.cwd" :task-id="activeTaskId" @rendered="handleMarkdownRendered" @open-workspace-path="openProjectPath">
                <template #subagents><TimelineSubagents :tasks="entry.turnIds.flatMap(id => backgroundGroups.get(id) || [])" :is-dark="isDark" :workspace-cwd="task.environment?.cwd" :task-id="activeTaskId" :stopping="stoppingTasks" @stop-all="stopAllTasks" @rendered="handleMarkdownRendered" @open-workspace-path="openProjectPath" /></template>
              </TimelineTurn>
              <article v-else-if="entry.item?.type === 'error'" class="error-row mb-5 ml-7 rounded-sm border px-3 py-2 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.message }}</article>
              <article v-else-if="entry.item?.type === 'system_notice'" class="theme-muted-text mb-5 ml-7 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.text }}</article>
            </template>
            <TimelineSubagents :tasks="backgroundGroups.get('') || []" :is-dark="isDark" :workspace-cwd="task.environment?.cwd" :task-id="activeTaskId" :stopping="stoppingTasks" @stop-all="stopAllTasks" @rendered="handleMarkdownRendered" @open-workspace-path="openProjectPath" />
            <div v-if="!isRunning && activity.count" class="theme-muted-text mb-3 ml-7 flex items-center gap-2 text-xs" role="status"><LoaderCircle class="h-3.5 w-3.5 animate-spin" />等待 {{ activity.count }} 个子任务结束</div>
            <div class="timeline-generating-slot ml-7 flex h-8 items-start">
              <div class="timeline-generating-indicator flex items-center gap-1" :class="isRunning || sending ? 'is-visible' : ''" role="status" :aria-hidden="!(isRunning || sending)" :aria-label="isRunning || sending ? '正在生成' : undefined">
                <span class="timeline-generating-dot" aria-hidden="true">.</span><span class="timeline-generating-dot" aria-hidden="true">.</span><span class="timeline-generating-dot" aria-hidden="true">.</span>
              </div>
            </div>
          </div>
          <div v-if="timelineSyncError && timelineHasContent" class="status-float status-float-pill status-float-error timeline-sync-error absolute left-1/2 top-3 z-10 flex -translate-x-1/2 gap-2" role="alert"><CircleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>同步失败</span><PxButton variant="ghost" size="sm" class="font-medium" @click="selectTask(activeTaskId)">重试</PxButton></div>
        </div>
        <div v-if="timelineLoading" class="timeline-loading-overlay absolute inset-0 z-10 flex items-start justify-center pt-16" role="status" aria-label="加载中"><div class="status-float status-float-pill timeline-loading-indicator gap-2"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /><span>加载中</span></div></div>
        <div v-if="loadingOlderHistory" class="status-float status-float-icon pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2" role="status" aria-label="正在加载更早记录"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /></div>
        <PxIconButton v-if="!followingTimeline && timelineHasContent" class="timeline-jump-button absolute bottom-3 left-1/2 z-10 h-9 w-9 -translate-x-1/2 p-0" :class="{ 'is-running': isRunning || sending }" :label="isRunning || sending ? '正在生成，回到底部' : (hasNewTimelineItems ? '有新消息，回到底部' : '回到底部')" @click="jumpToLatest">
          <span v-if="isRunning || sending" class="timeline-jump-loading" aria-hidden="true"><span class="timeline-jump-loading-dot" /><span class="timeline-jump-loading-dot" /><span class="timeline-jump-loading-dot" /></span><ArrowDown v-else class="h-4 w-4" />
        </PxIconButton>
      </div>

      <footer class="composer-wrap shrink-0 p-3 sm:p-4">
        <div v-if="error" class="error-row mx-auto mb-2 max-w-3xl rounded-sm border px-3 py-2 text-xs">{{ error }}</div>
        <div v-if="sendBlockedReason" class="writer-blocked-row mx-auto mb-2 flex max-w-3xl items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs"><span>{{ sendBlockedReason }}</span><PxButton variant="ghost" size="sm" class="shrink-0 font-medium" @click="sendBlockedReason = ''">重新尝试</PxButton></div>
        <AgentComposer :mobile="mobile" :key="activeTaskId" :task-id="task.id" :running="activity.running" :sending="sending" :blocked-reason="sendBlockedReason" :control="agentControl" :control-loading="controlLoading" :settings-loading="settingsLoading" :draft-content="draftContent" :on-submit="submitPrompt" :on-settings-change="updateAgentSettings" @cancel="stopAllTasks" @draft-change="saveTaskDraft" />
      </footer>
      <TaskTerminal v-if="terminalOpen && !drawerMode" :key="task.id" :task-id="task.id" @close="terminalOpen = false" />
    </template>

    <div v-else class="theme-empty-state flex min-h-0 flex-1 flex-col items-center justify-center p-8 text-center">
      <Columns2 v-if="splitEnabled" class="theme-muted-text h-8 w-8" />
      <Bot v-else class="theme-muted-text h-8 w-8" />
      <p class="mt-3 text-sm font-medium">{{ splitEnabled ? '从左栏选择一个会话' : '新建一条会话' }}</p>
      <p v-if="splitEnabled" class="theme-muted-text mt-1 text-xs">所选会话会在此窗格打开</p>
    </div>

    <Transition name="workspace-drawer">
      <WorkspaceInspector v-if="task && ['files', 'diff'].includes(drawerMode)" ref="inspectorDrawer" :task-id="task.id" :workspace-cwd="task.environment?.cwd || project?.repositoryRoot" :is-dark="isDark" :mode="drawerMode" @close="drawerMode = null" />
    </Transition>
    <Transition name="workspace-drawer">
      <TaskDetailsDrawer v-if="task && drawerMode === 'task-details'" :task-id="task.id" @close="drawerMode = null" @changed="emit('changed')" />
    </Transition>
  </section>
</template>

<style scoped>
.task-timeline-pane.panel { border: 0; box-shadow: inset 0 1px 0 var(--theme-panelHighlight); }
.task-timeline-pane.is-split.is-focused .pane-title { color: var(--theme-accent); }
.task-timeline-pane > header, .composer-wrap { border-color: var(--theme-borderDefault); }
.task-timeline-pane :deep(.workspace-inspector), .task-timeline-pane :deep(.task-details-drawer) { bottom: 0; left: 0; position: absolute; right: 0; top: 3.5rem; z-index: 20; }
.timeline-loading-overlay { background: color-mix(in srgb, var(--theme-appPanel) 84%, transparent); }
.status-chip { color: var(--theme-textMuted); }
.status-dot { background: var(--theme-success); }
.status-dot-running { background: var(--theme-warning); }
.timeline { background: var(--theme-appPanel); }
.timeline-jump-button { border: 1px solid var(--theme-borderStrong); background: color-mix(in srgb, var(--theme-appPanelStrong) 66%, var(--theme-appPanelInset) 34%); color: var(--theme-textPrimary); box-shadow: var(--theme-shadowPopover); }
.timeline-jump-button:hover:not(:disabled) { background: var(--theme-buttonHover); color: var(--theme-textPrimary); }
.timeline-jump-button.is-running { color: var(--theme-accentText); }
.timeline-jump-loading { display: inline-flex; align-items: center; justify-content: center; gap: 3px; }
.timeline-jump-loading-dot { width: 4px; height: 4px; border-radius: 9999px; background: currentColor; animation: timeline-jump-loading-pulse 1.1s ease-in-out infinite; }
.timeline-jump-loading-dot:nth-child(2) { animation-delay: 140ms; }
.timeline-jump-loading-dot:nth-child(3) { animation-delay: 280ms; }
@keyframes timeline-jump-loading-pulse { 0%, 60%, 100% { opacity: 0.38; transform: translateY(0); } 30% { opacity: 1; transform: translateY(-1px); } }
.timeline-generating-slot { contain: layout; }
.timeline-generating-indicator { color: var(--theme-textMuted); font-size: 1.25rem; font-weight: 600; line-height: 0.75rem; opacity: 0; transition: opacity 150ms ease; }
.timeline-generating-indicator.is-visible { opacity: 1; }
.timeline-generating-dot { animation: timeline-generating-pulse 1.15s ease-in-out infinite; opacity: 0.28; }
.timeline-generating-dot:nth-child(2) { animation-delay: 160ms; }
.timeline-generating-dot:nth-child(3) { animation-delay: 320ms; }
@keyframes timeline-generating-pulse { 0%, 55%, 100% { opacity: 0.28; } 25% { opacity: 1; } }
.error-row { min-width: 0; overflow-wrap: anywhere; white-space: pre-wrap; border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.writer-blocked-row { border-color: var(--theme-warning); background: var(--theme-warningSoft); color: var(--theme-warningText); }
.drawer-trigger.is-active { background: var(--theme-accentSoft); color: var(--theme-accentText); }
.workspace-drawer-enter-active { transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease; }
.workspace-drawer-leave-active { transition: transform 180ms ease-in, opacity 150ms ease; }
.workspace-drawer-enter-from, .workspace-drawer-leave-to { transform: translateX(100%); opacity: 0.35; }
@media (max-width: 1100px) and (min-width: 721px) {
  .task-timeline-pane.is-split .status-chip, .task-timeline-pane.is-split .timeline-sync-status { display: none; }
  .task-timeline-pane.is-split .timeline-header { padding-left: 0.5rem; padding-right: 0.5rem; }
}
@media (max-width: 720px) {
  .task-timeline-pane { position: absolute; inset: 0; width: 100%; }
  .task-timeline-pane.panel { border-radius: 0; }
  .status-text { display: none; }
}
@media (prefers-reduced-motion: reduce) {
  .workspace-drawer-enter-active, .workspace-drawer-leave-active, .timeline-generating-indicator { transition: none; }
  .timeline-generating-dot, .timeline-jump-loading-dot { animation: none; opacity: 0.72; }
}
</style>
