<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { projectTimelineRows } from '@promptx/protocol/timeline-projection'
import { ArrowDown, ArrowLeft, Bot, CircleAlert, FileDiff, Files, Folder, FolderOpen, LoaderCircle, Plus, Search, Settings, TerminalSquare, Trash2, X } from 'lucide-vue-next'
import { v2Api, agentEventsUrl, globalEventsUrl } from '../lib/v2Api.js'
import { createEventSource } from '../lib/eventSource.js'
import { createMobileDialogHistoryState, getMobileDialogHistoryState } from '../lib/mobileDialogHistory.js'
import { createMobileTimelineHistoryState, hasMobileTimelineHistoryState } from '../lib/mobileTimelineHistory.js'
import { isTimelineAtBottom } from '../lib/timelineViewport.js'
import { createTurnTimingMap, groupTimelineTurns, isTimelineTurnRunning } from '../lib/timelinePresentation.js'
import { useTheme } from '../composables/useTheme.js'
import AgentComposer from '../components/AgentComposer.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import DialogShell from '../components/DialogShell.vue'
import SessionTitleMarquee from '../components/SessionTitleMarquee.vue'
import TimelineTurn from '../components/TimelineTurn.vue'
import V2SettingsDialog from '../components/V2SettingsDialog.vue'
import WorkspaceInspector from '../components/WorkspaceInspector.vue'

const { isDark } = useTheme()
const workspaces = ref([])
const providers = ref([])
const agentsByWorkspace = ref({})
const expandedWorkspaceIds = ref(new Set())
const rows = ref([])
const turns = ref([])
const draftContent = ref([])
const activeWorkspaceId = ref('')
const activeAgentId = ref('')
const displayedAgentId = ref('')
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
const workspacePath = ref('')
const workspacePathInput = ref(null)
const directorySuggestions = ref([])
const directorySearchLoading = ref(false)
const directorySearchError = ref('')
const directorySuggestionsOpen = ref(false)
const selectedDirectoryIndex = ref(-1)
const agentProvider = ref('codex')
const creating = ref(false)
const confirmation = ref({ open: false, title: '', description: '', confirmText: '', danger: false, resolve: null })
const timelineElement = ref(null)
const workspaceInspector = ref(null)
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
const draftsByAgent = new Map()
const MAX_TIMELINE_CACHE_SIZE = 10
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

const activeWorkspace = computed(() => workspaces.value.find((item) => item.id === activeWorkspaceId.value))
const activeWorkspaceDirectoryName = computed(() => {
  const cwd = String(activeWorkspace.value?.cwd || '').replace(/[\\/]+$/, '')
  return cwd.split(/[\\/]/).pop() || activeWorkspace.value?.title || ''
})
const agents = computed(() => agentsForWorkspace(activeWorkspaceId.value))
const activeAgent = computed(() => agents.value.find((item) => item.id === activeAgentId.value))
const isRunning = computed(() => activeAgent.value?.lifecycle === 'running')
const entries = computed(() => groupTimelineTurns(projectTimelineRows(rows.value)))
const turnTimings = computed(() => createTurnTimingMap(rows.value, turns.value))
const latestTurnId = computed(() => rows.value.findLast((row) => row.turnId)?.turnId || '')
const timelineHasContent = computed(() => displayedAgentId.value === activeAgentId.value && Boolean(timelineEpoch.value || rows.value.length || turns.value.length))

function agentsForWorkspace(workspaceId) {
  return agentsByWorkspace.value[workspaceId] || []
}

function setWorkspaceAgents(workspaceId, nextAgents) {
  agentsByWorkspace.value = { ...agentsByWorkspace.value, [workspaceId]: nextAgents }
}

function upsertAgent(agent) {
  if (!agent?.workspaceId) return
  const workspaceAgents = agentsForWorkspace(agent.workspaceId)
  const index = workspaceAgents.findIndex((item) => item.id === agent.id)
  const nextAgents = [...workspaceAgents]
  if (index >= 0) nextAgents[index] = agent
  else nextAgents.unshift(agent)
  setWorkspaceAgents(agent.workspaceId, nextAgents)
}

function setWorkspaceExpanded(workspaceId, expanded = true) {
  const next = new Set(expandedWorkspaceIds.value)
  if (expanded) next.add(workspaceId)
  else next.delete(workspaceId)
  expandedWorkspaceIds.value = next
}

function toggleWorkspace(workspaceId) {
  setWorkspaceExpanded(workspaceId, !expandedWorkspaceIds.value.has(workspaceId))
}

function handleWorkspaceRowClick(workspace) {
  toggleWorkspace(workspace.id)
}

function providerLabel(providerId) {
  return providers.value.find((provider) => provider.id === providerId)?.label || providerId
}

function formatImportActivity(value) {
  const timestamp = Date.parse(String(value || ''))
  if (!Number.isFinite(timestamp)) return '更新时间未知'
  return `最近更新 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)}`
}

function agentStatusClass(agent) {
  if (agent.id === activeAgentId.value || !agent.requiresAttention) return ''
  if (agent.attentionReason === 'error') return 'agent-dot-failed'
  if (agent.attentionReason === 'finished') return 'agent-dot-finished'
  return ''
}

function clearViewedAgentAttention(agent) {
  if (!agent || agent.id !== activeAgentId.value || !agent.requiresAttention || attentionClearPending.has(agent.id)) return
  attentionClearPending.add(agent.id)
  v2Api.clearAgentAttention(agent.id)
    .then(({ agent: updated }) => upsertAgent(updated))
    .catch((cause) => { error.value = cause.message })
    .finally(() => attentionClearPending.delete(agent.id))
}

function applyAgentEvent(agent) {
  const isActiveAgent = agent?.id === activeAgentId.value
  const wasRunning = isActiveAgent && (isRunning.value || sending.value)
  const shouldPinAfterCompletion = wasRunning && agent.lifecycle !== 'running' && followingTimeline.value
  upsertAgent(agent)
  if (!isActiveAgent) return
  clearViewedAgentAttention(agent)
  sending.value = agent.lifecycle === 'running'
  reconcileTerminalAgentTurns(agent)
  if (shouldPinAfterCompletion) {
    pinTimelineToBottom(timelineRequestVersion)
    scrollToBottom({ force: true })
  }
}

function cacheTimeline(agentId = displayedAgentId.value || activeAgentId.value) {
  if (!agentId || displayedAgentId.value !== agentId || !timelineEpoch.value) return
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
  displayedAgentId.value = agentId
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
  activeAgentId.value = ''
  displayedAgentId.value = ''
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

function saveAgentDraft(content) {
  const agentId = activeAgentId.value
  if (!agentId) return
  const snapshot = Array.isArray(content) ? content.map((item) => ({ ...item })) : []
  draftsByAgent.set(agentId, snapshot)
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

async function reconcileTerminalAgentTurns(agent) {
  if (!agent || agent.id !== activeAgentId.value || agent.lifecycle === 'running') return
  if (!turns.value.some((turn) => ['queued', 'running'].includes(turn.status))) return
  if (turnReconcilePending.has(agent.id)) return

  const requestVersion = timelineRequestVersion
  turnReconcilePending.add(agent.id)
  try {
    const result = await v2Api.listTurns(agent.id, 1000)
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agent.id) {
      turns.value = result.turns
      cacheTimeline(agent.id)
    }
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agent.id) error.value = cause.message
  } finally {
    turnReconcilePending.delete(agent.id)
  }
}

async function loadInitial() {
  loading.value = true
  try {
    const [workspaceResult, providerResult] = await Promise.all([v2Api.listWorkspaces(), v2Api.listProviders()])
    workspaces.value = workspaceResult.workspaces
    providers.value = providerResult.providers
    const agentResults = await Promise.all(workspaces.value.map(async (workspace) => [
      workspace.id,
      (await v2Api.listAgents(workspace.id)).agents,
    ]))
    agentsByWorkspace.value = Object.fromEntries(agentResults)
    expandedWorkspaceIds.value = new Set(workspaces.value.map((workspace) => workspace.id))
    if (workspaces.value.length) await selectWorkspace(workspaces.value[0].id)
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

async function selectWorkspace(id, { navigate = false } = {}) {
  activeWorkspaceId.value = id
  setWorkspaceExpanded(id)
  if (!(id in agentsByWorkspace.value)) {
    const result = await v2Api.listAgents(id)
    setWorkspaceAgents(id, result.agents)
  }
  const workspaceAgents = agentsForWorkspace(id)
  if (workspaceAgents.length) await selectAgent(workspaceAgents[0].id, { navigate })
  else {
    resetTimelineSelection()
    positioningTimeline = false
  }
}

async function selectAgent(id, { navigate = false } = {}) {
  const agent = Object.values(agentsByWorkspace.value).flat().find((item) => item.id === id)
  if (!agent) return
  if (navigate) enterMobileTimeline()
  activeWorkspaceId.value = agent.workspaceId
  setWorkspaceExpanded(agent.workspaceId)
  const requestVersion = ++timelineRequestVersion
  releaseTimelineBottomPin()
  positioningTimeline = true
  activeAgentId.value = id
  draftContent.value = draftsByAgent.get(id)?.map((item) => ({ ...item })) || []
  const hasCachedTimeline = restoreTimelineCache(id)
  const cachedTimeline = timelineCache.get(id)
  if (!hasCachedTimeline) {
    displayedAgentId.value = ''
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
    const [result, turnResult] = await Promise.all([v2Api.getTimeline(id), v2Api.listTurns(id, 1000)])
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== id) return
    rows.value = result.timeline.rows
    turns.value = turnResult.turns
    timelineEpoch.value = result.timeline.epoch
    hasOlderHistory.value = result.timeline.hasOlder
    displayedAgentId.value = id
    cacheTimeline(id)
    pinTimelineToBottom(requestVersion)
    await scrollToBottom({ force: true })
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== id) return
    positioningTimeline = false
    closeEvents()
    openEvents(id, result.timeline.epoch, result.timeline.window.maxSeq)
    loadAgentControl(id, requestVersion)
    fillTimelineViewport()
  } catch (cause) {
    if (requestVersion === timelineRequestVersion) {
      timelineSyncError.value = cause.message
      if (!hasCachedTimeline) {
        displayedAgentId.value = ''
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

async function loadAgentControl(agentId, requestVersion = timelineRequestVersion) {
  try {
    const result = await v2Api.getAgentControl(agentId)
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agentId) agentControl.value = result.control
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agentId) error.value = cause.message
  }
}

async function loadOlderHistory() {
  const agentId = activeAgentId.value
  const epoch = timelineEpoch.value
  const beforeSeq = rows.value[0]?.seq
  if (!agentId || !epoch || !beforeSeq || !hasOlderHistory.value || loadingOlderHistory.value) return

  const requestVersion = timelineRequestVersion
  let shouldContinueFilling = false
  loadingOlderHistory.value = true
  try {
    const result = await v2Api.getTimeline(agentId, {
      direction: 'before',
      cursor: `${epoch}:${beforeSeq}`,
      limit: 300,
    })
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== agentId) return
    if (result.timeline.reset || result.timeline.epoch !== epoch) {
      await selectAgent(agentId)
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
  if (document.visibilityState !== 'visible' || !activeAgentId.value) return
  const now = Date.now()
  if (now - timelineWakeSyncAt < 2_000) return
  timelineWakeSyncAt = now
  const agentId = activeAgentId.value
  const requestVersion = timelineRequestVersion
  timelineSyncing.value = true
  timelineSyncError.value = ''
  try {
    let result
    try {
      result = await v2Api.syncTimeline(agentId)
    } catch (cause) {
      const statusCode = Number(cause?.statusCode || 0)
      const retryable = !statusCode || statusCode === 408 || statusCode === 429 || statusCode >= 500
      if (!retryable) throw cause
      await new Promise((resolve) => setTimeout(resolve, TIMELINE_SYNC_RETRY_DELAY))
      if (requestVersion !== timelineRequestVersion || activeAgentId.value !== agentId || document.visibilityState !== 'visible') return
      result = await v2Api.syncTimeline(agentId)
    }
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== agentId) return
    timelineSyncError.value = ''
    const { sync } = result
    if (sync?.turns) {
      turns.value = sync.turns
      cacheTimeline(agentId)
    }
  } catch (cause) {
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agentId) timelineSyncError.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion && activeAgentId.value === agentId) timelineSyncing.value = false
  }
}

function openEvents(agentId, epoch, seq) {
  eventSource = createEventSource(agentEventsUrl(agentId, seq ? `${epoch}:${seq}` : ''))
  eventSource.addEventListener('timeline', (event) => {
    if (activeAgentId.value !== agentId) return
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
    if (activeAgentId.value !== agentId) return
    const { agent } = JSON.parse(event.data)
    applyAgentEvent(agent)
  })
  eventSource.addEventListener('turn', (event) => {
    if (activeAgentId.value !== agentId) return
    const turn = JSON.parse(event.data).turn
    upsertTurn(turn)
    if (['completed', 'failed', 'canceled'].includes(turn.status)) scheduleInspectorRefresh()
  })
  eventSource.addEventListener('timeline-synced', (event) => {
    if (activeAgentId.value !== agentId) return
    const { sync } = JSON.parse(event.data)
    timelineSyncError.value = ''
    if (!sync?.turns) return
    turns.value = sync.turns
    cacheTimeline(agentId)
  })
  eventSource.addEventListener('control', (event) => {
    if (activeAgentId.value !== agentId) return
    agentControl.value = JSON.parse(event.data).control
  })
  eventSource.addEventListener('reset', (event) => {
    if (activeAgentId.value !== agentId) return
    const { timeline } = JSON.parse(event.data)
    rows.value = timeline.rows
    timelineEpoch.value = timeline.epoch
    hasOlderHistory.value = timeline.hasOlder
    displayedAgentId.value = agentId
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
    workspaceInspector.value?.refreshGit({ preserveDiff: true })
  }, 250)
}

async function openWorkspacePath(target) {
  drawerMode.value = target.intent === 'diff' ? 'diff' : 'files'
  await nextTick()
  workspaceInspector.value?.openPath(target)
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
  mobileView.value = hasMobileTimelineHistoryState(event.state) && activeAgentId.value
    ? 'timeline'
    : 'sidebar'
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && !dialog.value && drawerMode.value) drawerMode.value = null
}

function openGlobalEvents() {
  globalEventSource?.close()
  globalEventSource = createEventSource(globalEventsUrl())
  globalEventSource.addEventListener('agent', (event) => {
    const { agent } = JSON.parse(event.data)
    applyAgentEvent(agent)
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
}

async function searchDirectorySuggestions(query = workspacePath.value) {
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
  if (!workspacePath.value.trim()) {
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

async function openConversationDialog(workspace = null) {
  workspacePath.value = workspace?.cwd || ''
  agentProvider.value = providers.value.some((provider) => provider.id === 'codex')
    ? 'codex'
    : providers.value[0]?.id || ''
  directorySuggestions.value = []
  directorySearchError.value = ''
  directorySuggestionsOpen.value = false
  selectedDirectoryIndex.value = -1
  openManagedDialog('conversation')
  await nextTick()
  workspacePathInput.value?.focus()
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
      cwd: session.cwd || activeWorkspace.value?.cwd || '',
      title: session.title,
    })
    const agent = result.agent
    const workspace = result.workspace || workspaces.value.find((item) => item.id === agent.workspaceId)
    if (workspace && !workspaces.value.some((item) => item.id === workspace.id)) workspaces.value.push(workspace)
    upsertAgent(agent)
    await closeDialog()
    setWorkspaceExpanded(agent.workspaceId)
    await selectAgent(agent.id, { navigate: true })
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
  workspacePath.value = directory.path
  selectedDirectoryIndex.value = -1
  directorySuggestionsOpen.value = false
  workspacePathInput.value?.focus()
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
  creating.value = true
  error.value = ''
  try {
    const { workspace, agent } = await v2Api.createConversation({ cwd: workspacePath.value, providerId: agentProvider.value })
    if (!workspaces.value.some((item) => item.id === workspace.id)) workspaces.value.push(workspace)
    upsertAgent(agent)
    workspacePath.value = ''
    await closeDialog()
    setWorkspaceExpanded(workspace.id)
    await selectAgent(agent.id, { navigate: true })
  } catch (cause) {
    error.value = cause.message
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

async function removeAgent(agent) {
  if (!await requestConfirmation({
    title: `删除 Agent“${agent.title}”？`,
    description: '它的 Timeline 数据也会一并删除。',
    confirmText: '删除',
    danger: true,
  })) return
  const workspaceAgents = agentsForWorkspace(agent.workspaceId)
  const removedIndex = workspaceAgents.findIndex((item) => item.id === agent.id)
  try {
    await v2Api.deleteAgent(agent.id)
    clearTimelineCache(agent.id)
    draftsByAgent.delete(agent.id)
    const remainingAgents = workspaceAgents.filter((item) => item.id !== agent.id)
    setWorkspaceAgents(agent.workspaceId, remainingAgents)
    if (activeAgentId.value !== agent.id) return
    resetTimelineSelection()
    const fallback = remainingAgents[Math.min(removedIndex, remainingAgents.length - 1)]
    if (fallback) await selectAgent(fallback.id)
    else positioningTimeline = false
  } catch (cause) {
    error.value = cause.message
  }
}

async function removeWorkspace(workspace) {
  if (!await requestConfirmation({
    title: `移除工作区“${workspace.title}”？`,
    description: 'Agent 和 Timeline 数据会一并删除。',
    confirmText: '移除',
    danger: true,
  })) return
  await v2Api.deleteWorkspace(workspace.id)
  agentsForWorkspace(workspace.id).forEach((agent) => {
    clearTimelineCache(agent.id)
    draftsByAgent.delete(agent.id)
  })
  workspaces.value = workspaces.value.filter((item) => item.id !== workspace.id)
  const nextAgentsByWorkspace = { ...agentsByWorkspace.value }
  delete nextAgentsByWorkspace[workspace.id]
  agentsByWorkspace.value = nextAgentsByWorkspace
  setWorkspaceExpanded(workspace.id, false)
  if (activeWorkspaceId.value !== workspace.id) return
  resetTimelineSelection()
  activeWorkspaceId.value = ''
  if (workspaces.value.length) await selectWorkspace(workspaces.value[0].id)
  else positioningTimeline = false
}

async function submitPrompt(content) {
  if (!content.length || !activeAgentId.value || isRunning.value) return
  sending.value = true
  error.value = ''
  try {
    const result = await v2Api.startTurn(activeAgentId.value, content, crypto.randomUUID())
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
  if (!activeAgentId.value || settingsLoading.value || isRunning.value) return
  settingsLoading.value = true
  error.value = ''
  try {
    const result = await v2Api.updateAgentSettings(activeAgentId.value, input)
    upsertAgent(result.agent)
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
        <button class="sidebar-primary-action flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs font-medium" @click="openConversationDialog()">
          <Plus class="h-4 w-4 shrink-0" />
          <span>新对话</span>
        </button>
        <button class="sidebar-secondary-action mt-1 flex h-8 w-full items-center gap-2 rounded-sm px-2 text-left text-xs" @click="openImportDialog">
          <FolderOpen class="h-3.5 w-3.5 shrink-0" />
          <span>导入会话</span>
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="theme-muted-text flex h-8 items-center px-2 text-[10px] font-medium uppercase tracking-wide">工作区</div>
        <div v-for="workspace in workspaces" :key="workspace.id" class="workspace-group mb-2">
          <div class="workspace-heading group flex h-9 min-w-0 cursor-pointer items-center rounded-sm" :class="workspace.id === activeWorkspaceId ? 'workspace-active' : ''" @click="handleWorkspaceRowClick(workspace)">
            <button
              class="workspace-toggle round-icon-button flex h-7 w-7 shrink-0 items-center justify-center"
              :title="expandedWorkspaceIds.has(workspace.id) ? '收起工作区' : '展开工作区'"
              :aria-label="expandedWorkspaceIds.has(workspace.id) ? '收起工作区' : '展开工作区'"
              :aria-expanded="expandedWorkspaceIds.has(workspace.id)"
              @click.stop="toggleWorkspace(workspace.id)"
            >
              <FolderOpen v-if="expandedWorkspaceIds.has(workspace.id)" class="h-4 w-4" />
              <Folder v-else class="h-4 w-4" />
            </button>
            <button class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" :title="workspace.cwd" @click.stop="handleWorkspaceRowClick(workspace)">
              <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ workspace.title }}</span>
            </button>
            <button class="workspace-action round-icon-button flex h-7 w-7 shrink-0 items-center justify-center" :title="`在 ${workspace.title} 中新建对话`" @click.stop="openConversationDialog(workspace)"><Plus class="h-3.5 w-3.5" /></button>
            <button class="workspace-action workspace-delete round-icon-button flex h-7 w-7 shrink-0 items-center justify-center" :title="`移除 ${workspace.title}`" @click.stop="removeWorkspace(workspace)"><Trash2 class="h-3.5 w-3.5" /></button>
          </div>
          <Transition name="workspace-agents">
            <div v-if="expandedWorkspaceIds.has(workspace.id)" class="workspace-agents-wrapper">
              <div class="agent-list ml-6">
                <div v-for="agent in agentsForWorkspace(workspace.id)" :key="agent.id" class="agent-row group flex min-w-0 items-center rounded-sm" :class="agent.id === activeAgentId ? 'row-active' : ''">
                  <button class="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left" :title="`${agent.title} · ${providerLabel(agent.providerId)}`" @click="selectAgent(agent.id, { navigate: true })">
                    <span v-if="agentStatusClass(agent)" class="agent-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="agentStatusClass(agent)" />
                    <SessionTitleMarquee class="min-w-0 flex-1 text-xs" :title="agent.title" />
                    <LoaderCircle v-if="agent.lifecycle === 'running'" class="theme-muted-text h-3 w-3 shrink-0 animate-spin" />
                  </button>
                  <button class="agent-delete round-icon-button flex h-7 w-7 shrink-0 items-center justify-center" :title="`删除 ${agent.title}`" @click="removeAgent(agent)"><X class="h-3 w-3" /></button>
                </div>
                <button v-if="!agentsForWorkspace(workspace.id).length" class="theme-muted-text flex h-8 w-full items-center gap-2 px-2 text-left text-[10px]" @click="openConversationDialog(workspace)"><Plus class="h-3 w-3" />新对话</button>
              </div>
            </div>
          </Transition>
        </div>
        <div v-if="!workspaces.length && !loading" class="theme-muted-text px-3 py-8 text-center text-xs">还没有工作区</div>
      </div>
      <footer class="border-t p-2">
        <button class="settings-entry flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs font-medium" @click="openManagedDialog('settings')">
          <Settings class="h-4 w-4 shrink-0" />
          <span>设置</span>
        </button>
      </footer>
    </aside>

    <main
      class="timeline-pane flex min-h-0 min-w-0 flex-col"
      :class="mobileView === 'timeline' ? 'mobile-panel-active' : 'mobile-panel-hidden'"
      :inert="isMobile && mobileView !== 'timeline'"
      :aria-hidden="isMobile ? mobileView !== 'timeline' : undefined"
    >
      <header class="timeline-header flex h-14 shrink-0 items-center gap-2 border-b px-4">
        <button class="mobile-back-button quiet-icon-button h-8 w-8" title="返回项目列表" aria-label="返回项目列表" @click="showMobileSidebar">
          <ArrowLeft class="h-4 w-4" />
        </button>
        <div v-if="activeWorkspace" class="mobile-workspace-path min-w-0 flex-1" :title="activeWorkspace.cwd">
          <span class="block truncate text-sm font-medium">{{ activeWorkspaceDirectoryName }}</span>
        </div>
        <div class="ml-auto flex shrink-0 items-center gap-2">
          <div v-if="timelineSyncing" class="timeline-sync-status theme-muted-text flex h-8 w-8 items-center justify-center" title="正在同步 Timeline" aria-label="正在同步 Timeline"><LoaderCircle class="h-3.5 w-3.5 animate-spin" /></div>
          <div v-if="activeAgent" class="status-chip flex items-center gap-1.5 px-1 py-1 text-[10px]"><span class="status-dot h-1.5 w-1.5 rounded-full" :class="isRunning ? 'status-dot-running' : ''" /><span class="status-text">{{ isRunning ? '运行中' : '已连接' }}</span></div>
          <button v-if="activeWorkspace" class="drawer-trigger quiet-icon-button h-8 w-8" :class="drawerMode === 'files' ? 'is-active' : ''" :title="drawerMode === 'files' ? '关闭文件抽屉' : '浏览文件'" :aria-pressed="drawerMode === 'files'" @click="toggleDrawer('files')"><Files class="h-4 w-4" /></button>
          <button v-if="activeWorkspace" class="drawer-trigger quiet-icon-button h-8 w-8" :class="drawerMode === 'diff' ? 'is-active' : ''" :title="drawerMode === 'diff' ? '关闭 Diff 抽屉' : '查看 Diff'" :aria-pressed="drawerMode === 'diff'" @click="toggleDrawer('diff')"><FileDiff class="h-4 w-4" /></button>
        </div>
      </header>

      <div class="relative min-h-0 flex-1">
        <div ref="timelineElement" class="timeline h-full overflow-y-auto" @scroll.passive="handleTimelineScroll">
          <div v-if="timelineSyncError && !timelineHasContent" class="flex h-full items-center justify-center p-8 text-center"><div class="max-w-sm"><p class="error-row rounded-sm border px-3 py-2 text-left text-xs">Timeline 同步失败：{{ timelineSyncError }}</p><button class="tool-button mt-3 h-8 px-3 text-xs" @click="selectAgent(activeAgentId)">重试</button></div></div>
          <div v-else-if="!activeAgent || !entries.length" class="flex h-full items-center justify-center p-8 text-center"><div><Bot class="theme-muted-text mx-auto h-8 w-8" /><p class="mt-3 text-sm font-medium">{{ activeAgent ? '开始一段新的协作' : '新建一条对话' }}</p><p v-if="activeAgent" class="theme-muted-text mt-1 text-xs">消息会在当前工作区内执行</p></div></div>
          <div v-else class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <template v-for="entry in entries" :key="entry.key || `${entry.seqStart}-${entry.item?.type || ''}`">
              <TimelineTurn v-if="entry.presentationType === 'turn'" :turn="entry" :timing="turnTimings.get(entry.turnId)" :running="processIsRunning(entry)" :is-dark="isDark" :workspace-cwd="activeWorkspace?.cwd" @rendered="handleMarkdownRendered" @open-workspace-path="openWorkspacePath" />
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
          <div v-if="timelineSyncError && timelineHasContent" class="timeline-sync-error absolute left-1/2 top-3 z-10 flex -translate-x-1/2 items-center gap-2 rounded-full border px-3 py-2 text-xs shadow-sm" role="alert"><CircleAlert class="h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span>同步失败</span><button class="font-medium" @click="selectAgent(activeAgentId)">重试</button></div>
        </div>
        <div v-if="timelineLoading && !loading" class="timeline-loading-overlay absolute inset-0 z-10 flex items-start justify-center pt-16" role="status" aria-label="加载中">
          <div class="timeline-loading-indicator panel flex items-center gap-2 rounded-sm border px-3 py-2 text-xs shadow-sm">
            <LoaderCircle class="theme-muted-text h-3.5 w-3.5 animate-spin" />
            <span class="theme-muted-text">加载中</span>
          </div>
        </div>
        <div v-if="loadingOlderHistory" class="panel pointer-events-none absolute left-1/2 top-3 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-sm border shadow-sm" role="status" aria-label="正在加载更早记录">
          <LoaderCircle class="theme-muted-text h-3.5 w-3.5 animate-spin" />
        </div>
        <button
          v-if="!followingTimeline && timelineHasContent"
          class="timeline-jump-button tool-button round-icon-button absolute bottom-3 left-1/2 z-10 flex h-9 w-9 -translate-x-1/2 items-center justify-center p-0 shadow-sm"
          :title="hasNewTimelineItems ? '有新消息，回到底部' : '回到底部'"
          :aria-label="hasNewTimelineItems ? '有新消息，回到底部' : '回到底部'"
          @click="jumpToLatest"
        >
          <ArrowDown class="h-3.5 w-3.5" />
        </button>
      </div>

      <footer v-if="activeAgent" class="composer-wrap shrink-0 p-3 sm:p-4">
        <div v-if="error" class="error-row mx-auto mb-2 max-w-3xl rounded-sm border px-3 py-2 text-xs">{{ error }}</div>
        <div v-if="sendBlockedReason" class="writer-blocked-row mx-auto mb-2 flex max-w-3xl items-center justify-between gap-3 rounded-sm border px-3 py-2 text-xs">
          <span>{{ sendBlockedReason }}</span>
          <button type="button" class="shrink-0 font-medium" @click="sendBlockedReason = ''">重新尝试</button>
        </div>
        <AgentComposer
          :key="activeAgentId"
          :workspace-id="activeWorkspaceId"
          :running="isRunning"
          :sending="sending"
          :blocked-reason="sendBlockedReason"
          :control="agentControl"
          :settings-loading="settingsLoading"
          :draft-content="draftContent"
          :on-submit="submitPrompt"
          :on-settings-change="updateAgentSettings"
          @cancel="v2Api.cancel(activeAgentId)"
          @draft-change="saveAgentDraft"
        />
      </footer>
    </main>

    <Transition name="workspace-drawer">
      <WorkspaceInspector
        v-if="activeWorkspace"
        v-show="drawerMode"
        ref="workspaceInspector"
        :workspace-id="activeWorkspace.id"
        :workspace-cwd="activeWorkspace.cwd"
        :is-dark="isDark"
        :mode="drawerMode || 'files'"
        @close="drawerMode = null"
      />
    </Transition>

    <V2SettingsDialog :open="dialog === 'settings'" @close="closeDialog" />

    <DialogShell
      :open="dialog === 'conversation'"
      panel-class="new-conversation-panel h-[100dvh] max-w-none border-0 sm:h-[min(32rem,calc(100dvh-3rem))] sm:max-w-md sm:border"
      header-class="h-14 px-4 sm:px-5"
      body-class="flex min-h-0 flex-1 flex-col"
      @close="closeDialog"
    >
      <template #title><h2 class="text-sm font-semibold">新对话</h2></template>
      <form class="flex min-h-0 flex-1 flex-col px-4 pb-4" @submit.prevent="createConversation">
        <div class="shrink-0">
          <label class="theme-muted-text mt-4 block text-xs" for="conversation-provider">Provider</label>
          <select id="conversation-provider" v-model="agentProvider" class="tool-input mt-1" :disabled="creating">
            <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</option>
          </select>
        </div>
        <label class="theme-muted-text mt-4 block text-xs" for="workspace-path">路径</label>
        <div class="mt-1 flex min-h-0 flex-1 flex-col">
          <div class="relative shrink-0">
            <Search class="theme-muted-text pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2" />
            <input
              id="workspace-path"
              ref="workspacePathInput"
              v-model="workspacePath"
              class="tool-input w-full pl-9 pr-9 font-mono"
              placeholder="搜索目录名称或输入绝对路径"
              autocomplete="off"
              role="combobox"
              aria-controls="directory-suggestions"
              :aria-expanded="directorySuggestionsOpen"
              :aria-activedescendant="selectedDirectoryIndex >= 0 ? `directory-suggestion-${selectedDirectoryIndex}` : undefined"
              @input="scheduleDirectorySearch"
              @keydown="handleDirectoryKeydown"
            />
            <LoaderCircle v-if="directorySearchLoading" class="theme-muted-text pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin" />
          </div>
          <div
            v-if="directorySuggestionsOpen"
            id="directory-suggestions"
            class="directory-suggestions theme-popover mt-1.5 min-h-0 flex-1 overflow-y-auto rounded-sm border shadow-sm"
            role="listbox"
          >
            <button
              v-for="(directory, index) in directorySuggestions"
              :id="`directory-suggestion-${index}`"
              :key="directory.path"
              type="button"
              class="directory-suggestion flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left"
              :class="index === selectedDirectoryIndex ? 'row-active' : ''"
              role="option"
              :aria-selected="index === selectedDirectoryIndex"
              @mouseenter="selectedDirectoryIndex = index"
              @mousedown.prevent
              @click="selectDirectory(directory)"
            >
              <FolderOpen class="h-4 w-4 shrink-0" />
              <span class="min-w-0 flex-1">
                <span class="block truncate text-xs font-medium">{{ directory.name }}</span>
                <span class="theme-muted-text block truncate font-mono text-[10px]">{{ directory.path }}</span>
              </span>
            </button>
            <div v-if="directorySearchError" class="error-row m-2 rounded-sm border px-3 py-2 text-xs">{{ directorySearchError }}</div>
            <div v-else-if="!directorySearchLoading && !directorySuggestions.length" class="theme-muted-text px-3 py-5 text-center text-xs">没有找到匹配目录</div>
          </div>
          <div v-else class="min-h-0 flex-1" />
        </div>
        <div class="mt-4 flex shrink-0 justify-end"><button class="tool-button tool-button-primary h-9 gap-2 px-4 text-xs" :disabled="!workspacePath.trim() || !agentProvider || creating"><LoaderCircle v-if="creating" class="h-3.5 w-3.5 animate-spin" />创建对话</button></div>
      </form>
    </DialogShell>

    <DialogShell
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
            <button class="import-provider-filter flex h-8 items-center rounded-sm px-2 text-left text-xs" :class="!importProviderFilter ? 'is-active' : ''" @click="selectImportProvider('')">全部 Provider</button>
            <button v-for="provider in providers" :key="provider.id" class="import-provider-filter flex h-8 items-center rounded-sm px-2 text-left text-xs" :class="importProviderFilter === provider.id ? 'is-active' : ''" @click="selectImportProvider(provider.id)">{{ provider.label }}</button>
          </aside>
          <section class="flex min-w-0 min-h-0 flex-1 flex-col">
            <div class="relative shrink-0">
              <input v-model="importQuery" class="tool-input h-9 w-full pr-9 text-xs" placeholder="搜索标题、目录、Session ID 或首条消息" @input="scheduleImportSearch" />
              <button v-if="importQuery" type="button" class="import-query-clear round-icon-button theme-muted-text absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center" title="清空搜索" aria-label="清空搜索" @click="clearImportQuery"><X class="h-3.5 w-3.5" /></button>
              <LoaderCircle v-else-if="importLoading" class="theme-muted-text pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin" />
            </div>
            <div v-if="importError" class="error-row mt-3 rounded-sm border px-3 py-2 text-xs">{{ importError }}</div>
            <div class="relative mt-2 min-h-0 flex-1">
              <Transition name="import-state" mode="out-in">
                <div v-if="importLoading && !importSessions.length" key="loading" class="theme-muted-text flex h-full min-h-0 items-center justify-center text-xs"><LoaderCircle class="mr-2 h-4 w-4 animate-spin" />正在扫描本机 Provider 会话</div>
                <div v-else-if="!importSessions.length" key="empty" class="theme-muted-text flex h-full min-h-0 items-center justify-center text-xs">没有可导入的会话</div>
                <div v-else key="results" class="h-full min-h-0">
                  <TransitionGroup name="import-session" tag="div" class="h-full min-h-0 space-y-1 overflow-y-auto pr-1">
                    <button v-for="session in importSessions" :key="`${session.providerId}:${session.providerHandleId}`" class="import-session-row flex w-full min-w-0 items-center gap-3 rounded-sm border px-3 py-2 text-left" :disabled="Boolean(importingId)" @click="importSession(session)">
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
    </DialogShell>

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
.v2-shell :deep(.workspace-inspector) { bottom: 0; left: 240px; position: absolute; right: 0; top: 3.5rem; z-index: 20; }
.workspace-sidebar, header, footer, .composer-wrap { border-color: var(--theme-borderDefault); }
.brand-mark { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action:hover { filter: brightness(0.96); }
.sidebar-secondary-action { color: var(--theme-textMuted); }
.sidebar-secondary-action:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.workspace-heading:hover, .agent-row:hover { background: var(--theme-appPanelHover); }
.workspace-active { color: var(--theme-text); }
.workspace-toggle, .workspace-action, .agent-delete { color: var(--theme-textMuted); }
.workspace-agents-enter-active, .workspace-agents-leave-active {
  display: grid;
  grid-template-rows: 1fr;
  opacity: 1;
  transition: grid-template-rows 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease;
}
.workspace-agents-enter-from, .workspace-agents-leave-to { grid-template-rows: 0fr; opacity: 0; }
.workspace-agents-wrapper { min-height: 0; }
.workspace-agents-wrapper > .agent-list { min-height: 0; overflow: hidden; }
.settings-entry { color: var(--theme-textMuted); }
.settings-entry:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.workspace-toggle:hover, .workspace-action:hover, .agent-delete:hover { color: var(--theme-text); }
.workspace-delete:hover, .agent-delete:hover { color: var(--theme-dangerText); }
.workspace-action, .agent-delete { opacity: 0; }
.workspace-heading:hover .workspace-action,
.workspace-heading:focus-within .workspace-action,
.agent-row:hover .agent-delete,
.agent-row:focus-within .agent-delete { opacity: 1; }
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
.directory-suggestions { background: var(--theme-appPanelStrong); border-color: var(--theme-borderDefault); }
.directory-suggestion:hover { background: var(--theme-appPanelHover); }
.sidebar-primary-action, .sidebar-secondary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-delete, .directory-suggestion, .settings-entry, .import-session-row, .import-provider-filter, .import-query-clear {
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
.workspace-toggle:active, .workspace-action:active, .agent-delete:active { transform: scale(0.9); }
.mobile-workspace-path { display: none; }
.drawer-trigger.is-active { background: var(--theme-accentSoft); color: var(--theme-accentText); }
.workspace-drawer-enter-active { transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease; }
.workspace-drawer-leave-active { transition: transform 180ms ease-in, opacity 150ms ease; }
.workspace-drawer-enter-from, .workspace-drawer-leave-to { transform: translateX(100%); opacity: 0.35; }
@media (prefers-reduced-motion: reduce) {
  .sidebar-primary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-delete, .directory-suggestion, .drawer-trigger,
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
  .v2-shell :deep(.workspace-inspector) { left: 200px; }
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
  .v2-shell :deep(.workspace-inspector) { left: 0; }
  .workspace-action, .agent-delete { opacity: 1; }
  .workspace-delete { display: none; }
  .status-text { display: none; }
}

@media (min-width: 721px) {
  .mobile-back-button { display: none; }
}
</style>
