<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { projectTimelineRows } from '@promptx/protocol/timeline-projection'
import { ArrowDown, ArrowLeft, Bot, ChevronRight, FileDiff, Files, FolderOpen, LoaderCircle, Plus, Search, Settings, TerminalSquare, Trash2, X } from 'lucide-vue-next'
import { v2Api, agentEventsUrl, globalEventsUrl } from '../lib/v2Api.js'
import { createEventSource } from '../lib/eventSource.js'
import { isTimelineAtBottom } from '../lib/timelineViewport.js'
import { createTurnTimingMap, groupTimelineTurns } from '../lib/timelinePresentation.js'
import { useTheme } from '../composables/useTheme.js'
import AgentComposer from '../components/AgentComposer.vue'
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
const activeWorkspaceId = ref('')
const activeAgentId = ref('')
const loading = ref(true)
const sending = ref(false)
const agentControl = ref(null)
const settingsLoading = ref(false)
const error = ref('')
const dialog = ref('')
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
const timelineElement = ref(null)
const workspaceInspector = ref(null)
const drawerMode = ref(null)
const mobileView = ref('sidebar')
const isMobile = ref(false)
let eventSource = null
let globalEventSource = null
let mobileMediaQuery = null
const attentionClearPending = new Set()
let timelineRequestVersion = 0
let positioningTimeline = false
let directorySearchTimer = null
let directorySearchController = null
let markdownScrollFrame = null
let inspectorRefreshTimer = null

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

function providerLabel(providerId) {
  return providers.value.find((provider) => provider.id === providerId)?.label || providerId
}

function workspaceInitial(workspace) {
  return String(workspace.title || workspace.cwd || 'W').trim().charAt(0).toUpperCase()
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

function resetTimelineSelection() {
  timelineRequestVersion += 1
  positioningTimeline = true
  activeAgentId.value = ''
  agentControl.value = null
  settingsLoading.value = false
  rows.value = []
  turns.value = []
  timelineEpoch.value = ''
  hasOlderHistory.value = false
  loadingOlderHistory.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  sending.value = false
  closeEvents()
}

function upsertTurn(turn) {
  if (!turn?.id) return
  const index = turns.value.findIndex((item) => item.id === turn.id)
  if (index >= 0) turns.value[index] = turn
  else turns.value.unshift(turn)
}

function processIsRunning(entry) {
  const timing = turnTimings.value.get(entry.turnId)
  return timing?.status === 'queued' || timing?.status === 'running'
    || ((isRunning.value || sending.value) && entry.turnId === latestTurnId.value)
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
  if (navigate) mobileView.value = 'timeline'
  activeWorkspaceId.value = agent.workspaceId
  setWorkspaceExpanded(agent.workspaceId)
  const requestVersion = ++timelineRequestVersion
  positioningTimeline = true
  activeAgentId.value = id
  agentControl.value = null
  settingsLoading.value = false
  closeEvents()
  rows.value = []
  turns.value = []
  timelineEpoch.value = ''
  hasOlderHistory.value = false
  loadingOlderHistory.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  try {
    const [result, turnResult] = await Promise.all([v2Api.getTimeline(id), v2Api.listTurns(id, 1000)])
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== id) return
    rows.value = result.timeline.rows
    turns.value = turnResult.turns
    timelineEpoch.value = result.timeline.epoch
    hasOlderHistory.value = result.timeline.hasOlder
    await scrollToBottom({ force: true })
    if (requestVersion !== timelineRequestVersion || activeAgentId.value !== id) return
    positioningTimeline = false
    openEvents(id, result.timeline.epoch, result.timeline.window.maxSeq)
    loadAgentControl(id, requestVersion)
    fillTimelineViewport()
  } catch (cause) {
    if (requestVersion === timelineRequestVersion) error.value = cause.message
  } finally {
    if (requestVersion === timelineRequestVersion) positioningTimeline = false
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

function handleTimelineScroll(event) {
  if (positioningTimeline) return
  const element = event.currentTarget
  const atBottom = isTimelineAtBottom(element)
  followingTimeline.value = atBottom
  if (atBottom) hasNewTimelineItems.value = false
  if (element.scrollTop <= 64) loadOlderHistory()
}

function openEvents(agentId, epoch, seq) {
  eventSource = createEventSource(agentEventsUrl(agentId, seq ? `${epoch}:${seq}` : ''))
  eventSource.addEventListener('timeline', (event) => {
    const { row } = JSON.parse(event.data)
    if (rows.value.some((item) => item.seq === row.seq)) return
    const shouldFollow = isTimelineAtBottom(timelineElement.value)
    rows.value.push(row)
    if (row.item?.type === 'tool_call' && ['completed', 'failed', 'canceled'].includes(row.item.status)) scheduleInspectorRefresh()
    followingTimeline.value = shouldFollow
    if (shouldFollow) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
  eventSource.addEventListener('agent', (event) => {
    const { agent } = JSON.parse(event.data)
    upsertAgent(agent)
    clearViewedAgentAttention(agent)
    sending.value = agent.lifecycle === 'running'
  })
  eventSource.addEventListener('turn', (event) => {
    const turn = JSON.parse(event.data).turn
    upsertTurn(turn)
    if (['completed', 'failed', 'canceled'].includes(turn.status)) scheduleInspectorRefresh()
  })
  eventSource.addEventListener('control', (event) => {
    agentControl.value = JSON.parse(event.data).control
  })
  eventSource.addEventListener('reset', (event) => {
    const { timeline } = JSON.parse(event.data)
    rows.value = timeline.rows
    timelineEpoch.value = timeline.epoch
    hasOlderHistory.value = timeline.hasOlder
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
  mobileView.value = 'sidebar'
}

function handleGlobalKeydown(event) {
  if (event.key === 'Escape' && !dialog.value && drawerMode.value) drawerMode.value = null
}

function openGlobalEvents() {
  globalEventSource?.close()
  globalEventSource = createEventSource(globalEventsUrl())
  globalEventSource.addEventListener('agent', (event) => {
    const { agent } = JSON.parse(event.data)
    upsertAgent(agent)
    clearViewedAgentAttention(agent)
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
  dialog.value = 'conversation'
  await nextTick()
  workspacePathInput.value?.focus()
}

function closeDialog() {
  cancelDirectorySearch()
  directorySuggestionsOpen.value = false
  dialog.value = ''
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
    closeDialog()
    setWorkspaceExpanded(workspace.id)
    await selectAgent(agent.id, { navigate: true })
  } catch (cause) {
    error.value = cause.message
  } finally {
    creating.value = false
  }
}

async function removeAgent(agent) {
  if (!window.confirm(`确定删除 Agent“${agent.title}”？它的 Timeline 数据也会一并删除。`)) return
  const workspaceAgents = agentsForWorkspace(agent.workspaceId)
  const removedIndex = workspaceAgents.findIndex((item) => item.id === agent.id)
  try {
    await v2Api.deleteAgent(agent.id)
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
  if (!window.confirm(`确定移除工作区“${workspace.title}”？Agent 和 Timeline 数据会一并删除。`)) return
  await v2Api.deleteWorkspace(workspace.id)
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
    upsertTurn(result.turn)
  } catch (cause) {
    error.value = cause.message
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
  followingTimeline.value = true
  hasNewTimelineItems.value = false
}

function jumpToLatest() {
  followingTimeline.value = true
  scrollToBottom({ force: true, behavior: 'smooth' })
}

function handleMarkdownRendered() {
  if (!followingTimeline.value || markdownScrollFrame) return
  markdownScrollFrame = requestAnimationFrame(() => {
    markdownScrollFrame = null
    scrollToBottom()
  })
}

function updateMobileState(event) {
  isMobile.value = event.matches
}

onMounted(async () => {
  window.addEventListener('keydown', handleGlobalKeydown)
  mobileMediaQuery = window.matchMedia('(max-width: 720px)')
  updateMobileState(mobileMediaQuery)
  mobileMediaQuery.addEventListener('change', updateMobileState)
  await loadInitial()
  openGlobalEvents()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleGlobalKeydown)
  mobileMediaQuery?.removeEventListener('change', updateMobileState)
  closeEvents()
  closeGlobalEvents()
  cancelDirectorySearch()
  if (markdownScrollFrame) cancelAnimationFrame(markdownScrollFrame)
  if (inspectorRefreshTimer) clearTimeout(inspectorRefreshTimer)
})
</script>

<template>
  <div class="v2-shell panel relative grid h-full min-h-0 overflow-hidden">
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
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="theme-muted-text flex h-8 items-center px-2 text-[10px] font-medium uppercase tracking-wide">工作区</div>
        <div v-for="workspace in workspaces" :key="workspace.id" class="workspace-group mb-2">
          <div class="workspace-heading group flex h-9 min-w-0 items-center rounded-sm" :class="workspace.id === activeWorkspaceId ? 'workspace-active' : ''">
            <button class="workspace-toggle flex h-7 w-6 shrink-0 items-center justify-center" :title="expandedWorkspaceIds.has(workspace.id) ? '收起工作区' : '展开工作区'" @click="toggleWorkspace(workspace.id)">
              <ChevronRight class="h-3.5 w-3.5 transition-transform" :class="expandedWorkspaceIds.has(workspace.id) ? 'rotate-90' : ''" />
            </button>
            <button class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" :title="workspace.cwd" @click="selectWorkspace(workspace.id)">
              <span class="workspace-mark flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold">{{ workspaceInitial(workspace) }}</span>
              <span class="min-w-0 flex-1 truncate text-xs font-medium">{{ workspace.title }}</span>
            </button>
            <button class="workspace-action flex h-7 w-7 shrink-0 items-center justify-center" :title="`在 ${workspace.title} 中新建对话`" @click="openConversationDialog(workspace)"><Plus class="h-3.5 w-3.5" /></button>
            <button class="workspace-action workspace-delete flex h-7 w-7 shrink-0 items-center justify-center" :title="`移除 ${workspace.title}`" @click="removeWorkspace(workspace)"><Trash2 class="h-3.5 w-3.5" /></button>
          </div>
          <div v-if="expandedWorkspaceIds.has(workspace.id)" class="agent-list ml-6 mt-0.5">
            <div v-for="agent in agentsForWorkspace(workspace.id)" :key="agent.id" class="agent-row group flex min-w-0 items-center rounded-sm" :class="agent.id === activeAgentId ? 'row-active' : ''">
              <button class="flex h-8 min-w-0 flex-1 items-center gap-2 px-2 text-left" :title="`${agent.title} · ${providerLabel(agent.providerId)}`" @click="selectAgent(agent.id, { navigate: true })">
                <span v-if="agentStatusClass(agent)" class="agent-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="agentStatusClass(agent)" />
                <SessionTitleMarquee class="min-w-0 flex-1 text-xs" :title="agent.title" />
                <LoaderCircle v-if="agent.lifecycle === 'running'" class="theme-muted-text h-3 w-3 shrink-0 animate-spin" />
              </button>
              <button class="agent-delete flex h-7 w-7 shrink-0 items-center justify-center" :title="`删除 ${agent.title}`" @click="removeAgent(agent)"><X class="h-3 w-3" /></button>
            </div>
            <button v-if="!agentsForWorkspace(workspace.id).length" class="theme-muted-text flex h-8 w-full items-center gap-2 px-2 text-left text-[10px]" @click="openConversationDialog(workspace)"><Plus class="h-3 w-3" />新对话</button>
          </div>
        </div>
        <div v-if="!workspaces.length && !loading" class="theme-muted-text px-3 py-8 text-center text-xs">还没有工作区</div>
      </div>
      <footer class="border-t p-2">
        <button class="settings-entry flex h-9 w-full items-center gap-2 rounded-sm px-2 text-left text-xs font-medium" @click="dialog = 'settings'">
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
          <div v-if="activeAgent" class="status-chip flex items-center gap-1.5 px-1 py-1 text-[10px]"><span class="status-dot h-1.5 w-1.5 rounded-full" :class="isRunning ? 'status-dot-running' : ''" /><span class="status-text">{{ isRunning ? '运行中' : '已连接' }}</span></div>
          <button v-if="activeWorkspace" class="drawer-trigger quiet-icon-button h-8 w-8" :class="drawerMode === 'files' ? 'is-active' : ''" :title="drawerMode === 'files' ? '关闭文件抽屉' : '浏览文件'" :aria-pressed="drawerMode === 'files'" @click="toggleDrawer('files')"><Files class="h-4 w-4" /></button>
          <button v-if="activeWorkspace" class="drawer-trigger quiet-icon-button h-8 w-8" :class="drawerMode === 'diff' ? 'is-active' : ''" :title="drawerMode === 'diff' ? '关闭 Diff 抽屉' : '查看 Diff'" :aria-pressed="drawerMode === 'diff'" @click="toggleDrawer('diff')"><FileDiff class="h-4 w-4" /></button>
        </div>
      </header>

      <div class="relative min-h-0 flex-1">
        <div ref="timelineElement" class="timeline h-full overflow-y-auto" @scroll.passive="handleTimelineScroll">
          <div v-if="!activeAgent || !entries.length" class="flex h-full items-center justify-center p-8 text-center"><div><Bot class="theme-muted-text mx-auto h-8 w-8" /><p class="mt-3 text-sm font-medium">{{ activeAgent ? '开始一段新的协作' : '新建一条对话' }}</p><p v-if="activeAgent" class="theme-muted-text mt-1 text-xs">消息会在当前工作区内执行</p></div></div>
          <div v-else class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <template v-for="entry in entries" :key="entry.key || `${entry.seqStart}-${entry.item?.type || ''}`">
              <TimelineTurn v-if="entry.presentationType === 'turn'" :turn="entry" :timing="turnTimings.get(entry.turnId)" :running="processIsRunning(entry)" :is-dark="isDark" :workspace-cwd="activeWorkspace?.cwd" @rendered="handleMarkdownRendered" @open-workspace-path="openWorkspacePath" />
              <article v-else-if="entry.item?.type === 'error'" class="error-row mb-5 ml-7 rounded-sm border px-3 py-2 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.message }}</article>
              <article v-else-if="entry.item?.type === 'system_notice'" class="theme-muted-text mb-5 ml-7 text-xs" :data-timeline-seq="entry.seqEnd">{{ entry.item.text }}</article>
            </template>
          </div>
        </div>
        <div v-if="loadingOlderHistory" class="panel pointer-events-none absolute left-1/2 top-3 z-10 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-sm border shadow-sm" role="status" aria-label="正在加载更早记录">
          <LoaderCircle class="theme-muted-text h-3.5 w-3.5 animate-spin" />
        </div>
        <button v-if="hasNewTimelineItems" class="new-message-button tool-button absolute bottom-3 left-1/2 z-10 h-9 -translate-x-1/2 gap-1.5 px-3 text-xs shadow-sm" @click="jumpToLatest"><ArrowDown class="h-3.5 w-3.5" />有新消息</button>
      </div>

      <footer v-if="activeAgent" class="composer-wrap shrink-0 border-t p-3 sm:p-4">
        <div v-if="error" class="error-row mx-auto mb-2 max-w-3xl rounded-sm border px-3 py-2 text-xs">{{ error }}</div>
        <AgentComposer
          :workspace-id="activeWorkspaceId"
          :running="isRunning"
          :sending="sending"
          :control="agentControl"
          :settings-loading="settingsLoading"
          :on-submit="submitPrompt"
          :on-settings-change="updateAgentSettings"
          @cancel="v2Api.cancel(activeAgentId)"
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

    <div v-if="dialog === 'conversation'" class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="closeDialog">
      <form class="panel w-full max-w-md p-4" @submit.prevent="createConversation">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">新对话</h2>
          <button type="button" class="quiet-icon-button h-8 w-8" title="关闭" @click="closeDialog"><X class="h-4 w-4" /></button>
        </div>
        <label class="theme-muted-text mt-4 block text-xs" for="workspace-path">路径</label>
        <div class="relative mt-1">
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
          <div
            v-if="directorySuggestionsOpen"
            id="directory-suggestions"
            class="directory-suggestions theme-popover absolute left-0 right-0 top-[calc(100%+0.375rem)] z-20 max-h-64 overflow-y-auto rounded-sm border shadow-lg"
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
        </div>
        <label class="theme-muted-text mt-4 block text-xs" for="conversation-provider">Provider</label>
        <select id="conversation-provider" v-model="agentProvider" class="tool-input mt-1" :disabled="creating">
          <option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</option>
        </select>
        <div class="mt-4 flex justify-end"><button class="tool-button tool-button-primary h-9 gap-2 px-4 text-xs" :disabled="!workspacePath.trim() || !agentProvider || creating"><LoaderCircle v-if="creating" class="h-3.5 w-3.5 animate-spin" />创建对话</button></div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.v2-shell { grid-template-columns: 240px minmax(0, 1fr); }
.v2-shell :deep(.workspace-inspector) { bottom: 0; left: 240px; position: absolute; right: 0; top: 3.5rem; z-index: 20; }
.workspace-sidebar, header, footer, .composer-wrap { border-color: var(--theme-borderDefault); }
.brand-mark { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action:hover { filter: brightness(0.96); }
.workspace-heading:hover, .agent-row:hover { background: var(--theme-appPanelHover); }
.workspace-active { color: var(--theme-text); }
.workspace-mark { background: var(--theme-appPanelInset); color: var(--theme-textMuted); }
.workspace-toggle, .workspace-action, .agent-delete { color: var(--theme-textMuted); }
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
.row-active { background: var(--theme-appPanelInset); }
.status-chip { color: var(--theme-textMuted); }
.status-dot { background: var(--theme-success); }
.status-dot-running { background: var(--theme-warning); }
.timeline { background: var(--theme-appPanel); }
.process-row { border-color: var(--theme-processBorder); background: var(--theme-processBg); color: var(--theme-processText); }
.error-row { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.composer-wrap { background: var(--theme-appPanelMuted); }
.modal-backdrop { background: var(--theme-modalBackdrop); }
.directory-suggestions { background: var(--theme-appPanelStrong); border-color: var(--theme-borderDefault); }
.directory-suggestion:hover { background: var(--theme-appPanelHover); }
.sidebar-primary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-delete, .directory-suggestion, .settings-entry {
  transition: background-color 140ms ease, color 140ms ease, opacity 140ms ease, transform 140ms ease;
}
.workspace-toggle:active, .workspace-action:active, .agent-delete:active { transform: scale(0.9); }
.mobile-workspace-path { display: none; }
.drawer-trigger.is-active { background: var(--theme-accentSoft); color: var(--theme-accentText); }
.workspace-drawer-enter-active { transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease; }
.workspace-drawer-leave-active { transition: transform 180ms ease-in, opacity 150ms ease; }
.workspace-drawer-enter-from, .workspace-drawer-leave-to { transform: translateX(100%); opacity: 0.35; }
@media (prefers-reduced-motion: reduce) {
  .sidebar-primary-action, .workspace-heading, .agent-row, .workspace-toggle, .workspace-action, .agent-delete, .directory-suggestion, .drawer-trigger,
  .workspace-sidebar, .timeline-pane, .workspace-drawer-enter-active, .workspace-drawer-leave-active { transition: none; }
}
@media (max-width: 900px) {
  .v2-shell { grid-template-columns: 200px minmax(0, 1fr); }
  .v2-shell :deep(.workspace-inspector) { left: 200px; }
}
@media (max-width: 720px) {
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
