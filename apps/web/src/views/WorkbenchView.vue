<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { projectTimelineRows } from '@promptx/protocol/timeline-projection'
import { ArrowDown, Bot, FolderOpen, LoaderCircle, Palette, Plus, Search, TerminalSquare, Trash2, X } from 'lucide-vue-next'
import { v2Api, agentEventsUrl } from '../lib/v2Api.js'
import { isTimelineAtBottom } from '../lib/timelineViewport.js'
import { createTurnTimingMap, groupTimelineTurns } from '../lib/timelinePresentation.js'
import { useTheme } from '../composables/useTheme.js'
import AgentComposer from '../components/AgentComposer.vue'
import TimelineTurn from '../components/TimelineTurn.vue'

const { currentTheme, isDark, setTheme, themes } = useTheme()
const workspaces = ref([])
const providers = ref([])
const agents = ref([])
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
const timelineElement = ref(null)
let eventSource = null
let timelineRequestVersion = 0
let positioningTimeline = false
let directorySearchTimer = null
let directorySearchController = null
let markdownScrollFrame = null

const activeWorkspace = computed(() => workspaces.value.find((item) => item.id === activeWorkspaceId.value))
const activeAgent = computed(() => agents.value.find((item) => item.id === activeAgentId.value))
const isRunning = computed(() => activeAgent.value?.lifecycle === 'running')
const entries = computed(() => groupTimelineTurns(projectTimelineRows(rows.value)))
const turnTimings = computed(() => createTurnTimingMap(rows.value, turns.value))
const latestTurnId = computed(() => rows.value.findLast((row) => row.turnId)?.turnId || '')

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
    if (workspaces.value.length) await selectWorkspace(workspaces.value[0].id)
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

async function selectWorkspace(id) {
  timelineRequestVersion += 1
  positioningTimeline = true
  activeWorkspaceId.value = id
  activeAgentId.value = ''
  agentControl.value = null
  rows.value = []
  turns.value = []
  timelineEpoch.value = ''
  hasOlderHistory.value = false
  loadingOlderHistory.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  closeEvents()
  const result = await v2Api.listAgents(id)
  agents.value = result.agents
  if (agents.value.length) await selectAgent(agents.value[0].id)
  else positioningTimeline = false
}

async function selectAgent(id) {
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
  eventSource = new EventSource(agentEventsUrl(agentId, seq ? `${epoch}:${seq}` : ''))
  eventSource.addEventListener('timeline', (event) => {
    const { row } = JSON.parse(event.data)
    if (rows.value.some((item) => item.seq === row.seq)) return
    const shouldFollow = isTimelineAtBottom(timelineElement.value)
    rows.value.push(row)
    followingTimeline.value = shouldFollow
    if (shouldFollow) scrollToBottom()
    else hasNewTimelineItems.value = true
  })
  eventSource.addEventListener('agent', (event) => {
    const { agent } = JSON.parse(event.data)
    const index = agents.value.findIndex((item) => item.id === agent.id)
    if (index >= 0) agents.value[index] = agent
    sending.value = agent.lifecycle === 'running'
  })
  eventSource.addEventListener('turn', (event) => {
    upsertTurn(JSON.parse(event.data).turn)
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
  if (directorySearchTimer) clearTimeout(directorySearchTimer)
  directorySearchController?.abort()
  directorySuggestionsOpen.value = true
  selectedDirectoryIndex.value = -1
  directorySearchTimer = setTimeout(() => {
    directorySearchTimer = null
    searchDirectorySuggestions()
  }, 250)
}

async function openWorkspaceDialog() {
  workspacePath.value = ''
  directorySuggestions.value = []
  directorySearchError.value = ''
  directorySuggestionsOpen.value = true
  selectedDirectoryIndex.value = -1
  dialog.value = 'workspace'
  await nextTick()
  workspacePathInput.value?.focus()
  searchDirectorySuggestions('')
}

function closeWorkspaceDialog() {
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

async function createWorkspace() {
  try {
    const { workspace } = await v2Api.createWorkspace({ cwd: workspacePath.value })
    if (!workspaces.value.some((item) => item.id === workspace.id)) workspaces.value.push(workspace)
    workspacePath.value = ''
    closeWorkspaceDialog()
    await selectWorkspace(workspace.id)
  } catch (cause) {
    error.value = cause.message
  }
}

async function removeAgent(agent) {
  if (!window.confirm(`确定删除 Agent“${agent.title}”？它的 Timeline 数据也会一并删除。`)) return
  const removedIndex = agents.value.findIndex((item) => item.id === agent.id)
  try {
    await v2Api.deleteAgent(agent.id)
    agents.value = agents.value.filter((item) => item.id !== agent.id)
    if (activeAgentId.value !== agent.id) return
    closeEvents()
    timelineRequestVersion += 1
    activeAgentId.value = ''
    agentControl.value = null
    rows.value = []
    turns.value = []
    timelineEpoch.value = ''
    hasOlderHistory.value = false
    followingTimeline.value = true
    hasNewTimelineItems.value = false
    sending.value = false
    const fallback = agents.value[Math.min(removedIndex, agents.value.length - 1)]
    if (fallback) await selectAgent(fallback.id)
  } catch (cause) {
    error.value = cause.message
  }
}

async function createAgent() {
  try {
    const provider = providers.value.find((item) => item.id === agentProvider.value)
    const { agent } = await v2Api.createAgent(activeWorkspaceId.value, { providerId: agentProvider.value, title: `${provider?.label || agentProvider.value} Agent` })
    agents.value.unshift(agent)
    dialog.value = ''
    await selectAgent(agent.id)
  } catch (cause) {
    error.value = cause.message
  }
}

async function removeWorkspace(workspace) {
  if (!window.confirm(`确定移除工作区“${workspace.title}”？Agent 和 Timeline 数据会一并删除。`)) return
  await v2Api.deleteWorkspace(workspace.id)
  workspaces.value = workspaces.value.filter((item) => item.id !== workspace.id)
  if (activeWorkspaceId.value !== workspace.id) return
  closeEvents()
  timelineRequestVersion += 1
  agents.value = []
  rows.value = []
  turns.value = []
  timelineEpoch.value = ''
  hasOlderHistory.value = false
  loadingOlderHistory.value = false
  followingTimeline.value = true
  hasNewTimelineItems.value = false
  activeWorkspaceId.value = ''
  activeAgentId.value = ''
  agentControl.value = null
  if (workspaces.value.length) await selectWorkspace(workspaces.value[0].id)
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
    const index = agents.value.findIndex((agent) => agent.id === result.agent.id)
    if (index >= 0) agents.value[index] = result.agent
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

function cycleTheme() {
  const index = themes.value.findIndex((item) => item.id === currentTheme.value.id)
  setTheme(themes.value[(index + 1) % themes.value.length].id)
}

onMounted(loadInitial)
onBeforeUnmount(() => {
  closeEvents()
  cancelDirectorySearch()
  if (markdownScrollFrame) cancelAnimationFrame(markdownScrollFrame)
})
</script>

<template>
  <div class="v2-shell panel grid h-full min-h-0 overflow-hidden">
    <aside class="workspace-sidebar flex min-h-0 flex-col border-r">
      <header class="flex h-14 shrink-0 items-center justify-between border-b px-3">
        <div class="flex min-w-0 items-center gap-2">
          <div class="brand-mark flex h-7 w-7 items-center justify-center rounded-sm"><TerminalSquare class="h-4 w-4" /></div>
          <span class="text-sm font-semibold">PromptX</span><span class="theme-muted-text text-[10px]">V2</span>
        </div>
        <button class="tool-button h-8 w-8" title="新增工作区" @click="openWorkspaceDialog"><Plus class="h-4 w-4" /></button>
      </header>
      <div class="min-h-0 flex-1 overflow-y-auto p-2">
        <button v-for="workspace in workspaces" :key="workspace.id" class="workspace-row group mb-1 flex w-full items-center gap-2 rounded-sm px-2 py-2 text-left" :class="workspace.id === activeWorkspaceId ? 'row-active' : ''" @click="selectWorkspace(workspace.id)">
          <FolderOpen class="h-4 w-4 shrink-0" />
          <span class="row-copy min-w-0 flex-1"><span class="block truncate text-xs font-medium">{{ workspace.title }}</span><span class="theme-muted-text block truncate font-mono text-[10px]">{{ workspace.cwd }}</span></span>
          <span class="row-action h-6 w-6 items-center justify-center" title="移除工作区" @click.stop="removeWorkspace(workspace)"><Trash2 class="h-3.5 w-3.5" /></span>
        </button>
        <div v-if="!workspaces.length && !loading" class="theme-muted-text px-3 py-8 text-center text-xs">还没有工作区</div>
      </div>
      <footer class="flex items-center justify-between border-t p-2"><span class="theme-muted-text truncate px-1 text-[10px]">{{ currentTheme.shortName }}</span><button class="tool-button h-8 w-8" title="切换主题" @click="cycleTheme"><Palette class="h-4 w-4" /></button></footer>
    </aside>

    <main class="flex min-h-0 min-w-0 flex-col">
      <header class="flex h-14 shrink-0 items-center justify-between border-b px-4">
        <div class="min-w-0 flex-1">
          <div class="truncate text-sm font-semibold">{{ activeWorkspace?.title || '选择一个工作区' }}</div>
          <div v-if="activeWorkspace" class="theme-muted-text truncate font-mono text-[10px]">{{ activeWorkspace.cwd }}</div>
        </div>
        <div class="flex items-center gap-2">
          <div v-if="activeAgent" class="status-chip flex items-center gap-1.5 rounded-sm border px-2 py-1 text-[10px]"><span class="status-dot h-1.5 w-1.5 rounded-full" :class="isRunning ? 'status-dot-running' : ''" /><span class="status-text">{{ isRunning ? '运行中' : '已连接' }}</span></div>
        </div>
      </header>

      <div v-if="activeWorkspace" class="agent-tabs flex h-10 shrink-0 items-center border-b px-1">
        <div class="min-w-0 flex-1 overflow-x-auto">
          <div class="flex min-w-max items-center gap-1 px-1">
            <div v-for="agent in agents" :key="agent.id" class="agent-tab group flex h-8 max-w-44 items-center rounded-sm" :class="agent.id === activeAgentId ? 'row-active' : ''">
              <button class="flex min-w-0 flex-1 items-center gap-1.5 py-1 pl-2 text-left" :title="agent.title" @click="selectAgent(agent.id)">
                <span class="provider-mark flex h-5 w-5 shrink-0 items-center justify-center rounded-sm text-[8px] font-semibold">{{ agent.providerId.slice(0, 2).toUpperCase() }}</span>
                <span class="truncate text-xs font-medium">{{ agent.title }}</span>
                <LoaderCircle v-if="agent.lifecycle === 'running'" class="theme-muted-text h-3 w-3 shrink-0 animate-spin" />
              </button>
              <button class="agent-close flex h-7 w-7 shrink-0 items-center justify-center" :title="`删除 ${agent.title}`" @click="removeAgent(agent)"><X class="h-3 w-3" /></button>
            </div>
            <button class="tool-button h-8 w-8 shrink-0" title="新建 Agent" @click="dialog = 'agent'"><Plus class="h-4 w-4" /></button>
          </div>
        </div>
      </div>

      <div class="relative min-h-0 flex-1">
        <div ref="timelineElement" class="timeline h-full overflow-y-auto" @scroll.passive="handleTimelineScroll">
          <div v-if="!activeAgent || !entries.length" class="flex h-full items-center justify-center p-8 text-center"><div><Bot class="theme-muted-text mx-auto h-8 w-8" /><p class="mt-3 text-sm font-medium">{{ activeAgent ? '开始一段新的协作' : (activeWorkspace ? '创建第一个 Agent' : '添加一个工作区') }}</p><p v-if="activeAgent" class="theme-muted-text mt-1 text-xs">消息会在当前工作区内执行</p></div></div>
          <div v-else class="mx-auto w-full max-w-3xl px-4 py-6 sm:px-6">
            <template v-for="entry in entries" :key="entry.key || `${entry.seqStart}-${entry.item?.type || ''}`">
              <TimelineTurn v-if="entry.presentationType === 'turn'" :turn="entry" :timing="turnTimings.get(entry.turnId)" :running="processIsRunning(entry)" :is-dark="isDark" @rendered="handleMarkdownRendered" />
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

    <div v-if="dialog" class="modal-backdrop fixed inset-0 z-50 flex items-center justify-center p-4" @click.self="dialog === 'workspace' ? closeWorkspaceDialog() : (dialog = '')">
      <form v-if="dialog === 'workspace'" class="panel w-full max-w-md p-4" @submit.prevent="createWorkspace">
        <div class="flex items-center justify-between">
          <h2 class="text-sm font-semibold">添加工作区</h2>
          <button type="button" class="tool-button h-8 w-8" title="关闭" @click="closeWorkspaceDialog"><X class="h-4 w-4" /></button>
        </div>
        <label class="theme-muted-text mt-4 block text-xs" for="workspace-path">本机目录</label>
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
            @focus="directorySuggestionsOpen = true"
            @click="directorySuggestionsOpen = true"
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
        <div class="mt-4 flex justify-end"><button class="tool-button tool-button-primary h-9 px-4 text-xs" :disabled="!workspacePath.trim()">添加</button></div>
      </form>
      <form v-else class="panel w-full max-w-md p-4" @submit.prevent="createAgent"><div class="flex items-center justify-between"><h2 class="text-sm font-semibold">新建 Agent</h2><button type="button" class="tool-button h-8 w-8" @click="dialog = ''"><X class="h-4 w-4" /></button></div><label class="theme-muted-text mt-4 block text-xs">Provider</label><select v-model="agentProvider" class="tool-input mt-1"><option v-for="provider in providers" :key="provider.id" :value="provider.id">{{ provider.label }}</option></select><div class="mt-4 flex justify-end"><button class="tool-button tool-button-primary h-9 px-4 text-xs">创建</button></div></form>
    </div>
  </div>
</template>

<style scoped>
.v2-shell { grid-template-columns: 220px minmax(0, 1fr); }
.workspace-sidebar, .agent-tabs, header, footer, .composer-wrap { border-color: var(--theme-borderDefault); }
.brand-mark, .provider-mark { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.workspace-row:hover, .agent-tab:hover { background: var(--theme-appPanelHover); }
.row-active { background: var(--theme-appPanelInset); }
.row-action { display: none; color: var(--theme-textMuted); }
.group:hover .row-action { display: flex; }
.agent-tabs { background: var(--theme-appPanelMuted); }
.agent-close { color: var(--theme-textMuted); opacity: 0; }
.agent-tab:hover .agent-close, .agent-tab.row-active .agent-close { opacity: 1; }
.agent-close:hover { color: var(--theme-dangerText); }
.status-chip { border-color: var(--theme-borderDefault); background: var(--theme-appPanelStrong); }
.status-dot { background: var(--theme-success); }
.status-dot-running { background: var(--theme-warning); }
.timeline { background: var(--theme-appPanel); }
.process-row { border-color: var(--theme-processBorder); background: var(--theme-processBg); color: var(--theme-processText); }
.error-row { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.composer-wrap { background: var(--theme-appPanelMuted); }
.modal-backdrop { background: var(--theme-modalBackdrop); }
.directory-suggestions { background: var(--theme-appPanelStrong); border-color: var(--theme-borderDefault); }
.directory-suggestion:hover { background: var(--theme-appPanelHover); }
@media (max-width: 900px) { .v2-shell { grid-template-columns: 64px minmax(0, 1fr); } .workspace-sidebar header span, .workspace-sidebar footer span, .workspace-sidebar .row-copy { display: none; } .workspace-sidebar header, .workspace-sidebar footer, .workspace-row { justify-content: center; } }
@media (max-width: 640px) { .status-text { display: none; } .agent-tab { max-width: 136px; } }
</style>
