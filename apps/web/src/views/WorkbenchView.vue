<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { projectTimelineRows } from '@promptx/protocol/timeline-projection'
import { Archive, ArrowDown, ArrowLeft, Bot, CircleAlert, FileDiff, Files, Folder, FolderOpen, Info, LoaderCircle, Pencil, Pin, PinOff, Plus, Settings, TerminalSquare, X } from 'lucide-vue-next'
import { v2Api, taskEventsUrl, globalEventsUrl } from '../lib/v2Api.js'
import { createEventSource } from '../lib/eventSource.js'
import { createMobileDialogHistoryState, getMobileDialogHistoryState } from '../lib/mobileDialogHistory.js'
import { createMobileTimelineHistoryState, hasMobileTimelineHistoryState } from '../lib/mobileTimelineHistory.js'
import { isTimelineAtBottom } from '../lib/timelineViewport.js'
import { createTurnTimingMap, groupTimelineTurns, isTimelineTurnRunning } from '../lib/timelinePresentation.js'
import { useTheme } from '../composables/useTheme.js'
import AgentComposer from '../components/AgentComposer.vue'
import DirectorySearchInput from '../components/DirectorySearchInput.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import PxAlert from '../components/PxAlert.vue'
import PxActionMenu from '../components/PxActionMenu.vue'
import PxButton from '../components/PxButton.vue'
import PxDialog from '../components/PxDialog.vue'
import PxField from '../components/PxField.vue'
import PxIconButton from '../components/PxIconButton.vue'
import PxSelect from '../components/PxSelect.vue'
import SessionTitleMarquee from '../components/SessionTitleMarquee.vue'
import TimelineTurn from '../components/TimelineTurn.vue'
import V2SettingsDialog from '../components/V2SettingsDialog.vue'
import WorkspaceInspector from '../components/WorkspaceInspector.vue'
import TaskDetailsDrawer from '../components/TaskDetailsDrawer.vue'

const { isDark } = useTheme()
const projects = ref([])
const providers = ref([])
const tasksByProject = ref({})
const expandedProjectIds = ref(new Set())
const rows = ref([])
const turns = ref([])
const draftContent = ref([])
const activeProjectId = ref('')
const activeTaskId = ref('')
const displayedTaskId = ref('')
const loading = ref(true)
const timelineLoading = ref(false)
const timelineSyncing = ref(false)
const timelineSyncError = ref('')
const sending = ref(false)
const agentControl = ref(null)
const sendBlockedReason = ref('')
const settingsLoading = ref(false)
const error = ref('')
const dialog = ref('')
const importSessions = ref([])
const importProviderFilter = ref('')
const importQuery = ref('')
const importLoading = ref(false)
const importError = ref('')
const importingId = ref('')
const timelineEpoch = ref('')
const hasOlderHistory = ref(false)
const loadingOlderHistory = ref(false)
const followingTimeline = ref(true)
const hasNewTimelineItems = ref(false)
const projectPath = ref('')
const projectPathInput = ref(null)
const directorySuggestions = ref([])
const directorySearchLoading = ref(false)
const directoryPicking = ref(false)
const directorySearchError = ref('')
const directorySuggestionsOpen = ref(false)
const selectedDirectoryIndex = ref(-1)
const taskProvider = ref('codex')
const taskTitle = ref('')
const executionKind = ref('local')
const taskBaseRef = ref('HEAD')
const taskBranchName = ref('')
const taskSlug = ref('')
const creating = ref(false)
const conversationError = ref('')
const renamingTaskId = ref('')
const taskRenameDraft = ref('')
const taskRenameSaving = ref(false)
let taskRenameInput = null
const providerOptions = computed(() => providers.value.map((provider) => ({ value: provider.id, label: provider.label })))
const executionOptions = [
  { value: 'worktree', label: '新建 Worktree' },
  { value: 'local', label: '当前目录' },
]
const baseRefOptions = [
  { value: 'HEAD', label: 'HEAD（当前提交）' },
  { value: 'origin/main', label: 'origin/main' },
  { value: 'origin/master', label: 'origin/master' },
  { value: 'main', label: 'main' },
  { value: 'master', label: 'master' },
]
const confirmation = ref({ open: false, title: '', description: '', confirmText: '', danger: false, resolve: null })
const timelineElement = ref(null)
const filesDrawer = ref(null)
const diffDrawer = ref(null)
const drawerMode = ref(null)
const mobileView = ref('sidebar')
const isMobile = ref(false)
let eventSource = null
let globalEventSource = null
let mobileMediaQuery = null
const attentionClearPending = new Set()
const turnReconcilePending = new Set()
let timelineRequestVersion = 0
let positioningTimeline = false
const timelineCache = new Map()
const draftsByTask = new Map()
const MAX_TIMELINE_CACHE_SIZE = 10
const INITIAL_TIMELINE_LIMIT = 30
let directorySearchTimer = null
let directorySearchController = null
let markdownScrollFrame = null
let timelineBottomPinTimer = null
let timelineBottomPinVersion = 0
let lastTimelineScrollTop = 0
let inspectorRefreshTimer = null
let timelineWakeSyncAt = 0
let importSearchTimer = null
let importSearchController = null
let dialogUsesHistory = false
let dialogHistoryClosePromise = null
let resolveDialogHistoryClose = null

const TIMELINE_SYNC_RETRY_DELAY = 500

const activeProject = computed(() => projects.value.find((item) => item.id === activeProjectId.value))
const activeProjectDirectoryName = computed(() => {
  const cwd = String(activeProject.value?.repositoryRoot || '').replace(/[\\/]+$/, '')
  return cwd.split(/[\\/]/).pop() || activeProject.value?.displayName || ''
})
const tasks = computed(() => tasksForProject(activeProjectId.value))
const activeTask = computed(() => tasks.value.find((item) => item.id === activeTaskId.value))
const isRunning = computed(() => activeTask.value?.lifecycle === 'running')
const entries = computed(() => groupTimelineTurns(projectTimelineRows(rows.value)))
const turnTimings = computed(() => createTurnTimingMap(rows.value, turns.value))
const latestTurnId = computed(() => rows.value.findLast((row) => row.turnId)?.turnId || '')
const timelineHasContent = computed(() => displayedTaskId.value === activeTaskId.value && Boolean(timelineEpoch.value || rows.value.length || turns.value.length))

function taskView(task, projectId = task?.projectId) {
  if (!task?.agent) return null
  return {
    ...task.agent,
    id: task.id,
    taskId: task.id,
    agentSessionId: task.agent.id,
    projectId,
    taskLifecycle: task.lifecycle,
    pinnedAt: task.pinnedAt,
    environment: task.environment,
  }
}

function tasksForProject(projectId) {
  return tasksByProject.value[projectId] || []
}

function setProjectTasks(projectId, nextTasks) {
  tasksByProject.value = { ...tasksByProject.value, [projectId]: nextTasks }
}

function upsertTaskAgent(agent) {
  if (!agent?.taskId || !agent.projectId) return null
  const projectTasks = tasksForProject(agent.projectId)
  const index = projectTasks.findIndex((item) => item.id === agent.taskId)
  const current = index >= 0 ? projectTasks[index] : null
  const nextTask = { ...current, ...agent, id: agent.taskId, taskId: agent.taskId, agentSessionId: agent.id, projectId: agent.projectId }
  const nextTasks = [...projectTasks]
  if (index >= 0) nextTasks[index] = nextTask
  else nextTasks.unshift(nextTask)
  setProjectTasks(agent.projectId, nextTasks)
  return nextTask
}

function setProjectExpanded(projectId, expanded = true) {
  const next = new Set(expandedProjectIds.value)
  if (expanded) next.add(projectId)
  else next.delete(projectId)
  expandedProjectIds.value = next
}

function toggleProject(projectId) {
  setProjectExpanded(projectId, !expandedProjectIds.value.has(projectId))
}

function handleProjectRowClick(project) {
  toggleProject(project.id)
}

function providerLabel(providerId) {
  return providers.value.find((provider) => provider.id === providerId)?.label || providerId
}

function projectMenuItems(project) {
  return [
    { id: 'new', label: '新建会话', icon: Plus },
    { id: 'pin', label: project.pinnedAt ? '取消置顶' : '置顶', icon: project.pinnedAt ? PinOff : Pin },
    { separator: true },
    { id: 'archive', label: '归档工作区', icon: Archive },
  ]
}

function taskMenuItems(task) {
  return [
    { id: 'rename', label: '重命名', icon: Pencil },
    { id: 'pin', label: task.pinnedAt ? '取消置顶' : '置顶', icon: task.pinnedAt ? PinOff : Pin },
    { separator: true },
    { id: 'archive', label: '归档会话', icon: Archive },
  ]
}

function formatImportActivity(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return '更新时间未知'
  return `最近更新 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)}`
}

function agentStatusClass(agent) {
  if (agent.id === activeTaskId.value || !agent.requiresAttention) return ''
  if (agent.attentionReason === 'error') return 'agent-dot-failed'
  if (agent.attentionReason === 'finished') return 'agent-dot-finished'
  return ''
}

function clearViewedTaskAttention(task) {
  if (!task || task.id !== activeTaskId.value || !task.requiresAttention || attentionClearPending.has(task.id)) return
  attentionClearPending.add(task.id)
  v2Api.clearTaskAttention(task.id)
    .then(({ agent }) => upsertTaskAgent(agent))
    .catch((cause) => { error.value = cause.message })
    .finally(() => attentionClearPending.delete(task.id))
}

function applyTaskAgentEvent(agent) {
  const isActiveTask = agent?.taskId === activeTaskId.value
  const wasRunning = isActiveTask && (isRunning.value || sending.value)
  const shouldPinAfterCompletion = wasRunning && agent.lifecycle !== 'running' && followingTimeline.value
  const task = upsertTaskAgent(agent)
  if (!isActiveTask) return
  clearViewedTaskAttention(task)
  sending.value = agent.lifecycle === 'running'
  reconcileTerminalTaskTurns(task)
  if (shouldPinAfterCompletion) {
    pinTimelineToBottom(timelineRequestVersion)
    scrollToBottom({ force: true })
  }
}

function cacheTimeline(agentId = displayedTaskId.value || activeTaskId.value) {
  if (!agentId || displayedTaskId.value !== agentId || !timelineEpoch.value) return
  const snapshot = {
    agentId,
    rows: [...rows.value],
    turns: [...turns.value],
    epoch: timelineEpoch.value,
    maxSeq: rows.value.at(-1)?.seq || 0,
    hasOlderHistory: hasOlderHistory.value,
    cachedAt: Date.now(),
  }
  timelineCache.delete(agentId)
  timelineCache.set(agentId, snapshot)
  while (timelineCache.size > MAX_TIMELINE_CACHE_SIZE) timelineCache.delete(timelineCache.keys().next().value)
}

function restoreTimelineCache(agentId) {
  const snapshot = timelineCache.get(agentId)
  if (!snapshot) return false
  timelineCache.delete(agentId)
  timelineCache.set(agentId, snapshot)
  rows.value = [...snapshot.rows]
  turns.value = [...snapshot.turns]
  timelineEpoch.value = snapshot.epoch
  hasOlderHistory.value = snapshot.hasOlderHistory
  displayedTaskId.value = agentId
  return true
}

function clearTimelineCache(agentId) {
  if (agentId) timelineCache.delete(agentId)
  else timelineCache.clear()
}

function resetTimelineSelection() {
  timelineRequestVersion += 1
  releaseTimelineBottomPin()
  positioningTimeline = true
  activeTaskId.value = ''
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
  closeEvents()
}

function saveTaskDraft(content) {
  const agentId = activeTaskId.value
  if (!agentId) return
  const snapshot = Array.isArray(content) ? content.map((item) => ({ ...item })) : []
  draftsByTask.set(agentId, snapshot)
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
  const timing = turnTimings.value.get(entry.turnId)
  return isTimelineTurnRunning({
    agentRunning: isRunning.value || sending.value,
    latestTurnId: latestTurnId.value,
    turnId: entry.turnId,
    turnStatus: timing?.status,
  })
}

async function reconcileTerminalTaskTurns(task) {
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

async function loadInitial() {
  loading.value = true
  try {
    const [projectResult, providerResult] = await Promise.all([v2Api.listProjects(), v2Api.listProviders()])
    const projectTasks = await Promise.all((projectResult.projects || []).map(async (project) => ({ project, ...(await v2Api.listProjectTasks(project.id)) })))
    projects.value = projectTasks.map(({ project }) => project)
    providers.value = providerResult.providers
    tasksByProject.value = Object.fromEntries(projectTasks.map(({ project, tasks }) => [project.id, tasks.map((task) => taskView(task, project.id)).filter(Boolean)]))
    expandedProjectIds.value = new Set(projects.value.map((project) => project.id))
    if (projects.value.length) {
      loading.value = false
      await selectProject(projects.value[0].id)
    }
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

async function refreshProjects() {
  const previousProjectId = activeProjectId.value
  const previousTaskId = activeTaskId.value
  const result = await v2Api.listProjects()
  const projectTasks = await Promise.all((result.projects || []).map(async (project) => ({ project, ...(await v2Api.listProjectTasks(project.id)) })))
  projects.value = projectTasks.map(({ project }) => project)
  tasksByProject.value = Object.fromEntries(projectTasks.map(({ project, tasks }) => [project.id, tasks.map((task) => taskView(task, project.id)).filter(Boolean)]))

  if (!projects.value.some((project) => project.id === previousProjectId)) {
    resetTimelineSelection()
    activeProjectId.value = ''
    if (projects.value.length) await selectProject(projects.value[0].id)
    else positioningTimeline = false
    return
  }

  activeProjectId.value = previousProjectId
  if (!previousTaskId || tasksForProject(previousProjectId).some((task) => task.id === previousTaskId)) return
  clearTimelineCache(previousTaskId)
  draftsByTask.delete(previousTaskId)
  resetTimelineSelection()
  activeProjectId.value = previousProjectId
  const fallback = tasksForProject(previousProjectId)[0]
  if (fallback) await selectTask(fallback.id)
  else positioningTimeline = false
}

async function selectProject(id, { navigate = false } = {}) {
  activeProjectId.value = id
  setProjectExpanded(id)
  if (!(id in tasksByProject.value)) {
    const result = await v2Api.listProjectTasks(id)
    setProjectTasks(id, result.tasks.map((task) => taskView(task, id)).filter(Boolean))
  }
  const projectTasks = tasksForProject(id)
  if (projectTasks.length) await selectTask(projectTasks[0].id, { navigate })
  else {
    resetTimelineSelection()
    positioningTimeline = false
  }
}

async function selectTask(id, { navigate = false } = {}) {
  const task = Object.values(tasksByProject.value).flat().find((item) => item.id === id)
  if (!task) return
  if (navigate) enterMobileTimeline()
  activeProjectId.value = task.projectId
  setProjectExpanded(task.projectId)
  const requestVersion = ++timelineRequestVersion
  releaseTimelineBottomPin()
  positioningTimeline = true
  activeTaskId.value = id
  draftContent.value = draftsByTask.get(id)?.map((item) => ({ ...item })) || []
  const hasCachedTimeline = restoreTimelineCache(id)
  const cachedTimeline = timelineCache.get(id)
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
  if (cachedTimeline) openEvents(id, cachedTimeline.epoch, cachedTimeline.maxSeq)
  try {
    const [result, turnResult] = await Promise.all([
      v2Api.getTaskTimeline(id, { limit: INITIAL_TIMELINE_LIMIT }),
      v2Api.listTaskTurns(id, 1000),
    ])
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== id) return
    rows.value = result.timeline.rows
    turns.value = turnResult.turns
    timelineEpoch.value = result.timeline.epoch
    hasOlderHistory.value = result.timeline.hasOlder
    displayedTaskId.value = id
    cacheTimeline(id)
    pinTimelineToBottom(requestVersion)
    await scrollToBottom({ force: true })
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== id) return
    positioningTimeline = false
    closeEvents()
    openEvents(id, result.timeline.epoch, result.timeline.window.maxSeq)
    loadTaskControl(id, requestVersion)
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

async function loadTaskControl(agentId, requestVersion = timelineRequestVersion) {
  try {
    const result = await v2Api.getTaskControl(agentId)
    if (requestVersion === timelineRequestVersion && activeTaskId.value === agentId) agentControl.value = result.control
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === agentId) error.value = cause.message
  }
}

async function loadOlderHistory() {
  const agentId = activeTaskId.value
  const epoch = timelineEpoch.value
  const beforeSeq = rows.value[0]?.seq
  if (!agentId || !epoch || !beforeSeq || !hasOlderHistory.value || loadingOlderHistory.value) return

  const requestVersion = timelineRequestVersion
  let shouldContinueFilling = false
  loadingOlderHistory.value = true
  try {
    const result = await v2Api.getTaskTimeline(agentId, {
      direction: 'before',
      cursor: `${epoch}:${beforeSeq}`,
      limit: 300,
    })
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== agentId) return
    if (result.timeline.reset || result.timeline.epoch !== epoch) {
      await selectTask(agentId)
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
    cacheTimeline(agentId)
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
  if (document.visibilityState !== 'visible' || !activeTaskId.value) return
  const now = Date.now()
  if (now - timelineWakeSyncAt < 2_000) return
  timelineWakeSyncAt = now
  const agentId = activeTaskId.value
  const requestVersion = timelineRequestVersion
  timelineSyncing.value = true
  timelineSyncError.value = ''
  try {
    let result
    try {
      result = await v2Api.syncTaskTimeline(agentId)
    } catch (cause) {
      const statusCode = Number(cause?.statusCode || 0)
      const retryable = !statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500
      if (!retryable) throw cause
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_SYNC_RETRY_DELAY))
      if (requestVersion !== timelineRequestVersion || activeTaskId.value !== agentId || document.visibilityState !== 'visible') return
      result = await v2Api.syncTaskTimeline(agentId)
    }
    if (requestVersion !== timelineRequestVersion || activeTaskId.value !== agentId) return
    if (result.sync?.status === 'unavailable') timelineSyncError.value = 'Provider 历史记录暂时不可用。'
    else if (result.sync?.status === 'unsupported') timelineSyncError.value = '当前 Provider 不支持历史同步。'
    else timelineSyncError.value = ''
    applyTimelineSyncResult(result.sync, agentId)
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === agentId) timelineSyncError.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion && activeTaskId.value === agentId) timelineSyncing.value = false
  }
}

function applyTimelineSyncResult(sync, agentId) {
  if (!sync || activeTaskId.value !== agentId) return
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
    displayedTaskId.value = agentId
  }
  cacheTimeline(agentId)
}

function openEvents(agentId, epoch, seq) {
  eventSource = createEventSource(taskEventsUrl(agentId, seq ? `${epoch}:${seq}` : ''))
  eventSource.addEventListener('timeline', (event) => {
    if (activeTaskId.value !== agentId) return
    const { row } = JSON.parse(event.data)
    if (rows.value.some((item) => item.seq === row.seq)) return
    const shouldFollow = isTimelineAtBottom(timelineElement.value)
    rows.value.push(row)
    cacheTimeline(agentId)
    if (row.item?.type === 'tool_call' && ['completed', 'failed', 'canceled'].includes(row.item.status)) scheduleInspectorRefresh()
    followingTimeline.value = shouldFollow
    if (shouldFollow) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
  eventSource.addEventListener('agent', (event) => {
    if (activeTaskId.value !== agentId) return
    const { agent } = JSON.parse(event.data)
    applyTaskAgentEvent(agent)
  })
  eventSource.addEventListener('turn', (event) => {
    if (activeTaskId.value !== agentId) return
    const turn = JSON.parse(event.data).turn
    upsertTurn(turn)
    if (['completed', 'failed', 'canceled'].includes(turn.status)) scheduleInspectorRefresh()
  })
  eventSource.addEventListener('timeline-synced', (event) => {
    if (activeTaskId.value !== agentId) return
    const { sync } = JSON.parse(event.data)
    timelineSyncError.value = ''
    applyTimelineSyncResult(sync, agentId)
  })
  eventSource.addEventListener('timeline-sync-warning', (event) => {
    if (activeTaskId.value !== agentId) return
    const { sync } = JSON.parse(event.data)
    timelineSyncError.value = sync?.error || (sync?.status === 'unavailable'
      ? 'Provider 历史尚未落盘，稍后会再次同步。'
      : 'Provider 历史确认失败。')
    if (sync?.turn) upsertTurn(sync.turn)
  })
  eventSource.addEventListener('control', (event) => {
    if (activeTaskId.value !== agentId) return
    agentControl.value = JSON.parse(event.data).control
  })
  eventSource.addEventListener('reset', (event) => {
    if (activeTaskId.value !== agentId) return
    const { timeline } = JSON.parse(event.data)
    rows.value = timeline.rows
    timelineEpoch.value = timeline.epoch
    hasOlderHistory.value = timeline.hasOlder
    displayedTaskId.value = agentId
    cacheTimeline(agentId)
    if (followingTimeline.value) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
}

function scheduleInspectorRefresh() {
  if (!drawerMode.value) return
  if (inspectorRefreshTimer) clearTimeout(inspectorRefreshTimer)
  inspectorRefreshTimer = setTimeout(() => {
    inspectorRefreshTimer = null
    const drawer = drawerMode.value === 'diff' ? diffDrawer.value : filesDrawer.value
    drawer?.refreshGit({ preserveDiff: true })
  }, 250)
}

async function openProjectPath(target) {
  drawerMode.value = target.intent === 'diff' ? 'diff' : 'files'
  await nextTick()
  const drawer = target.intent === 'diff' ? diffDrawer.value : filesDrawer.value
  drawer?.openPath(target)
}

function toggleDrawer(mode) {
  drawerMode.value = drawerMode.value === mode ? null : mode
}

function showMobileSidebar() {
  drawerMode.value = null
  if (isMobile.value && hasMobileTimelineHistoryState(window.history.state)) {
    window.history.back()
    return
  }
  mobileView.value = 'sidebar'
}

function enterMobileTimeline() {
  mobileView.value = 'timeline'
  if (!isMobile.value || hasMobileTimelineHistoryState(window.history.state)) return
  window.history.pushState(createMobileTimelineHistoryState(window.history.state), '')
}

function handleMobileHistoryPop(event) {
  const historyDialog = getMobileDialogHistoryState(event.state)
  if (dialogUsesHistory && historyDialog !== dialog.value) {
    finishDialogClose()
  } else if (!dialogUsesHistory && isMobile.value && historyDialog) {
    restoreDialogFromHistory(historyDialog)
  }

  if (!isMobile.value) return
  drawerMode.value = null
  mobileView.value = hasMobileTimelineHistoryState(event.state) && activeTaskId.value
    ? 'timeline'
    : 'sidebar'
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && !dialog.value && drawerMode.value) drawerMode.value = null
}

function openGlobalEvents() {
  globalEventSource?.close()
  globalEventSource = createEventSource(globalEventsUrl())
  globalEventSource.addEventListener('task', (event) => {
    const { agent } = JSON.parse(event.data)
    applyTaskAgentEvent(agent)
  })
}

function closeGlobalEvents() {
  globalEventSource?.close()
  globalEventSource = null
}

function closeEvents() {
  eventSource?.close()
  eventSource = null
}

function cancelDirectorySearch() {
  if (directorySearchTimer) clearTimeout(directorySearchTimer)
  directorySearchTimer = null
  directorySearchController?.abort()
  directorySearchController = null
  directorySearchLoading.value = false
}

async function searchDirectorySuggestions(query = projectPath.value) {
  directorySearchController?.abort()
  const controller = new AbortController()
  directorySearchController = controller
  directorySearchLoading.value = true
  directorySearchError.value = ''
  selectedDirectoryIndex.value = -1
  try {
    const result = await v2Api.searchDirectories(query.trim(), { limit: 20, signal: controller.signal })
    if (directorySearchController !== controller) return
    directorySuggestions.value = result.items || []
    directorySuggestionsOpen.value = true
  } catch (cause) {
    if (cause.name === 'AbortError' || directorySearchController !== controller) return
    directorySuggestions.value = []
    directorySuggestionsOpen.value = true
    directorySearchError.value = cause.message
  } finally {
    if (directorySearchController === controller) {
      directorySearchController = null
      directorySearchLoading.value = false
    }
  }
}

function scheduleDirectorySearch() {
  cancelDirectorySearch()
  if (!projectPath.value.trim()) {
    directorySuggestions.value = []
    directorySearchError.value = ''
    directorySuggestionsOpen.value = false
    selectedDirectoryIndex.value = -1
    return
  }
  directorySuggestionsOpen.value = true
  selectedDirectoryIndex.value = -1
  directorySearchTimer = setTimeout(() => {
    directorySearchTimer = null
    searchDirectorySuggestions()
  }, 250)
}

async function openConversationDialog(project = null) {
  projectPath.value = project?.repositoryRoot || ''
  taskTitle.value = ''
  executionKind.value = 'local'
  taskBaseRef.value = 'HEAD'
  taskSlug.value = ''
  taskBranchName.value = ''
  conversationError.value = ''
  taskProvider.value = providers.value.some((provider) => provider.id === 'codex')
    ? 'codex'
    : providers.value[0]?.id || ''
  directorySuggestions.value = []
  directorySearchError.value = ''
  directorySuggestionsOpen.value = false
  selectedDirectoryIndex.value = -1
  openManagedDialog('conversation')
  await nextTick()
  projectPathInput.value?.focus()
}

async function openImportDialog() {
  openManagedDialog('import')
  importProviderFilter.value = ''
  importQuery.value = ''
  importError.value = ''
  await loadImportSessions()
}

function cancelImportSearch() {
  if (importSearchTimer) clearTimeout(importSearchTimer)
  importSearchTimer = null
  importSearchController?.abort()
  importSearchController = null
}

async function loadImportSessions() {
  importLoading.value = true
  importError.value = ''
  importSearchController?.abort()
  const controller = new AbortController()
  importSearchController = controller
  try {
    const result = await v2Api.listImportableSessions({
      providerId: importProviderFilter.value,
      query: importQuery.value,
      limit: 200,
      signal: controller.signal,
    })
    if (dialog.value === 'import' && importSearchController === controller) {
      importSessions.value = result.sessions || []
      importError.value = (result.errors || []).map((item) => `${item.providerLabel || item.providerId}：${item.message}`).join('；')
    }
  } catch (cause) {
    if (cause.name !== 'AbortError' && importSearchController === controller) {
      importSessions.value = []
      importError.value = cause.message
    }
  } finally {
    if (importSearchController === controller) {
      importSearchController = null
      importLoading.value = false
    }
  }
}

function scheduleImportSearch() {
  if (importSearchTimer) clearTimeout(importSearchTimer)
  importSearchTimer = setTimeout(() => {
    importSearchTimer = null
    loadImportSessions()
  }, 220)
}

function clearImportQuery() {
  importQuery.value = ''
  scheduleImportSearch()
}

async function selectImportProvider(providerId) {
  if (importProviderFilter.value === providerId) return
  importProviderFilter.value = providerId
  await loadImportSessions()
}

async function importSession(session) {
  if (importingId.value) return
  importingId.value = session.providerHandleId
  importError.value = ''
  try {
    const result = await v2Api.importSession({
      providerId: session.providerId,
      providerHandleId: session.providerHandleId,
      cwd: session.cwd || activeProject.value?.repositoryRoot || '',
      title: session.title,
    })
    const project = result.project
    if (project && !projects.value.some((item) => item.id === project.id)) projects.value.push(project)
    const task = taskView({ ...result.task, environment: result.environment, agent: result.agent }, project.id)
    setProjectTasks(project.id, [task, ...tasksForProject(project.id).filter((item) => item.id !== task.id)])
    await closeDialog()
    setProjectExpanded(project.id)
    await selectTask(task.id, { navigate: true })
  } catch (cause) {
    importError.value = cause.message
  } finally {
    importingId.value = ''
  }
}

function openManagedDialog(dialogId) {
  dialog.value = dialogId
  if (!isMobile.value) return
  if (getMobileDialogHistoryState(window.history.state) === dialogId) {
    dialogUsesHistory = true
    return
  }
  dialogUsesHistory = true
  window.history.pushState(createMobileDialogHistoryState(window.history.state, dialogId), '')
}

function restoreDialogFromHistory(dialogId) {
  dialogUsesHistory = true
  dialog.value = dialogId
  if (dialogId === 'import') loadImportSessions()
}

function finishDialogClose() {
  cancelDirectorySearch()
  cancelImportSearch()
  directorySuggestionsOpen.value = false
  dialog.value = ''
  dialogUsesHistory = false
  resolveDialogHistoryClose?.()
  dialogHistoryClosePromise = null
  resolveDialogHistoryClose = null
}

function closeDialog() {
  if (dialogUsesHistory && getMobileDialogHistoryState(window.history.state) === dialog.value) {
    if (!dialogHistoryClosePromise) {
      dialogHistoryClosePromise = new Promise((resolve) => {
        resolveDialogHistoryClose = resolve
      })
      window.history.back()
    }
    return dialogHistoryClosePromise
  }
  finishDialogClose()
  return Promise.resolve()
}

function selectDirectory(directory) {
  projectPath.value = directory.path
  selectedDirectoryIndex.value = -1
  directorySuggestionsOpen.value = false
  projectPathInput.value?.focus()
}

async function browseDirectory() {
  cancelDirectorySearch()
  directorySuggestionsOpen.value = false
  directorySearchError.value = ''
  conversationError.value = ''
  directoryPicking.value = true
  try {
    const result = await v2Api.pickDirectory(projectPath.value)
    if (!result.canceled && result.path) projectPath.value = result.path
  } catch (cause) {
    directorySearchError.value = cause.message
  } finally {
    directoryPicking.value = false
    projectPathInput.value?.focus()
  }
}

async function revealSelectedDirectory() {
  await nextTick()
  document.getElementById(`directory-suggestion-${selectedDirectoryIndex.value}`)?.scrollIntoView({ block: 'nearest' })
}

function handleDirectoryKeydown(event) {
  if (event.key === 'Escape') {
    if (directorySuggestionsOpen.value) {
      event.preventDefault()
      directorySuggestionsOpen.value = false
    }
    return
  }

  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
  if (!directorySuggestionsOpen.value) {
    if (event.key === 'Enter') return
    directorySuggestionsOpen.value = true
  }
  if (!directorySuggestions.value.length) return

  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selectedDirectoryIndex.value = (selectedDirectoryIndex.value + 1) % directorySuggestions.value.length
    revealSelectedDirectory()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    selectedDirectoryIndex.value = selectedDirectoryIndex.value <= 0
      ? directorySuggestions.value.length - 1
      : selectedDirectoryIndex.value - 1
    revealSelectedDirectory()
  } else if (selectedDirectoryIndex.value >= 0) {
    event.preventDefault()
    selectDirectory(directorySuggestions.value[selectedDirectoryIndex.value])
  }
}

async function createConversation() {
  if (creating.value) return
  cancelDirectorySearch()
  directorySuggestionsOpen.value = false
  selectedDirectoryIndex.value = -1
  creating.value = true
  conversationError.value = ''
  try {
    const project = (await v2Api.createProject({ repositoryRoot: projectPath.value })).project
    const slug = taskSlug.value || taskTitle.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'task'
    const result = await v2Api.createTask(project.id, { title: taskTitle.value, providerId: taskProvider.value, executionKind: executionKind.value, baseRef: taskBaseRef.value, branchName: taskBranchName.value || `codex/${slug}`, slug })
    const task = taskView({ ...result.task, environment: result.environment, agent: result.agent }, project.id)
    if (!projects.value.some((item) => item.id === project.id)) projects.value.push(project)
    setProjectTasks(project.id, [task, ...tasksForProject(project.id).filter((item) => item.id !== task.id)])
    projectPath.value = ''
    await closeDialog()
    setProjectExpanded(project.id)
    await selectTask(task.id, { navigate: true })
  } catch (cause) {
    conversationError.value = cause.message
  } finally {
    creating.value = false
  }
}

function requestConfirmation(options = {}) {
  return new Promise((resolve) => {
    confirmation.value = { open: true, resolve, ...options }
  })
}

function cancelConfirmation() {
  const resolve = confirmation.value.resolve
  confirmation.value = { open: false, title: '', description: '', confirmText: '', danger: false, resolve: null }
  resolve?.(false)
}

function acceptConfirmation() {
  const resolve = confirmation.value.resolve
  confirmation.value = { open: false, title: '', description: '', confirmText: '', danger: false, resolve: null }
  resolve?.(true)
}

async function handleProjectMenu(action, project) {
  if (action === 'new') {
    openConversationDialog(project)
    return
  }
  if (action === 'archive') {
    await archiveProject(project)
    return
  }
  if (action === 'pin') {
    try {
      await v2Api.setProjectPinned(project.id, !project.pinnedAt)
      await refreshProjects()
    } catch (cause) {
      error.value = cause.message
    }
  }
}

function beginTaskRename(task) {
  renamingTaskId.value = task.id
  taskRenameDraft.value = task.title
  nextTick(() => taskRenameInput?.select())
}

function cancelTaskRename() {
  renamingTaskId.value = ''
  taskRenameDraft.value = ''
  taskRenameInput = null
}

async function saveTaskRename(task) {
  if (renamingTaskId.value !== task.id || taskRenameSaving.value) return
  const title = taskRenameDraft.value.trim()
  if (!title) {
    error.value = '会话名称不能为空。'
    nextTick(() => taskRenameInput?.focus())
    return
  }
  if (title === task.title) {
    cancelTaskRename()
    return
  }
  taskRenameSaving.value = true
  try {
    const result = await v2Api.updateTask(task.id, { title })
    const updated = taskView(result.task, task.projectId)
    setProjectTasks(task.projectId, tasksForProject(task.projectId).map((item) => item.id === task.id ? updated : item))
    cancelTaskRename()
  } catch (cause) {
    error.value = cause.message
    nextTick(() => taskRenameInput?.focus())
  } finally {
    taskRenameSaving.value = false
  }
}

async function handleTaskMenu(action, task) {
  if (action === 'rename') {
    beginTaskRename(task)
    return
  }
  if (action === 'archive') {
    await archiveTask(task)
    return
  }
  if (action === 'pin') {
    try {
      await v2Api.setTaskPinned(task.id, !task.pinnedAt)
      await refreshProjects()
    } catch (cause) {
      error.value = cause.message
    }
  }
}

async function archiveTask(task) {
  if (!await requestConfirmation({
    title: `归档会话“${task.title}”？`,
    description: '会话将从左栏隐藏，Timeline 和 Worktree 会继续保留。',
    confirmText: '归档',
    danger: false,
  })) return
  const projectTasks = tasksForProject(task.projectId)
  const removedIndex = projectTasks.findIndex((item) => item.id === task.id)
  try {
    await v2Api.archiveTask(task.id)
    clearTimelineCache(task.id)
    draftsByTask.delete(task.id)
    const remainingTasks = projectTasks.filter((item) => item.id !== task.id)
    setProjectTasks(task.projectId, remainingTasks)
    if (activeTaskId.value !== task.id) return
    resetTimelineSelection()
    const fallback = remainingTasks[Math.min(removedIndex, remainingTasks.length - 1)]
    if (fallback) await selectTask(fallback.id)
    else positioningTimeline = false
  } catch (cause) {
    error.value = cause.message
  }
}

async function archiveProject(project) {
  if (!await requestConfirmation({
    title: `归档工作区“${project.displayName}”？`,
    description: '工作区及其活动会话将从左栏隐藏，可在设置的归档页恢复。',
    confirmText: '归档',
    danger: false,
  })) return
  await v2Api.archiveProject(project.id)
  tasksForProject(project.id).forEach((task) => {
    clearTimelineCache(task.id)
    draftsByTask.delete(task.id)
  })
  projects.value = projects.value.filter((item) => item.id !== project.id)
  const nextTasksByProject = { ...tasksByProject.value }
  delete nextTasksByProject[project.id]
  tasksByProject.value = nextTasksByProject
  setProjectExpanded(project.id, false)
  if (activeProjectId.value !== project.id) return
  resetTimelineSelection()
  activeProjectId.value = ''
  if (projects.value.length) await selectProject(projects.value[0].id)
  else positioningTimeline = false
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
    if (cause.code === 'codex_thread_active_writer') {
      sendBlockedReason.value = cause.message
    } else {
      error.value = cause.message
    }
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
    upsertTaskAgent(result.agent)
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

function updateMobileState(event) {
  isMobile.value = event.matches
  mobileView.value = event.matches
    ? (hasMobileTimelineHistoryState(window.history.state) ? 'timeline' : 'sidebar')
    : 'timeline'
  if (event.matches && dialog.value && !dialogUsesHistory) {
    openManagedDialog(dialog.value)
  }
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  window.addEventListener('popstate', handleMobileHistoryPop)
  document.addEventListener('visibilitychange', syncVisibleTimeline)
  mobileMediaQuery = window.matchMedia('(max-width: 720px)')
  updateMobileState(mobileMediaQuery)
  mobileMediaQuery.addEventListener('change', updateMobileState)
  await loadInitial()
  const historyDialog = getMobileDialogHistoryState(window.history.state)
  if (isMobile.value && historyDialog) restoreDialogFromHistory(historyDialog)
  openGlobalEvents()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  window.removeEventListener('popstate', handleMobileHistoryPop)
  document.removeEventListener('visibilitychange', syncVisibleTimeline)
  mobileMediaQuery?.removeEventListener('change', updateMobileState)
  closeEvents()
  closeGlobalEvents()
  cancelDirectorySearch()
  cancelImportSearch()
  if (markdownScrollFrame) cancelAnimationFrame(markdownScrollFrame)
  releaseTimelineBottomPin()
  if (inspectorRefreshTimer) clearTimeout(inspectorRefreshTimer)
})
</script>

<template>
  <div class="v2-shell panel relative grid h-full min-h-0 overflow-hidden">
    <div v-if="loading" class="v2-loading-skeleton absolute inset-0 z-30 grid grid-cols-[240px_minmax(0,1fr)]" role="status" aria-label="正在加载工作区">
      <div class="border-r p-3"><div class="skeleton-line h-7 w-24" /><div class="skeleton-line mt-5 h-9 w-full" /><div class="skeleton-line mt-3 h-8 w-4/5" /><div class="skeleton-line mt-2 h-8 w-3/5" /></div>
      <div class="p-4"><div class="skeleton-line h-8 w-40" /><div class="mx-auto mt-16 max-w-3xl space-y-3"><div class="skeleton-line h-12 w-3/4" /><div class="skeleton-line h-20 w-5/6" /><div class="skeleton-line h-12 w-2/3" /></div></div>
    </div>
    <aside
      class="workspace-sidebar flex min-h-0 flex-col border-r"
      :class="mobileView === 'sidebar' ? 'mobile-panel-active' : 'mobile-panel-hidden'"
      :inert="isMobile && mobileView !== 'sidebar'"
      :aria-hidden="isMobile ? mobileView !== 'sidebar' : undefined"
    >
      <header class="flex h-14 shrink-0 items-center border-b px-3">
        <div class="flex min-w-0 items-center gap-2">
          <div class="brand-mark flex h-7 w-7 items-center justify-center rounded-sm"><TerminalSquare class="h-4 w-4" /></div>
          <span class="text-sm font-semibold">PromptX</span><span class="theme-muted-text text-[10px]">V2</span>
        </div>
      </header>
      <div class="shrink-0 px-2 pb-2 pt-2">
        <PxButton variant="primary" size="sm" class="sidebar-primary-action h-9 w-full justify-start px-2 text-left text-xs" @click="openConversationDialog()">
          <Plus class="h-4 w-4 shrink-0" />
          <span>新会话</span>
        </PxButton>
        <PxButton variant="ghost" size="sm" class="sidebar-secondary-action mt-1 h-8 w-full justify-start px-2 text-left text-xs" @click="openImportDialog">
          <FolderOpen class="h-3.5 w-3.5 shrink-0" />
          <span>导入会话</span>
        </PxButton>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="theme-muted-text flex h-8 items-center px-2 text-[10px] font-medium uppercase tracking-wide">工作区</div>
        <div v-for="project in projects" :key="project.id" class="workspace-group mb-2">
          <div class="workspace-heading group flex h-9 min-w-0 cursor-pointer items-center rounded-sm" :class="project.id === activeProjectId ? 'workspace-active' : ''" @click="handleProjectRowClick(project)">
            <PxIconButton
              class="workspace-toggle h-7 w-7 shrink-0"
              :label="expandedProjectIds.has(project.id) ? '收起工作区' : '展开工作区'"
              :aria-expanded="expandedProjectIds.has(project.id)"
              @click.stop="toggleProject(project.id)"
            >
              <FolderOpen v-if="expandedProjectIds.has(project.id)" class="h-4 w-4" />
              <Folder v-else class="h-4 w-4" />
            </PxIconButton>
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" :title="project.repositoryRoot" @click.stop="handleProjectRowClick(project)">
              <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ project.displayName }}</span>
              <Pin v-if="project.pinnedAt" class="theme-muted-text h-3 w-3 shrink-0" aria-label="已置顶" />
            </button>
            <PxActionMenu class="workspace-action" :label="`${project.displayName} 的更多操作`" :items="projectMenuItems(project)" @select="handleProjectMenu($event, project)" />
          </div>
          <Transition name="workspace-agents">
            <div v-if="expandedProjectIds.has(project.id)" class="workspace-agents-wrapper">
              <div class="agent-list ml-6">
                <div v-for="task in tasksForProject(project.id)" :key="task.id" class="agent-row group flex h-8 min-w-0 items-center rounded-sm" :class="task.id === activeTaskId ? 'row-active' : ''">
                  <input v-if="renamingTaskId === task.id" :ref="(element) => { if (element) taskRenameInput = element }" v-model="taskRenameDraft"
                    class="task-rename-input mx-1 h-8 min-w-0 flex-1 rounded-sm border px-2 text-xs outline-none" maxlength="120"
                    :disabled="taskRenameSaving" :aria-label="`重命名 ${task.title}`" @click.stop @blur="saveTaskRename(task)"
                    @keydown.enter.prevent="$event.currentTarget.blur()" @keydown.esc.prevent="cancelTaskRename" />
                  <div v-else role="link" tabindex="0" class="task-navigation flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left"
                    :aria-current="task.id === activeTaskId ? 'page' : undefined" :title="`${task.title} · ${providerLabel(task.providerId)}`"
                    @click="selectTask(task.id, { navigate: true })" @keydown.enter.prevent="selectTask(task.id, { navigate: true })">
                    <span v-if="agentStatusClass(task)" class="agent-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="agentStatusClass(task)" />
                    <SessionTitleMarquee class="min-w-0 flex-1 text-xs" :title="task.title" :active="task.id === activeTaskId" />
                    <Pin v-if="task.pinnedAt" class="theme-muted-text h-3 w-3 shrink-0" aria-label="已置顶" />
                    <LoaderCircle v-if="task.lifecycle === 'running'" class="theme-muted-text h-3 w-3 shrink-0 animate-spin" />
                  </div>
                  <PxActionMenu class="agent-action" :label="`${task.title} 的更多操作`" :items="taskMenuItems(task)" @select="handleTaskMenu($event, task)" />
                </div>
                <button v-if="!tasksForProject(project.id).length" type="button" class="theme-muted-text flex h-8 w-full items-center justify-start gap-2 px-2 text-left text-[10px]" @click="openConversationDialog(project)"><Plus class="h-3 w-3" />新会话</button>
              </div>
            </div>
          </Transition>
        </div>
        <div v-if="!projects.length && !loading" class="theme-muted-text px-3 py-8 text-center text-xs">还没有工作区</div>
      </div>
      <footer class="border-t p-2">
        <PxButton variant="ghost" size="sm" class="settings-entry h-9 w-full justify-start gap-2 px-2 text-left text-xs" @click="openManagedDialog('settings')">
          <Settings class="h-4 w-4 shrink-0" />
          <span>设置</span>
        </PxButton>
      </footer>
    </aside>

    <main
      class="timeline-pane flex min-h-0 min-w-0 flex-col"
      :class="mobileView === 'timeline' ? 'mobile-panel-active' : 'mobile-panel-hidden'"
      :inert="isMobile && mobileView !== 'timeline'"
      :aria-hidden="isMobile ? mobileView !== 'timeline' : undefined"
    >
      <header class="timeline-header flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <PxIconButton class="mobile-back-button h-8 w-8" label="返回项目列表" @click="showMobileSidebar"><ArrowLeft class="h-4 w-4" /></PxIconButton>
        <div v-if="activeProject" class="mobile-workspace-path min-w-0 flex-1" :title="activeProject.repositoryRoot">
          <span class="block truncate text-sm font-medium">{{ activeProjectDirectoryName }}</span>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <div v-if="timelineSyncing" class="timeline-sync-status theme-muted-text flex h-8 w-8 items-center justify-center" title="正在同步 Timeline" aria-label="正在同步 Timeline"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /></div>
          <div v-if="activeTask" class="status-chip flex items-center gap-1.5 px-1 py-1 text-[10px]"><span class="status-dot h-1.5 w-1.5 rounded-full" :class="isRunning ? 'status-dot-running' : ''" /><span class="status-text">{{ isRunning ? '运行中' : '已连接' }}</span></div>
          <PxIconButton v-if="activeTask" class="drawer-trigger h-8 w-8" :class="drawerMode === 'files' ? 'is-active' : ''" :label="drawerMode === 'files' ? '关闭文件抽屉' : '浏览文件'" :aria-pressed="drawerMode === 'files'" @click="toggleDrawer('files')"><Files class="h-4 w-4" /></PxIconButton>
          <PxIconButton v-if="activeTask" class="drawer-trigger h-8 w-8" :class="drawerMode === 'diff' ? 'is-active' : ''" :label="drawerMode === 'diff' ? '关闭 Diff 抽屉' : '查看 Diff'" :aria-pressed="drawerMode === 'diff'" @click="toggleDrawer('diff')"><FileDiff class="h-4 w-4" /></PxIconButton>
          <PxIconButton v-if="activeTask" class="drawer-trigger h-8 w-8" :class="drawerMode === 'task-details' ? 'is-active' : ''" label="任务详情" :aria-pressed="drawerMode === 'task-details'" @click="toggleDrawer('task-details')"><Info class="h-4 w-4" /></PxIconButton>
        </div>
      </header>

      <div class="relative min-h-0 flex-1">
        <div ref="timelineElement" class="timeline h-full overflow-y-auto" @scroll.passive="handleTimelineScroll">
          <div v-if="timelineSyncError && !timelineHasContent" class="flex h-full items-center justify-center p-8 text-center"><div class="max-w-sm"><p class="error-row rounded-sm border px-3 py-2 text-left text-xs">Timeline 同步失败：{{ timelineSyncError }}</p><PxButton variant="secondary" size="sm" class="mt-3" @click="selectTask(activeTaskId)">重试</PxButton></div></div>
          <div v-else-if="!activeTask || !entries.length" class="flex h-full items-center justify-center p-8 text-center"><div><Bot class="theme-muted-text mx-auto h-8 w-8" /><p class="mt-3 text-sm font-medium">{{ activeTask ? '开始一段新的协作' : '新建一条会话' }}</p><p v-if="activeTask" class="theme-muted-text mt-1 text-xs">消息会在当前工作区内执行</p></div></div>
          <div v-else class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <template v-for="entry in entries" :key="entry.key || `${entry.seqStart}-${entry.item?.type || ''}`">
              <TimelineTurn v-if="entry.presentationType === 'turn'" :turn="entry" :timing="turnTimings.get(entry.turnId)" :running="processIsRunning(entry)" :is-dark="isDark" :workspace-cwd="activeTask?.environment?.cwd" @rendered="handleMarkdownRendered" @open-workspace-path="openProjectPath" />
              <article v-else-if="entry.item?.type === 'error'" class="error-row mb-5 ml-7 rounded-sm border px-3 py-2 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.message }}</article>
              <article v-else-if="entry.item?.type === 'system_notice'" class="theme-muted-text mb-5 ml-7 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.text }}</article>
            </template>
            <div class="timeline-generating-slot ml-7 flex h-8 items-start">
              <div
                class="timeline-generating-indicator flex items-center gap-1"
                :class="isRunning || sending ? 'is-visible' : ''"
                role="status"
                :aria-hidden="!(isRunning || sending)"
                :aria-label="isRunning || sending ? '正在生成' : undefined"
              >
                <span class="timeline-generating-dot" aria-hidden="true">.</span>
                <span class="timeline-generating-dot" aria-hidden="true">.</span>
                <span class="timeline-generating-dot" aria-hidden="true">.</span>
              </div>
            </div>
          </div>
          <div v-if="timelineSyncError && timelineHasContent" class="status-float status-float-pill status-float-error timeline-sync-error absolute left-1/2 top-3 z-10 flex -translate-x-1/2 gap-2" role="alert"><CircleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>同步失败</span><PxButton variant="ghost" size="sm" class="font-medium" @click="selectTask(activeTaskId)">重试</PxButton></div>
        </div>
        <div v-if="timelineLoading && !loading" class="timeline-loading-overlay absolute inset-0 z-10 flex items-start justify-center pt-16" role="status" aria-label="加载中">
          <div class="status-float status-float-pill timeline-loading-indicator gap-2">
            <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
            <span>加载中</span>
          </div>
        </div>
        <div v-if="loadingOlderHistory" class="status-float status-float-icon pointer-events-none absolute left-1/2 top-3 z-10 -translate-x-1/2" role="status" aria-label="正在加载更早记录">
          <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
        </div>
        <PxIconButton
          v-if="!followingTimeline && timelineHasContent"
          class="timeline-jump-button absolute bottom-3 left-1/2 z-10 h-9 w-9 -translate-x-1/2 p-0 shadow-sm"
          :label="hasNewTimelineItems ? '有新消息，回到底部' : '回到底部'"
          @click="jumpToLatest"
        >
          <ArrowDown class="h-3.5 w-3.5" />
        </PxIconButton>
      </div>

      <footer v-if="activeTask" class="composer-wrap shrink-0 p-3 sm:p-4">
        <div v-if="error" class="error-row mx-auto mb-2 max-w-3xl rounded-sm border px-3 py-2 text-xs">{{ error }}</div>
        <div v-if="sendBlockedReason" class="writer-blocked-row mx-auto mb-2 flex max-w-3xl items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs">
          <span>{{ sendBlockedReason }}</span>
          <PxButton variant="ghost" size="sm" class="shrink-0 font-medium" @click="sendBlockedReason = ''">重新尝试</PxButton>
        </div>
        <AgentComposer
          :key="activeTaskId"
          :task-id="activeTask.id"
          :running="isRunning"
          :sending="sending"
          :blocked-reason="sendBlockedReason"
          :control="agentControl"
          :settings-loading="settingsLoading"
          :draft-content="draftContent"
          :on-submit="submitPrompt"
          :on-settings-change="updateAgentSettings"
          @cancel="v2Api.cancelTask(activeTaskId)"
          @draft-change="saveTaskDraft"
        />
      </footer>
    </main>

    <Transition name="workspace-drawer">
      <WorkspaceInspector
        v-if="activeTask && drawerMode === 'files'"
        ref="filesDrawer"
        :task-id="activeTask.id"
        :workspace-cwd="activeTask.environment?.cwd || activeProject.repositoryRoot"
        :is-dark="isDark"
        mode="files"
        @close="drawerMode = null"
      />
    </Transition>
    <Transition name="workspace-drawer">
      <WorkspaceInspector
        v-if="activeTask && drawerMode === 'diff'"
        ref="diffDrawer"
        :task-id="activeTask.id"
        :workspace-cwd="activeTask.environment?.cwd || activeProject.repositoryRoot"
        :is-dark="isDark"
        mode="diff"
        @close="drawerMode = null"
      />
    </Transition>
    <Transition name="workspace-drawer">
      <TaskDetailsDrawer
        v-if="activeTask && drawerMode === 'task-details'"
        :task-id="activeTask.id"
        @close="drawerMode = null"
        @changed="refreshProjects"
      />
    </Transition>

    <V2SettingsDialog :open="dialog === 'settings'" @close="closeDialog" @changed="refreshProjects" />

    <PxDialog
      :open="dialog === 'conversation'"
      panel-class="new-conversation-panel h-[100dvh] max-h-[100dvh] max-w-none border-0 sm:h-[min(44rem,calc(100dvh-1.5rem))] sm:max-h-[min(44rem,calc(100dvh-1.5rem))] sm:max-w-md sm:border"
      header-class="h-14 px-4 sm:px-5"
      body-class="flex min-h-0 flex-1 flex-col"
      @close="closeDialog"
    >
      <template #title><h2 class="text-sm font-semibold">新会话</h2></template>
      <form class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-4 sm:pt-5" @submit.prevent="createConversation">
        <PxField label="路径" for-id="workspace-path" :error="directorySearchError">
          <DirectorySearchInput
            ref="projectPathInput"
            v-model="projectPath"
            class="mt-1"
            :loading="directorySearchLoading"
            :open="directorySuggestionsOpen"
            :suggestions="directorySuggestions"
            :error="directorySearchError"
            :selected-index="selectedDirectoryIndex"
            :disabled="creating || directoryPicking"
            :picking="directoryPicking"
            @input="scheduleDirectorySearch"
            @keydown="handleDirectoryKeydown"
            @mouseenter="selectedDirectoryIndex = $event"
            @select="selectDirectory"
            @browse="browseDirectory"
          />
        </PxField>
        <PxAlert v-if="conversationError" class="mt-3 shrink-0">{{ conversationError }}</PxAlert>
        <div class="shrink-0">
          <PxField class="mt-4" label="Provider" for-id="conversation-provider">
            <PxSelect id="conversation-provider" v-model="taskProvider" :options="providerOptions" :disabled="creating" aria-label="Provider" />
          </PxField>
          <PxField class="mt-4" label="任务标题" for-id="task-title">
            <input id="task-title" v-model="taskTitle" class="tool-input mt-1" placeholder="任务标题" :disabled="creating" />
          </PxField>
          <PxField class="mt-4" label="执行位置" for-id="execution-kind">
            <PxSelect id="execution-kind" v-model="executionKind" :options="executionOptions" :disabled="creating" aria-label="执行位置" />
          </PxField>
          <div v-if="executionKind === 'worktree'" class="grid grid-cols-1 gap-2">
            <PxField class="mt-2" label="基线" for-id="task-base-ref">
              <PxSelect id="task-base-ref" v-model="taskBaseRef" :options="baseRefOptions" :disabled="creating" aria-label="基线" />
            </PxField>
            <PxField label="Worktree 名称" hint="可选，例如 fix-login">
              <input v-model="taskSlug" class="tool-input mt-1" placeholder="Worktree 名称，例如 fix-login" :disabled="creating" />
            </PxField>
          </div>
        </div>
        <div class="sticky bottom-0 mt-4 flex shrink-0 justify-end border-t px-0 pb-0 pt-3" style="background: var(--theme-appPanel);"><PxButton type="submit" variant="primary" size="sm" :loading="creating" :disabled="!projectPath.trim() || !taskProvider">创建会话</PxButton></div>
      </form>
    </PxDialog>

    <PxDialog
      :open="dialog === 'import'"
      panel-class="import-dialog-panel h-[100dvh] max-w-none border-0 sm:h-[min(40rem,calc(100dvh-3rem))] sm:max-w-2xl sm:border"
      header-class="h-14 px-4 sm:px-5"
      body-class="flex min-h-0 flex-1 flex-col"
      @close="closeDialog"
    >
      <template #title><h2 class="text-sm font-semibold">导入会话</h2></template>
      <div class="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <div class="import-layout flex min-h-0 flex-1 gap-3 pt-1">
          <aside class="import-provider-list flex w-28 shrink-0 flex-col gap-1 border-r pr-3">
            <button type="button" class="import-provider-filter flex h-8 items-center justify-start px-2 text-left text-xs" :class="!importProviderFilter ? 'is-active' : ''" @click="selectImportProvider('')">全部 Provider</button>
            <button v-for="provider in providers" :key="provider.id" type="button" class="import-provider-filter flex h-8 items-center justify-start px-2 text-left text-xs" :class="importProviderFilter === provider.id ? 'is-active' : ''" @click="selectImportProvider(provider.id)">{{ provider.label }}</button>
          </aside>
          <section class="flex min-w-0 min-h-0 flex-1 flex-col">
            <div class="relative shrink-0">
              <input v-model="importQuery" class="tool-input h-9 w-full pr-9 text-xs" placeholder="搜索标题、目录、Session ID 或首条消息" @input="scheduleImportSearch" />
              <PxIconButton v-if="importQuery" class="import-query-clear theme-muted-text absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" label="清空搜索" @click="clearImportQuery"><X class="h-3.5 w-3.5" /></PxIconButton>
              <LoaderCircle v-else-if="importLoading" class="theme-muted-text pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin" />
            </div>
            <div v-if="importError" class="error-row mt-3 rounded-sm border px-3 py-2 text-xs">{{ importError }}</div>
            <div class="relative mt-2 min-h-0 flex-1">
              <Transition name="import-state" mode="out-in">
                <div v-if="importLoading && !importSessions.length" key="loading" class="theme-muted-text flex h-full min-h-0 items-center justify-center text-xs"><LoaderCircle class="mr-2 h-4 w-4 animate-spin" />正在扫描本机 Provider 会话</div>
                <div v-else-if="!importSessions.length" key="empty" class="theme-muted-text flex h-full min-h-0 items-center justify-center text-xs">没有可导入的会话</div>
                <div v-else key="results" class="h-full min-h-0">
                  <TransitionGroup name="import-session" tag="div" class="h-full min-h-0 space-y-1 overflow-y-auto pr-1">
                    <button v-for="session in importSessions" :key="`${session.providerId}:${session.providerHandleId}`" type="button" class="import-session-row flex w-full min-w-0 items-center gap-3 rounded-sm border px-3 py-2 text-left" :disabled="Boolean(importingId)" @click="importSession(session)">
                      <span class="import-provider-mark flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold">{{ providerLabel(session.providerId).slice(0, 1) }}</span>
                      <span class="min-w-0 flex-1">
                        <span class="flex items-center gap-2"><span class="truncate text-xs font-medium">{{ session.title }}</span><span class="theme-muted-text shrink-0 text-[10px]">{{ providerLabel(session.providerId) }}</span><span class="theme-muted-text ml-auto shrink-0 text-[10px]">{{ formatImportActivity(session.lastActivityAt) }}</span></span>
                        <span class="theme-muted-text mt-0.5 block truncate font-mono text-[10px]" :title="session.cwd || '未记录工作目录，将使用当前项目目录'">{{ session.cwd || '未记录工作目录，将使用当前项目目录' }}</span>
                        <span class="theme-muted-text mt-0.5 block truncate font-mono text-[10px]" :title="session.providerHandleId">Session ID: {{ session.providerHandleId }}</span>
                        <span class="theme-muted-text mt-0.5 block truncate text-[11px]">{{ session.lastPromptPreview || session.firstPromptPreview }}</span>
                      </span>
                      <LoaderCircle v-if="importingId === session.providerHandleId" class="theme-muted-text h-4 w-4 shrink-0 animate-spin" />
                      <span v-else class="theme-muted-text shrink-0 text-[10px]">导入</span>
                    </button>
                  </TransitionGroup>
                  <div v-if="importLoading" class="import-list-loading theme-muted-text pointer-events-none absolute inset-x-0 top-0 flex h-9 items-center justify-center text-[10px]"><LoaderCircle class="mr-1.5 h-3 w-3 animate-spin" />正在更新</div>
                </div>
              </Transition>
            </div>
          </section>
        </div>
      </div>
    </PxDialog>

    <ConfirmDialog
      :open="confirmation.open"
      :title="confirmation.title"
      :description="confirmation.description"
      :confirm-text="confirmation.confirmText"
      :danger="confirmation.danger"
      @cancel="cancelConfirmation"
      @confirm="acceptConfirmation"
    />
  </div>
</template>

<style scoped>
.v2-shell { grid-template-columns: 240px minmax(0, 1fr); }
.v2-loading-skeleton { background: var(--theme-appPanel); color: var(--theme-textMuted); }
.v2-loading-skeleton > div { border-color: var(--theme-borderDefault); }
.skeleton-line { border-radius: 2px; background: var(--theme-appPanelInset); opacity: 0.72; animation: skeleton-pulse 1.2s ease-in-out infinite; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 0.48; } 50% { opacity: 0.88; } }
.timeline-loading-overlay { background: color-mix(in srgb, var(--theme-appPanel) 84%, transparent); }
.v2-shell :deep(.workspace-inspector), .v2-shell :deep(.task-details-drawer) { bottom: 0; left: 240px; position: absolute; right: 0; top: 3.5rem; z-index: 20; }
.workspace-sidebar, header, footer, .composer-wrap { border-color: var(--theme-borderDefault); }
.brand-mark { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action { justify-content: flex-start; background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action:hover { filter: brightness(0.96); }
.sidebar-secondary-action { justify-content: flex-start; color: var(--theme-textMuted); }
.sidebar-secondary-action:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.workspace-heading:hover, .agent-row:hover { background: var(--theme-appPanelHover); }
.workspace-active { color: var(--theme-text); }
.task-navigation:focus-visible { outline: 1px solid var(--theme-focusRing); outline-offset: -1px; }
.workspace-toggle, .workspace-action, .agent-action { color: var(--theme-textMuted); }
.workspace-action, .agent-action { border: 0; background: transparent; }
.workspace-agents-enter-active, .workspace-agents-leave-active {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transition: grid-template-rows 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease;
}
.workspace-agents-enter-from, .workspace-agents-leave-to { grid-template-rows: 0fr; opacity: 0; }
.workspace-agents-wrapper { min-height: 0; }
.workspace-agents-wrapper > .agent-list { min-height: 0; overflow: hidden; }
.settings-entry { justify-content: flex-start; color: var(--theme-textMuted); }
.settings-entry:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.workspace-toggle:hover, .workspace-action:hover, .agent-action:hover { color: var(--theme-text); }
.workspace-action, .agent-action { opacity: 0; }
.workspace-heading:hover .workspace-action,
.workspace-heading:focus-within .workspace-action,
.agent-row:hover .agent-action,
.agent-row:focus-within .agent-action { opacity: 1; }
.task-rename-input { border-color: var(--theme-inputBorder); background: var(--theme-inputBg); color: var(--theme-textPrimary); }
.task-rename-input:focus { border-color: var(--theme-borderStrong); box-shadow: 0 0 0 1px var(--theme-focusRing); }
.agent-dot-finished { background: var(--theme-success); }
.agent-dot-failed { background: var(--theme-danger); }
.row-active { background: var(--theme-appPanelActive); }
.status-chip { color: var(--theme-textMuted); }
.status-dot { background: var(--theme-success); }
.status-dot-running { background: var(--theme-warning); }
.timeline { background: var(--theme-appPanel); }
.timeline-generating-slot { contain: layout; }
.timeline-generating-indicator { color: var(--theme-textMuted); font-size: 1.25rem; font-weight: 600; line-height: 0.75rem; opacity: 0; transition: opacity 150ms ease; }
.timeline-generating-indicator.is-visible { opacity: 1; }
.timeline-generating-dot { animation: timeline-generating-pulse 1.15s ease-in-out infinite; opacity: 0.28; }
.timeline-generating-dot:nth-child(2) { animation-delay: 160ms; }
.timeline-generating-dot:nth-child(3) { animation-delay: 320ms; }
@keyframes timeline-generating-pulse { 0%, 55%, 100% { opacity: 0.28; } 25% { opacity: 1; } }
.error-row { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.writer-blocked-row { border-color: var(--theme-warning); background: var(--theme-warningSoft); color: var(--theme-warningText); }
.sidebar-primary-action, .sidebar-secondary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-action, .settings-entry, .import-session-row, .import-provider-filter, .import-query-clear {
  transition: background-color 140ms ease, color 140ms ease, opacity 140ms ease, transform 140ms ease;
}
.import-session-row { border-color: var(--theme-borderDefault); }
.import-session-row:hover { background: var(--theme-appPanelHover); }
.import-provider-mark { background: var(--theme-appPanelInset); color: var(--theme-textMuted); }
.import-provider-list { border-color: var(--theme-borderDefault); }
.import-provider-filter { color: var(--theme-textMuted); }
.import-provider-filter:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.import-provider-filter.is-active { background: var(--theme-appPanelActive); color: var(--theme-textPrimary); }
.import-query-clear:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.import-list-loading { background: color-mix(in srgb, var(--theme-appPanel) 88%, transparent); }
.import-state-enter-active, .import-state-leave-active { transition: opacity 150ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.import-state-enter-from, .import-state-leave-to { opacity: 0; transform: translateY(4px); }
.import-session-enter-active, .import-session-leave-active { transition: opacity 160ms ease, transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.import-session-enter-from, .import-session-leave-to { opacity: 0; transform: translateY(5px); }
.import-session-move { transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1); }
.workspace-toggle:active, .workspace-action:active, .agent-action:active { transform: scale(0.9); }
.mobile-workspace-path { display: none; }
.drawer-trigger.is-active { background: var(--theme-accentSoft); color: var(--theme-accentText); }
.workspace-drawer-enter-active { transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease; }
.workspace-drawer-leave-active { transition: transform 180ms ease-in, opacity 150ms ease; }
.workspace-drawer-enter-from, .workspace-drawer-leave-to { transform: translateX(100%); opacity: 0.35; }
@media (prefers-reduced-motion: reduce) {
  .sidebar-primary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-action, .drawer-trigger,
  .workspace-sidebar, .timeline-pane, .workspace-drawer-enter-active, .workspace-drawer-leave-active,
  .workspace-agents-enter-active, .workspace-agents-leave-active,
  .import-session-row, .import-provider-filter, .import-query-clear,
  .import-state-enter-active, .import-state-leave-active,
  .import-session-enter-active, .import-session-leave-active, .import-session-move { transition: none; }
  .timeline-generating-indicator { transition: none; }
  .timeline-generating-dot { animation: none; opacity: 0.72; }
}
@media (max-width: 900px) {
  .v2-shell { grid-template-columns: 200px minmax(0, 1fr); }
  .v2-shell :deep(.workspace-inspector), .v2-shell :deep(.task-details-drawer) { left: 200px; }
}
@media (max-width: 720px) {
  .v2-loading-skeleton { display: block; }
  .v2-loading-skeleton > div:first-child { display: none; }
  .v2-loading-skeleton > div:last-child { height: 100%; }
  .v2-shell { display: block; border: 0; border-radius: 0; }
  .workspace-sidebar, .timeline-pane {
    position: absolute;
    inset: 0;
    width: 100%;
    background: var(--theme-appPanel);
    transition: transform 220ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 180ms ease;
  }
  .workspace-sidebar { z-index: 1; border-right: 0; }
  .timeline-pane { z-index: 2; }
  .workspace-sidebar.mobile-panel-hidden { transform: translateX(-18%); opacity: 0.78; pointer-events: none; }
  .timeline-pane.mobile-panel-hidden { transform: translateX(100%); pointer-events: none; }
  .mobile-panel-active { transform: translateX(0); opacity: 1; pointer-events: auto; }
  .mobile-back-button { display: inline-flex; }
  .mobile-workspace-path { display: block; }
  .v2-shell :deep(.workspace-inspector), .v2-shell :deep(.task-details-drawer) { left: 0; }
  .workspace-action, .agent-action { opacity: 1; }
  .status-text { display: none; }
}

@media (min-width: 721px) {
  .mobile-back-button { display: none; }
}
</style>
