<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, provide, ref } from 'vue'
import { Archive, Folder, FolderOpen, LoaderCircle, Pencil, Pin, PinOff, Plus, Settings, TerminalSquare, X } from 'lucide-vue-next'
import { v2Api, globalEventsUrl } from '../lib/v2Api.js'
import { readActiveTaskId, writeActiveTaskId } from '../lib/activeTaskStorage.js'
import { createEventSource } from '../lib/eventSource.js'
import { createMobileDialogHistoryState, getMobileDialogHistoryState } from '../lib/mobileDialogHistory.js'
import { createMobileTimelineHistoryState, getMobileTimelineTaskId, hasMobileTimelineHistoryState } from '../lib/mobileTimelineHistory.js'
import { readCollapsedProjectIds, writeCollapsedProjectIds } from '../lib/projectExpansionStorage.js'
import { readSplitTimelineState, resolveSplitTimelineState, writeSplitTimelineState } from '../lib/splitTimelineStorage.js'
import ConfirmDialog from './ConfirmDialog.vue'
import AgentProviderIcon from './AgentProviderIcon.vue'
import DirectorySearchInput from './DirectorySearchInput.vue'
import PxActionMenu from './PxActionMenu.vue'
import PxAlert from './PxAlert.vue'
import PxButton from './PxButton.vue'
import PxDialog from './PxDialog.vue'
import PxField from './PxField.vue'
import PxIconButton from './PxIconButton.vue'
import PxSelect from './PxSelect.vue'
import SessionTitleMarquee from './SessionTitleMarquee.vue'
import TaskTimelinePane from './TaskTimelinePane.vue'
import V2SettingsDialog from './V2SettingsDialog.vue'

const projects = ref([])
const providers = ref([])
const tasksByProject = ref({})
const expandedProjectIds = ref(new Set())
const loading = ref(true)
const error = ref('')
const primaryTaskId = ref('')
const secondaryTaskId = ref('')
const splitEnabled = ref(false)
const focusedPane = ref('primary')
const mobileView = ref('sidebar')
const isMobile = ref(false)
provide('timelineVisible', computed(() => !isMobile.value || mobileView.value === 'timeline'))
const dialog = ref('')
const importSessions = ref([])
const importProviderFilter = ref('')
const importQuery = ref('')
const importLoading = ref(false)
const importError = ref('')
const importingId = ref('')
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
const confirmation = ref({ open: false, title: '', description: '', confirmText: '', danger: false, resolve: null })

let taskRenameInput = null
let globalEventSource = null
let mobileMediaQuery = null
let directorySearchTimer = null
let directorySearchController = null
let importSearchTimer = null
let importSearchController = null
let dialogUsesHistory = false
let dialogHistoryClosePromise = null
let resolveDialogHistoryClose = null
const attentionClearPending = new Set()

const providerOptions = computed(() => providers.value.map((provider) => ({ value: provider.id, label: provider.label })))
const executionOptions = [{ value: 'worktree', label: '新建 Worktree' }, { value: 'local', label: '当前目录' }]
const baseRefOptions = [
  { value: 'HEAD', label: 'HEAD（当前提交）' },
  { value: 'origin/main', label: 'origin/main' },
  { value: 'origin/master', label: 'origin/master' },
  { value: 'main', label: 'main' },
  { value: 'master', label: 'master' },
]
const allTasks = computed(() => Object.values(tasksByProject.value).flat())
const primaryTask = computed(() => taskForId(primaryTaskId.value))
const secondaryTask = computed(() => taskForId(secondaryTaskId.value))
const focusedTaskId = computed(() => splitEnabled.value && focusedPane.value === 'secondary' ? secondaryTaskId.value : primaryTaskId.value)
const activeTask = computed(() => taskForId(focusedTaskId.value))
const activeProject = computed(() => projects.value.find((project) => project.id === activeTask.value?.projectId))
const activeProjectId = computed(() => activeProject.value?.id || '')

function taskView(task, projectId = task?.projectId) {
  if (!task?.agent) return null
  return { ...task.agent, id: task.id, taskId: task.id, agentSessionId: task.agent.id, projectId, taskLifecycle: task.lifecycle, pinnedAt: task.pinnedAt, environment: task.environment }
}

function tasksForProject(projectId) { return tasksByProject.value[projectId] || [] }
function taskForId(taskId) { return allTasks.value.find((task) => task.id === taskId) || null }
function projectForTask(task) { return projects.value.find((project) => project.id === task?.projectId) || null }
function setProjectTasks(projectId, tasks) { tasksByProject.value = { ...tasksByProject.value, [projectId]: tasks } }

function upsertTaskAgent(agent) {
  if (!agent?.taskId || !agent.projectId) return null
  const projectTasks = tasksForProject(agent.projectId)
  const index = projectTasks.findIndex((task) => task.id === agent.taskId)
  const current = index >= 0 ? projectTasks[index] : null
  const nextTask = { ...current, ...agent, id: agent.taskId, taskId: agent.taskId, agentSessionId: agent.id, projectId: agent.projectId }
  const nextTasks = [...projectTasks]
  if (index >= 0) nextTasks[index] = nextTask
  else nextTasks.unshift(nextTask)
  setProjectTasks(agent.projectId, nextTasks)
  return nextTask
}

function persistLayout() {
  const state = { enabled: splitEnabled.value, primaryTaskId: primaryTaskId.value, secondaryTaskId: secondaryTaskId.value, focusedPane: focusedPane.value }
  writeSplitTimelineState(state)
  writeActiveTaskId(focusedTaskId.value || primaryTaskId.value)
}

function applyLayout(state) {
  splitEnabled.value = state.enabled
  primaryTaskId.value = state.primaryTaskId
  secondaryTaskId.value = state.secondaryTaskId
  focusedPane.value = state.focusedPane
  persistLayout()
}

function reconcileLayout(fallbackTaskId = '') {
  applyLayout(resolveSplitTimelineState({ enabled: splitEnabled.value, primaryTaskId: primaryTaskId.value, secondaryTaskId: secondaryTaskId.value, focusedPane: focusedPane.value }, new Set(allTasks.value.map((task) => task.id)), fallbackTaskId))
}

function focusPane(pane) {
  if (pane === 'secondary' && !splitEnabled.value) return
  focusedPane.value = pane
  persistLayout()
}

function openSplit() {
  if (isMobile.value || !primaryTaskId.value) return
  splitEnabled.value = true
  secondaryTaskId.value = ''
  focusedPane.value = 'secondary'
  persistLayout()
}

function closePane(pane) {
  if (!splitEnabled.value) return
  if (pane === 'primary' && secondaryTaskId.value) primaryTaskId.value = secondaryTaskId.value
  secondaryTaskId.value = ''
  splitEnabled.value = false
  focusedPane.value = 'primary'
  persistLayout()
}

function removeTaskFromLayout(taskId) {
  if (primaryTaskId.value === taskId) {
    primaryTaskId.value = secondaryTaskId.value
    secondaryTaskId.value = ''
    focusedPane.value = 'primary'
  } else if (secondaryTaskId.value === taskId) {
    secondaryTaskId.value = ''
    focusedPane.value = 'primary'
  }
  splitEnabled.value = false
  persistLayout()
}

async function selectTask(taskId, { navigate = false } = {}) {
  const task = taskForId(taskId)
  if (!task) return
  setProjectExpanded(task.projectId)
  if (navigate) enterMobileTimeline(taskId)
  if (isMobile.value) {
    primaryTaskId.value = taskId
    if (secondaryTaskId.value === taskId) secondaryTaskId.value = ''
    focusedPane.value = 'primary'
  } else if (primaryTaskId.value === taskId) {
    focusedPane.value = 'primary'
  } else if (splitEnabled.value && secondaryTaskId.value === taskId) {
    focusedPane.value = 'secondary'
  } else if (splitEnabled.value && focusedPane.value === 'secondary') {
    secondaryTaskId.value = taskId
  } else {
    primaryTaskId.value = taskId
  }
  if (isMobile.value && hasMobileTimelineHistoryState(window.history.state)) window.history.replaceState(createMobileTimelineHistoryState(window.history.state, taskId), '')
  persistLayout()
  clearViewedTaskAttention(task)
}

async function selectProject(projectId, { navigate = false } = {}) {
  setProjectExpanded(projectId)
  if (!(projectId in tasksByProject.value)) {
    const result = await v2Api.listProjectTasks(projectId)
    setProjectTasks(projectId, result.tasks.map((task) => taskView(task, projectId)).filter(Boolean))
  }
  const task = tasksForProject(projectId)[0]
  if (task) await selectTask(task.id, { navigate })
}

function setProjectExpanded(projectId, expanded = true) {
  const next = new Set(expandedProjectIds.value)
  if (expanded) next.add(projectId)
  else next.delete(projectId)
  expandedProjectIds.value = next
  writeCollapsedProjectIds(projects.value.map((project) => project.id).filter((id) => !next.has(id)))
}

function restoreProjectExpansion() {
  const ids = new Set(projects.value.map((project) => project.id))
  const collapsed = readCollapsedProjectIds().filter((id) => ids.has(id))
  const collapsedSet = new Set(collapsed)
  expandedProjectIds.value = new Set([...ids].filter((id) => !collapsedSet.has(id)))
  writeCollapsedProjectIds(collapsed)
}

function toggleProject(projectId) { setProjectExpanded(projectId, !expandedProjectIds.value.has(projectId)) }
function providerLabel(providerId) { return providers.value.find((provider) => provider.id === providerId)?.label || providerId }

function projectMenuItems(project) {
  return [{ id: 'new', label: '新建会话', icon: Plus }, { id: 'pin', label: project.pinnedAt ? '取消置顶' : '置顶', icon: project.pinnedAt ? PinOff : Pin }, { separator: true }, { id: 'archive', label: '归档工作区', icon: Archive }]
}

function taskMenuItems(task) {
  return [{ id: 'rename', label: '重命名', icon: Pencil }, { id: 'pin', label: task.pinnedAt ? '取消置顶' : '置顶', icon: task.pinnedAt ? PinOff : Pin }, { separator: true }, { id: 'archive', label: '归档会话', icon: Archive }]
}

function agentStatusClass(task) {
  if ([primaryTaskId.value, secondaryTaskId.value].includes(task.id) || !task.requiresAttention) return ''
  return task.attentionReason === 'error' ? 'agent-dot-failed' : (task.attentionReason === 'finished' ? 'agent-dot-finished' : '')
}

function clearViewedTaskAttention(task) {
  if (!task || ![primaryTaskId.value, secondaryTaskId.value].includes(task.id) || !task.requiresAttention || attentionClearPending.has(task.id)) return
  attentionClearPending.add(task.id)
  v2Api.clearTaskAttention(task.id).then(({ agent }) => upsertTaskAgent(agent)).catch((cause) => { error.value = cause.message }).finally(() => attentionClearPending.delete(task.id))
}

async function loadInitial() {
  loading.value = true
  try {
    const [projectResult, providerResult] = await Promise.all([v2Api.listProjects(), v2Api.listProviders()])
    const projectTasks = await Promise.all((projectResult.projects || []).map(async (project) => ({ project, ...(await v2Api.listProjectTasks(project.id)) })))
    projects.value = projectTasks.map(({ project }) => project)
    providers.value = providerResult.providers
    tasksByProject.value = Object.fromEntries(projectTasks.map(({ project, tasks }) => [project.id, tasks.map((task) => taskView(task, project.id)).filter(Boolean)]))
    restoreProjectExpansion()
    const stored = readSplitTimelineState()
    const historyTaskId = isMobile.value ? getMobileTimelineTaskId(window.history.state) : ''
    const fallback = historyTaskId || readActiveTaskId() || allTasks.value[0]?.id || ''
    applyLayout(resolveSplitTimelineState(stored, new Set(allTasks.value.map((task) => task.id)), fallback))
    if (isMobile.value && historyTaskId && taskForId(historyTaskId)) primaryTaskId.value = historyTaskId
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

async function refreshProjects() {
  const result = await v2Api.listProjects()
  const projectTasks = await Promise.all((result.projects || []).map(async (project) => ({ project, ...(await v2Api.listProjectTasks(project.id)) })))
  projects.value = projectTasks.map(({ project }) => project)
  tasksByProject.value = Object.fromEntries(projectTasks.map(({ project, tasks }) => [project.id, tasks.map((task) => taskView(task, project.id)).filter(Boolean)]))
  restoreProjectExpansion()
  reconcileLayout(allTasks.value[0]?.id || '')
}

function openGlobalEvents() {
  globalEventSource?.close()
  globalEventSource = createEventSource(globalEventsUrl())
  globalEventSource.addEventListener('task', (event) => {
    const task = upsertTaskAgent(JSON.parse(event.data).agent)
    clearViewedTaskAttention(task)
  })
}

function closeGlobalEvents() { globalEventSource?.close(); globalEventSource = null }
function formatImportActivity(value) {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? `最近更新 ${new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(timestamp)}` : '更新时间未知'
}

function openManagedDialog(dialogId) {
  dialog.value = dialogId
  if (!isMobile.value) return
  if (getMobileDialogHistoryState(window.history.state) === dialogId) { dialogUsesHistory = true; return }
  dialogUsesHistory = true
  window.history.pushState(createMobileDialogHistoryState(window.history.state, dialogId), '')
}

function restoreDialogFromHistory(dialogId) { dialogUsesHistory = true; dialog.value = dialogId; if (dialogId === 'import') loadImportSessions() }
function finishDialogClose() {
  cancelDirectorySearch(); cancelImportSearch(); directorySuggestionsOpen.value = false; dialog.value = ''; dialogUsesHistory = false
  resolveDialogHistoryClose?.(); dialogHistoryClosePromise = null; resolveDialogHistoryClose = null
}
function closeDialog() {
  if (dialogUsesHistory && getMobileDialogHistoryState(window.history.state) === dialog.value) {
    if (!dialogHistoryClosePromise) { dialogHistoryClosePromise = new Promise((resolve) => { resolveDialogHistoryClose = resolve }); window.history.back() }
    return dialogHistoryClosePromise
  }
  finishDialogClose(); return Promise.resolve()
}

async function openConversationDialog(project = null) {
  projectPath.value = project?.repositoryRoot || ''; taskTitle.value = ''; executionKind.value = 'local'; taskBaseRef.value = 'HEAD'; taskSlug.value = ''; taskBranchName.value = ''; conversationError.value = ''
  taskProvider.value = providers.value.some((provider) => provider.id === 'codex') ? 'codex' : providers.value[0]?.id || ''
  directorySuggestions.value = []; directorySearchError.value = ''; directorySuggestionsOpen.value = false; selectedDirectoryIndex.value = -1
  openManagedDialog('conversation'); await nextTick(); projectPathInput.value?.focus()
}

async function openImportDialog() { openManagedDialog('import'); importProviderFilter.value = ''; importQuery.value = ''; importError.value = ''; await loadImportSessions() }
function cancelImportSearch() { if (importSearchTimer) clearTimeout(importSearchTimer); importSearchTimer = null; importSearchController?.abort(); importSearchController = null }
async function loadImportSessions() {
  importLoading.value = true; importError.value = ''; importSearchController?.abort()
  const controller = new AbortController(); importSearchController = controller
  try {
    const result = await v2Api.listImportableSessions({ providerId: importProviderFilter.value, query: importQuery.value, limit: 200, signal: controller.signal })
    if (dialog.value === 'import' && importSearchController === controller) { importSessions.value = result.sessions || []; importError.value = (result.errors || []).map((item) => `${item.providerLabel || item.providerId}：${item.message}`).join('；') }
  } catch (cause) { if (cause.name !== 'AbortError' && importSearchController === controller) { importSessions.value = []; importError.value = cause.message } }
  finally { if (importSearchController === controller) { importSearchController = null; importLoading.value = false } }
}
function scheduleImportSearch() { if (importSearchTimer) clearTimeout(importSearchTimer); importSearchTimer = setTimeout(() => { importSearchTimer = null; loadImportSessions() }, 220) }
function clearImportQuery() { importQuery.value = ''; scheduleImportSearch() }
async function selectImportProvider(providerId) { if (importProviderFilter.value === providerId) return; importProviderFilter.value = providerId; await loadImportSessions() }

async function importSession(session) {
  if (importingId.value) return
  importingId.value = session.providerHandleId; importError.value = ''
  try {
    const result = await v2Api.importSession({ providerId: session.providerId, providerHandleId: session.providerHandleId, cwd: session.cwd || activeProject.value?.repositoryRoot || '', title: session.title })
    const project = result.project
    if (project && !projects.value.some((item) => item.id === project.id)) projects.value.push(project)
    const task = taskView({ ...result.task, environment: result.environment, agent: result.agent }, project.id)
    setProjectTasks(project.id, [task, ...tasksForProject(project.id).filter((item) => item.id !== task.id)])
    await closeDialog(); setProjectExpanded(project.id); await selectTask(task.id, { navigate: true })
  } catch (cause) { importError.value = cause.message } finally { importingId.value = '' }
}

function cancelDirectorySearch() { if (directorySearchTimer) clearTimeout(directorySearchTimer); directorySearchTimer = null; directorySearchController?.abort(); directorySearchController = null; directorySearchLoading.value = false }
async function searchDirectorySuggestions(query = projectPath.value) {
  directorySearchController?.abort(); const controller = new AbortController(); directorySearchController = controller; directorySearchLoading.value = true; directorySearchError.value = ''; selectedDirectoryIndex.value = -1
  try {
    const result = await v2Api.searchDirectories(query.trim(), { limit: 20, signal: controller.signal })
    if (directorySearchController !== controller) return
    directorySuggestions.value = result.items || []; directorySuggestionsOpen.value = true
  } catch (cause) { if (cause.name !== 'AbortError' && directorySearchController === controller) { directorySuggestions.value = []; directorySuggestionsOpen.value = true; directorySearchError.value = cause.message } }
  finally { if (directorySearchController === controller) { directorySearchController = null; directorySearchLoading.value = false } }
}
function scheduleDirectorySearch() {
  cancelDirectorySearch()
  if (!projectPath.value.trim()) { directorySuggestions.value = []; directorySearchError.value = ''; directorySuggestionsOpen.value = false; selectedDirectoryIndex.value = -1; return }
  directorySuggestionsOpen.value = true; selectedDirectoryIndex.value = -1; directorySearchTimer = setTimeout(() => { directorySearchTimer = null; searchDirectorySuggestions() }, 250)
}
function selectDirectory(directory) { projectPath.value = directory.path; selectedDirectoryIndex.value = -1; directorySuggestionsOpen.value = false; projectPathInput.value?.focus() }
async function browseDirectory() {
  cancelDirectorySearch(); directorySuggestionsOpen.value = false; directorySearchError.value = ''; conversationError.value = ''; directoryPicking.value = true
  try { const result = await v2Api.pickDirectory(projectPath.value); if (!result.canceled && result.path) projectPath.value = result.path }
  catch (cause) { directorySearchError.value = cause.message }
  finally { directoryPicking.value = false; projectPathInput.value?.focus() }
}
async function revealSelectedDirectory() { await nextTick(); document.getElementById(`directory-suggestion-${selectedDirectoryIndex.value}`)?.scrollIntoView({ block: 'nearest' }) }
function handleDirectoryKeydown(event) {
  if (event.key === 'Escape') { if (directorySuggestionsOpen.value) { event.preventDefault(); directorySuggestionsOpen.value = false }; return }
  if (!['ArrowDown', 'ArrowUp', 'Enter'].includes(event.key)) return
  if (!directorySuggestionsOpen.value) { if (event.key === 'Enter') return; directorySuggestionsOpen.value = true }
  if (!directorySuggestions.value.length) return
  if (event.key === 'ArrowDown') { event.preventDefault(); selectedDirectoryIndex.value = (selectedDirectoryIndex.value + 1) % directorySuggestions.value.length; revealSelectedDirectory() }
  else if (event.key === 'ArrowUp') { event.preventDefault(); selectedDirectoryIndex.value = selectedDirectoryIndex.value <= 0 ? directorySuggestions.value.length - 1 : selectedDirectoryIndex.value - 1; revealSelectedDirectory() }
  else if (selectedDirectoryIndex.value >= 0) { event.preventDefault(); selectDirectory(directorySuggestions.value[selectedDirectoryIndex.value]) }
}

async function createConversation() {
  if (creating.value) return
  cancelDirectorySearch(); directorySuggestionsOpen.value = false; selectedDirectoryIndex.value = -1; creating.value = true; conversationError.value = ''
  try {
    const project = (await v2Api.createProject({ repositoryRoot: projectPath.value })).project
    const slug = taskSlug.value || taskTitle.value.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'task'
    const result = await v2Api.createTask(project.id, { title: taskTitle.value, providerId: taskProvider.value, executionKind: executionKind.value, baseRef: taskBaseRef.value, branchName: taskBranchName.value || `codex/${slug}`, slug })
    const task = taskView({ ...result.task, environment: result.environment, agent: result.agent }, project.id)
    if (!projects.value.some((item) => item.id === project.id)) projects.value.push(project)
    setProjectTasks(project.id, [task, ...tasksForProject(project.id).filter((item) => item.id !== task.id)])
    projectPath.value = ''; await closeDialog(); setProjectExpanded(project.id); await selectTask(task.id, { navigate: true })
  } catch (cause) { conversationError.value = cause.message } finally { creating.value = false }
}

function requestConfirmation(options = {}) { return new Promise((resolve) => { confirmation.value = { open: true, resolve, ...options } }) }
function cancelConfirmation() { const resolve = confirmation.value.resolve; confirmation.value = { open: false, title: '', description: '', confirmText: '', danger: false, resolve: null }; resolve?.(false) }
function acceptConfirmation() { const resolve = confirmation.value.resolve; confirmation.value = { open: false, title: '', description: '', confirmText: '', danger: false, resolve: null }; resolve?.(true) }

async function handleProjectMenu(action, project) {
  if (action === 'new') return openConversationDialog(project)
  if (action === 'archive') return archiveProject(project)
  if (action === 'pin') { try { await v2Api.setProjectPinned(project.id, !project.pinnedAt); await refreshProjects() } catch (cause) { error.value = cause.message } }
}
function beginTaskRename(task) { renamingTaskId.value = task.id; taskRenameDraft.value = task.title; nextTick(() => taskRenameInput?.select()) }
function cancelTaskRename() { renamingTaskId.value = ''; taskRenameDraft.value = ''; taskRenameInput = null }
async function saveTaskRename(task) {
  if (renamingTaskId.value !== task.id || taskRenameSaving.value) return
  const title = taskRenameDraft.value.trim()
  if (!title) { error.value = '会话名称不能为空。'; nextTick(() => taskRenameInput?.focus()); return }
  if (title === task.title) return cancelTaskRename()
  taskRenameSaving.value = true
  try { const result = await v2Api.updateTask(task.id, { title }); const updated = taskView(result.task, task.projectId); setProjectTasks(task.projectId, tasksForProject(task.projectId).map((item) => item.id === task.id ? updated : item)); cancelTaskRename() }
  catch (cause) { error.value = cause.message; nextTick(() => taskRenameInput?.focus()) }
  finally { taskRenameSaving.value = false }
}
async function handleTaskMenu(action, task) {
  if (action === 'rename') return beginTaskRename(task)
  if (action === 'archive') return archiveTask(task)
  if (action === 'pin') { try { await v2Api.setTaskPinned(task.id, !task.pinnedAt); await refreshProjects() } catch (cause) { error.value = cause.message } }
}
async function archiveTask(task) {
  if (!await requestConfirmation({ title: `归档会话“${task.title}”？`, description: '会话将从左栏隐藏，Timeline 和 Worktree 会继续保留。', confirmText: '归档', danger: false })) return
  try { await v2Api.archiveTask(task.id); setProjectTasks(task.projectId, tasksForProject(task.projectId).filter((item) => item.id !== task.id)); removeTaskFromLayout(task.id); reconcileLayout(allTasks.value[0]?.id || '') }
  catch (cause) { error.value = cause.message }
}
async function archiveProject(project) {
  if (!await requestConfirmation({ title: `归档工作区“${project.displayName}”？`, description: '工作区及其活动会话将从左栏隐藏，可在设置的归档页恢复。', confirmText: '归档', danger: false })) return
  try {
    const removedIds = new Set(tasksForProject(project.id).map((task) => task.id)); await v2Api.archiveProject(project.id)
    projects.value = projects.value.filter((item) => item.id !== project.id); const next = { ...tasksByProject.value }; delete next[project.id]; tasksByProject.value = next
    if (removedIds.has(primaryTaskId.value) || removedIds.has(secondaryTaskId.value)) splitEnabled.value = false
    if (removedIds.has(primaryTaskId.value)) primaryTaskId.value = removedIds.has(secondaryTaskId.value) ? '' : secondaryTaskId.value
    if (removedIds.has(secondaryTaskId.value)) secondaryTaskId.value = ''
    reconcileLayout(allTasks.value[0]?.id || '')
  } catch (cause) { error.value = cause.message }
}

function enterMobileTimeline(taskId) {
  mobileView.value = 'timeline'
  if (!isMobile.value) return
  const state = createMobileTimelineHistoryState(window.history.state, taskId)
  if (hasMobileTimelineHistoryState(window.history.state)) window.history.replaceState(state, '')
  else window.history.pushState(state, '')
}
function showMobileSidebar() { if (isMobile.value && hasMobileTimelineHistoryState(window.history.state)) window.history.back(); else mobileView.value = 'sidebar' }
function handleMobileHistoryPop(event) {
  const historyDialog = getMobileDialogHistoryState(event.state)
  if (dialogUsesHistory && historyDialog !== dialog.value) finishDialogClose()
  else if (!dialogUsesHistory && isMobile.value && historyDialog) restoreDialogFromHistory(historyDialog)
  if (!isMobile.value) return
  mobileView.value = hasMobileTimelineHistoryState(event.state) && primaryTaskId.value ? 'timeline' : 'sidebar'
}
function updateMobileState(event) {
  isMobile.value = event.matches
  mobileView.value = event.matches ? (hasMobileTimelineHistoryState(window.history.state) ? 'timeline' : 'sidebar') : 'timeline'
  if (event.matches && dialog.value && !dialogUsesHistory) openManagedDialog(dialog.value)
}

onMounted(async () => {
  window.addEventListener('popstate', handleMobileHistoryPop)
  mobileMediaQuery = window.matchMedia('(max-width: 720px)'); updateMobileState(mobileMediaQuery); mobileMediaQuery.addEventListener('change', updateMobileState)
  await loadInitial()
  const historyDialog = getMobileDialogHistoryState(window.history.state)
  if (isMobile.value && historyDialog) restoreDialogFromHistory(historyDialog)
  openGlobalEvents()
})
onBeforeUnmount(() => {
  window.removeEventListener('popstate', handleMobileHistoryPop); mobileMediaQuery?.removeEventListener('change', updateMobileState); closeGlobalEvents(); cancelDirectorySearch(); cancelImportSearch()
})
</script>

<template>
  <div class="v2-shell relative grid h-full min-h-0 overflow-hidden">
    <div v-if="loading" class="v2-loading-skeleton absolute inset-0 z-30 grid grid-cols-[240px_minmax(0,1fr)]" role="status" aria-label="正在加载工作区">
      <div class="border-r p-3"><div class="skeleton-line h-7 w-24" /><div class="skeleton-line mt-5 h-9 w-full" /><div class="skeleton-line mt-3 h-8 w-4/5" /><div class="skeleton-line mt-2 h-8 w-3/5" /></div>
      <div class="p-4"><div class="skeleton-line h-8 w-40" /><div class="mx-auto mt-16 max-w-3xl space-y-3"><div class="skeleton-line h-12 w-3/4" /><div class="skeleton-line h-20 w-5/6" /><div class="skeleton-line h-12 w-2/3" /></div></div>
    </div>

    <aside class="workspace-sidebar panel flex min-h-0 flex-col overflow-hidden" :class="mobileView === 'sidebar' ? 'mobile-panel-active' : 'mobile-panel-hidden'" :inert="isMobile && mobileView !== 'sidebar'" :aria-hidden="isMobile ? mobileView !== 'sidebar' : undefined">
      <header class="flex h-14 shrink-0 items-center border-b px-3">
        <div class="flex min-w-0 items-center gap-2"><div class="brand-mark flex h-7 w-7 items-center justify-center rounded-sm"><TerminalSquare class="h-4 w-4" /></div><span class="text-sm font-semibold">PromptX</span><span class="theme-muted-text text-[10px]">V2</span></div>
      </header>
      <div class="shrink-0 px-2 pb-2 pt-2">
        <PxButton variant="primary" size="sm" class="sidebar-primary-action h-9 w-full justify-start px-2 text-left text-xs" @click="openConversationDialog()"><Plus class="h-4 w-4 shrink-0" /><span>新会话</span></PxButton>
        <PxButton variant="ghost" size="sm" class="sidebar-secondary-action mt-1 h-8 w-full justify-start px-2 text-left text-xs" @click="openImportDialog"><FolderOpen class="h-3.5 w-3.5 shrink-0" /><span>导入会话</span></PxButton>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        <div class="theme-muted-text flex h-8 items-center px-2 text-[10px] font-medium uppercase tracking-wide">工作区</div>
        <div v-for="project in projects" :key="project.id" class="workspace-group mb-2">
          <div class="workspace-heading group flex h-9 min-w-0 cursor-pointer items-center rounded-sm" :class="project.id === activeProjectId ? 'workspace-active' : ''" @click="toggleProject(project.id)">
            <PxIconButton class="workspace-toggle h-7 w-7 shrink-0" :label="expandedProjectIds.has(project.id) ? '收起工作区' : '展开工作区'" :aria-expanded="expandedProjectIds.has(project.id)" @click.stop="toggleProject(project.id)"><FolderOpen v-if="expandedProjectIds.has(project.id)" class="h-4 w-4" /><Folder v-else class="h-4 w-4" /></PxIconButton>
            <button type="button" class="flex min-w-0 flex-1 items-center gap-2 py-1 text-left" :title="project.repositoryRoot" @click.stop="toggleProject(project.id)"><span class="min-w-0 flex-1 truncate text-xs font-medium">{{ project.displayName }}</span><Pin v-if="project.pinnedAt" class="theme-muted-text h-3 w-3 shrink-0" aria-label="已置顶" /></button>
            <PxActionMenu class="workspace-action" :label="`${project.displayName} 的更多操作`" :items="projectMenuItems(project)" @select="handleProjectMenu($event, project)" />
          </div>
          <Transition name="workspace-agents">
            <div v-if="expandedProjectIds.has(project.id)" class="workspace-agents-wrapper">
              <div class="agent-list">
                <div v-for="task in tasksForProject(project.id)" :key="task.id" class="agent-row group flex h-8 min-w-0 items-center overflow-hidden rounded-sm pl-6" :class="task.id === focusedTaskId ? 'row-active' : ''">
                  <input v-if="renamingTaskId === task.id" :ref="(element) => { if (element) taskRenameInput = element }" v-model="taskRenameDraft" class="task-rename-input mx-1 h-8 min-w-0 max-w-full flex-[1_1_0%] rounded-sm border px-2 text-xs outline-none" maxlength="120" :disabled="taskRenameSaving" :aria-label="`重命名 ${task.title}`" @click.stop @blur="saveTaskRename(task)" @keydown.enter.prevent="$event.currentTarget.blur()" @keydown.esc.prevent="cancelTaskRename" />
                  <div v-else role="link" tabindex="0" class="task-navigation flex h-8 min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left" :aria-current="task.id === focusedTaskId ? 'page' : undefined" :title="`${task.title} · ${providerLabel(task.providerId)}`" @click="selectTask(task.id, { navigate: true })" @keydown.enter.prevent="selectTask(task.id, { navigate: true })">
                    <AgentProviderIcon :provider-id="task.providerId" :label="providerLabel(task.providerId)" />
                    <SessionTitleMarquee class="min-w-0 flex-1 text-xs" :title="task.title" :active="task.id === focusedTaskId" />
                    <span v-if="agentStatusClass(task)" class="agent-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="agentStatusClass(task)" />
                    <Pin v-if="task.pinnedAt" class="theme-muted-text h-3 w-3 shrink-0" aria-label="已置顶" />
                    <LoaderCircle v-if="task.lifecycle === 'running'" class="theme-muted-text h-3 w-3 shrink-0 animate-spin" />
                  </div>
                  <PxActionMenu class="agent-action" :label="`${task.title} 的更多操作`" :items="taskMenuItems(task)" @select="handleTaskMenu($event, task)" />
                </div>
                <button v-if="!tasksForProject(project.id).length" type="button" class="theme-muted-text flex h-8 w-full items-center justify-start gap-2 pl-8 pr-2 text-left text-[10px]" @click="openConversationDialog(project)"><Plus class="h-3 w-3" />新会话</button>
              </div>
            </div>
          </Transition>
        </div>
        <div v-if="!projects.length && !loading" class="theme-muted-text px-3 py-8 text-center text-xs">还没有工作区</div>
      </div>
      <footer class="border-t p-2"><PxButton variant="ghost" size="sm" class="settings-entry h-9 w-full justify-start gap-2 px-2 text-left text-xs" @click="openManagedDialog('settings')"><Settings class="h-4 w-4 shrink-0" /><span>设置</span></PxButton></footer>
    </aside>

    <main class="timeline-workspace grid min-h-0 min-w-0" :class="[{ 'is-split': splitEnabled && !isMobile }, mobileView === 'timeline' ? 'mobile-panel-active' : 'mobile-panel-hidden']" :inert="isMobile && mobileView !== 'timeline'" :aria-hidden="isMobile ? mobileView !== 'timeline' : undefined">
      <TaskTimelinePane :task="primaryTask" :project="projectForTask(primaryTask)" :focused="focusedPane === 'primary' || isMobile" :split-enabled="splitEnabled && !isMobile" :mobile="isMobile" @focus="focusPane('primary')" @back="showMobileSidebar" @split="openSplit" @close="closePane('primary')" @agent-event="upsertTaskAgent" @changed="refreshProjects" />
      <TaskTimelinePane v-if="splitEnabled && !isMobile" :task="secondaryTask" :project="projectForTask(secondaryTask)" :focused="focusedPane === 'secondary'" split-enabled @focus="focusPane('secondary')" @close="closePane('secondary')" @agent-event="upsertTaskAgent" @changed="refreshProjects" />
    </main>

    <div v-if="error" class="shell-error error-row absolute left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-sm border px-3 py-2 text-xs"><span>{{ error }}</span><PxIconButton class="h-6 w-6" label="关闭错误提示" @click="error = ''"><X class="h-3.5 w-3.5" /></PxIconButton></div>
    <V2SettingsDialog :open="dialog === 'settings'" @close="closeDialog" @changed="refreshProjects" />

    <PxDialog :open="dialog === 'conversation'" panel-class="new-conversation-panel h-[100dvh] max-h-[100dvh] max-w-none border-0 sm:h-[min(44rem,calc(100dvh-1.5rem))] sm:max-h-[min(44rem,calc(100dvh-1.5rem))] sm:max-w-md sm:border" header-class="h-14 px-4 sm:px-5" body-class="flex min-h-0 flex-1 flex-col" @close="closeDialog">
      <template #title><h2 class="text-sm font-semibold">新会话</h2></template>
      <form class="flex min-h-0 flex-1 flex-col overflow-y-auto px-4 pb-4 pt-4 sm:pt-5" @submit.prevent="createConversation">
        <PxField label="路径" for-id="workspace-path" :error="directorySearchError">
          <DirectorySearchInput ref="projectPathInput" v-model="projectPath" class="mt-1" :loading="directorySearchLoading" :open="directorySuggestionsOpen" :suggestions="directorySuggestions" :error="directorySearchError" :selected-index="selectedDirectoryIndex" :disabled="creating || directoryPicking" :picking="directoryPicking" @input="scheduleDirectorySearch" @keydown="handleDirectoryKeydown" @mouseenter="selectedDirectoryIndex = $event" @select="selectDirectory" @browse="browseDirectory" />
        </PxField>
        <PxAlert v-if="conversationError" class="mt-3 shrink-0">{{ conversationError }}</PxAlert>
        <div class="shrink-0">
          <PxField class="mt-4" label="Provider" for-id="conversation-provider"><PxSelect id="conversation-provider" v-model="taskProvider" :options="providerOptions" :disabled="creating" aria-label="Provider" /></PxField>
          <PxField class="mt-4" label="任务标题" for-id="task-title"><input id="task-title" v-model="taskTitle" class="tool-input mt-1" placeholder="任务标题" :disabled="creating" /></PxField>
          <PxField class="mt-4" label="执行位置" for-id="execution-kind"><PxSelect id="execution-kind" v-model="executionKind" :options="executionOptions" :disabled="creating" aria-label="执行位置" /></PxField>
          <div v-if="executionKind === 'worktree'" class="grid grid-cols-1 gap-2">
            <PxField class="mt-2" label="基线" for-id="task-base-ref"><PxSelect id="task-base-ref" v-model="taskBaseRef" :options="baseRefOptions" :disabled="creating" aria-label="基线" /></PxField>
            <PxField label="Worktree 名称" hint="可选，例如 fix-login"><input v-model="taskSlug" class="tool-input mt-1" placeholder="Worktree 名称，例如 fix-login" :disabled="creating" /></PxField>
          </div>
        </div>
        <div class="sticky bottom-0 mt-4 flex shrink-0 justify-end border-t px-0 pb-0 pt-3" style="background: var(--theme-appPanel);"><PxButton type="submit" variant="primary" size="sm" :loading="creating" :disabled="!projectPath.trim() || !taskProvider">创建会话</PxButton></div>
      </form>
    </PxDialog>

    <PxDialog :open="dialog === 'import'" panel-class="import-dialog-panel h-[100dvh] max-w-none border-0 sm:h-[min(40rem,calc(100dvh-3rem))] sm:max-w-2xl sm:border" header-class="h-14 px-4 sm:px-5" body-class="flex min-h-0 flex-1 flex-col" @close="closeDialog">
      <template #title><h2 class="text-sm font-semibold">导入会话</h2></template>
      <div class="flex min-h-0 flex-1 flex-col px-4 pb-4">
        <div class="import-layout flex min-h-0 flex-1 gap-3 pt-1">
          <aside class="import-provider-list flex w-28 shrink-0 flex-col gap-1 border-r pr-3">
            <button type="button" class="import-provider-filter flex h-8 items-center justify-start px-2 text-left text-xs" :class="!importProviderFilter ? 'is-active' : ''" @click="selectImportProvider('')">全部 Provider</button>
            <button v-for="provider in providers" :key="provider.id" type="button" class="import-provider-filter flex h-8 items-center justify-start px-2 text-left text-xs" :class="importProviderFilter === provider.id ? 'is-active' : ''" @click="selectImportProvider(provider.id)">{{ provider.label }}</button>
          </aside>
          <section class="flex min-h-0 min-w-0 flex-1 flex-col">
            <div class="relative shrink-0"><input v-model="importQuery" class="tool-input h-9 w-full pr-9 text-xs" placeholder="搜索标题、目录、Session ID 或首条消息" @input="scheduleImportSearch" /><PxIconButton v-if="importQuery" class="import-query-clear theme-muted-text absolute right-1 top-1/2 h-7 w-7 -translate-y-1/2" label="清空搜索" @click="clearImportQuery"><X class="h-3.5 w-3.5" /></PxIconButton><LoaderCircle v-else-if="importLoading" class="theme-muted-text pointer-events-none absolute right-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin" /></div>
            <div v-if="importError" class="error-row mt-3 rounded-sm border px-3 py-2 text-xs">{{ importError }}</div>
            <div class="relative mt-2 min-h-0 flex-1">
              <div v-if="importLoading && !importSessions.length" class="theme-muted-text flex h-full items-center justify-center text-xs"><LoaderCircle class="mr-2 h-4 w-4 animate-spin" />正在扫描本机 Provider 会话</div>
              <div v-else-if="!importSessions.length" class="theme-muted-text flex h-full items-center justify-center text-xs">没有可导入的会话</div>
              <div v-else class="h-full min-h-0 space-y-1 overflow-y-auto pr-1">
                <button v-for="session in importSessions" :key="`${session.providerId}:${session.providerHandleId}`" type="button" class="import-session-row flex w-full min-w-0 items-center gap-3 rounded-sm border px-3 py-2 text-left" :disabled="Boolean(importingId)" @click="importSession(session)">
                  <span class="import-provider-mark flex h-7 w-7 shrink-0 items-center justify-center rounded-sm text-[10px] font-semibold">{{ providerLabel(session.providerId).slice(0, 1) }}</span>
                  <span class="min-w-0 flex-1"><span class="flex items-center gap-2"><span class="truncate text-xs font-medium">{{ session.title }}</span><span class="theme-muted-text shrink-0 text-[10px]">{{ providerLabel(session.providerId) }}</span><span class="theme-muted-text ml-auto shrink-0 text-[10px]">{{ formatImportActivity(session.lastActivityAt) }}</span></span><span class="theme-muted-text mt-0.5 block truncate font-mono text-[10px]" :title="session.cwd || '未记录工作目录，将使用当前项目目录'">{{ session.cwd || '未记录工作目录，将使用当前项目目录' }}</span><span class="theme-muted-text mt-0.5 block truncate text-[11px]">{{ session.lastPromptPreview || session.firstPromptPreview }}</span></span>
                  <LoaderCircle v-if="importingId === session.providerHandleId" class="theme-muted-text h-4 w-4 shrink-0 animate-spin" /><span v-else class="theme-muted-text shrink-0 text-[10px]">导入</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </PxDialog>

    <ConfirmDialog :open="confirmation.open" :title="confirmation.title" :description="confirmation.description" :confirm-text="confirmation.confirmText" :danger="confirmation.danger" @cancel="cancelConfirmation" @confirm="acceptConfirmation" />
  </div>
</template>

<style scoped>
.v2-shell { --workspace-gap: 0.5rem; grid-template-columns: 240px minmax(0, 1fr); column-gap: var(--workspace-gap); border: 0; }
.workspace-sidebar.panel { border: 0; box-shadow: inset 0 1px 0 var(--theme-panelHighlight); }
.timeline-workspace { grid-template-columns: minmax(0, 1fr); }
.timeline-workspace.is-split {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--workspace-gap);
}
.v2-loading-skeleton { background: var(--theme-appPanel); color: var(--theme-textMuted); }
.v2-loading-skeleton > div, .workspace-sidebar, .workspace-sidebar header, .workspace-sidebar footer { border-color: var(--theme-borderDefault); }
.skeleton-line { border-radius: 2px; background: var(--theme-appPanelInset); opacity: 0.72; animation: skeleton-pulse 1.2s ease-in-out infinite; }
@keyframes skeleton-pulse { 0%, 100% { opacity: 0.48; } 50% { opacity: 0.88; } }
.brand-mark { background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action { justify-content: flex-start; background: var(--theme-primaryBg); color: var(--theme-primaryText); }
.sidebar-primary-action:hover { filter: brightness(0.96); }
.sidebar-secondary-action, .settings-entry { justify-content: flex-start; color: var(--theme-textMuted); }
.sidebar-secondary-action:hover, .settings-entry:hover, .workspace-heading:hover, .agent-row:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.workspace-active { color: var(--theme-text); }
.task-navigation:focus-visible { outline: 1px solid var(--theme-focusRing); outline-offset: -1px; }
.agent-row .agent-provider-icon { color: var(--theme-textMuted); }
.agent-row.row-active .agent-provider-icon { color: inherit; }
.workspace-toggle, .workspace-action, .agent-action { color: var(--theme-textMuted); }
.workspace-action, .agent-action { border: 0; background: transparent; opacity: 0; }
.workspace-heading:hover .workspace-action, .workspace-heading:focus-within .workspace-action, .agent-row:hover .agent-action, .agent-row:focus-within .agent-action { opacity: 1; }
.workspace-agents-enter-active, .workspace-agents-leave-active { display: grid; grid-template-rows: 1fr; opacity: 1; transition: grid-template-rows 180ms cubic-bezier(0.22, 1, 0.36, 1), opacity 140ms ease; }
.workspace-agents-enter-from, .workspace-agents-leave-to { grid-template-rows: 0fr; opacity: 0; }
.workspace-agents-wrapper { min-height: 0; }
.workspace-agents-wrapper > .agent-list { min-height: 0; overflow: hidden; }
.task-rename-input { width: 0; border-color: var(--theme-inputBorder); background: var(--theme-inputBg); color: var(--theme-textPrimary); }
.task-rename-input:focus { border-color: var(--theme-borderStrong); box-shadow: 0 0 0 1px var(--theme-focusRing); }
.agent-dot-finished { background: var(--theme-success); }
.agent-dot-failed { background: var(--theme-danger); }
.row-active { background: var(--theme-appPanelActive); }
.error-row { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.import-session-row { border-color: var(--theme-borderDefault); }
.import-session-row:hover { background: var(--theme-appPanelHover); }
.import-provider-mark { background: var(--theme-appPanelInset); color: var(--theme-textMuted); }
.import-provider-list { border-color: var(--theme-borderDefault); }
.import-provider-filter { color: var(--theme-textMuted); }
.import-provider-filter:hover { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.import-provider-filter.is-active { background: var(--theme-appPanelActive); color: var(--theme-textPrimary); }
@media (max-width: 900px) { .v2-shell { grid-template-columns: 200px minmax(0, 1fr); } }
@media (max-width: 720px) {
  .v2-loading-skeleton { display: block; }
  .v2-loading-skeleton > div:first-child { display: none; }
  .v2-shell { display: block; border: 0; border-radius: 0; }
  .workspace-sidebar.panel { border-radius: 0; }
  .workspace-sidebar, .timeline-workspace { position: absolute; inset: 0; width: 100%; background: var(--theme-appPanel); transition: transform 220ms cubic-bezier(0.25, 0.1, 0.25, 1), opacity 180ms ease; }
  .workspace-sidebar { z-index: 1; border-right: 0; }
  .timeline-workspace { z-index: 2; display: block; }
  .workspace-sidebar.mobile-panel-hidden { transform: translateX(-18%); opacity: 0.78; pointer-events: none; }
  .timeline-workspace.mobile-panel-hidden { transform: translateX(100%); pointer-events: none; }
  .mobile-panel-active { transform: translateX(0); opacity: 1; pointer-events: auto; }
  .workspace-action, .agent-action { opacity: 1; }
  .import-layout { display: block; }
  .import-provider-list { width: 100%; flex-direction: row; overflow-x: auto; border-right: 0; padding: 0 0 0.5rem; }
}
@media (prefers-reduced-motion: reduce) { .skeleton-line { animation: none; } .workspace-sidebar, .timeline-workspace, .workspace-agents-enter-active, .workspace-agents-leave-active { transition: none; } }
</style>
