<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, FileDiff, Files, Info, LoaderCircle, MessageSquare, Rows2, Settings, TerminalSquare, X } from 'lucide-vue-next'
import { closeEmptyGroup, closeTab, createLayout, findNode, groups, layoutRects, moveTab, openTab, restoreWorkbenchLayout, splitGroup, WORKBENCH_STORAGE_KEY } from '../lib/workbenchTabs.js'
import { sessionActivity } from '../lib/backgroundTaskPresentation.js'
import { useTheme } from '../composables/useTheme.js'
import TaskTimelinePane from './TaskTimelinePane.vue'
import WorkspaceInspector from './WorkspaceInspector.vue'
import TaskDetailsDrawer from './TaskDetailsDrawer.vue'
import V2SettingsDialog from './V2SettingsDialog.vue'
import PxActionMenu from './PxActionMenu.vue'
import PxIconButton from './PxIconButton.vue'
import PxButton from './PxButton.vue'
import AgentProviderIcon from './AgentProviderIcon.vue'
const TaskTerminal = defineAsyncComponent(() => import('./TaskTerminal.vue'))
const props = defineProps({ tasks: { type: Array, default: () => [] }, projects: { type: Array, default: () => [] }, ready: Boolean, mobile: Boolean, fallbackTaskId: { type: String, default: '' } })
const emit = defineEmits(['focus-task', 'agent-event', 'changed'])
const { isDark } = useTheme()
const rootElement = ref(null)
const layout = ref(createLayout())
const contextProjectId = ref('')
const dragging = ref('')
const resizingId = ref('')
const dropTarget = ref(null)
const initialized = ref(false)
const mountedPanels = ref(new Set())
let resizeCleanup = null
const geometry = computed(() => layout.value ? layoutRects(layout.value.root) : { leaves: [], dividers: [] })
const panels = computed(() => groups(layout.value.root).flatMap(group => group.tabs.map(tab => ({ ...tab, groupId: group.id, key: tab.id, active: !props.mobile && group.activeId === tab.id }))))
const renderedPanels = computed(() => panels.value.filter(panel => panel.active || mountedPanels.value.has(panel.key)))
watch(panels, entries => {
  const existing = new Set(entries.map(panel => panel.key))
  mountedPanels.value = new Set([...mountedPanels.value].filter(key => existing.has(key)).concat(entries.filter(panel => panel.active).map(panel => panel.key)))
}, { immediate: true })
const icons = { files: Files, diff: FileDiff, 'task-details': Info, settings: Settings, terminal: TerminalSquare }
const names = { files: '文件', diff: 'Diff', 'task-details': '会话详情', terminal: '终端', settings: '设置' }
const splitItems = [
  { id: 'left', label: '向左拆分', icon: ArrowLeft }, { id: 'right', label: '向右拆分', icon: ArrowRight },
  { id: 'top', label: '向上拆分', icon: ArrowUp }, { id: 'bottom', label: '向下拆分', icon: ArrowDown },
]
function taskFor(id) { return props.tasks.find(task => task.id === id) }
function projectFor(id) { return props.projects.find(project => project.id === taskFor(id)?.projectId) }
function title(tab) {
  if (tab.type === 'session') return taskFor(tab.taskId)?.title || '会话'
  return tab.type === 'settings' ? '设置' : `${names[tab.type]} · ${taskFor(tab.taskId)?.title || ''}`
}
function persist() {
  if (!initialized.value) return
  try { localStorage.setItem(WORKBENCH_STORAGE_KEY, JSON.stringify({ version: 2, layout: layout.value })) } catch { /* 存储不可用时仍可使用标签工作台。 */ }
}
function announceFocus() {
  if (props.mobile || !layout.value) return
  const group = layout.value && findNode(layout.value.root, layout.value.focusedId)
  const tab = group?.tabs?.find(tab => tab.id === group.activeId)
  const visibleTaskIds = groups(layout.value.root).flatMap(group => group.tabs.filter(tab => tab.type === 'session' && tab.id === group.activeId).map(tab => tab.taskId))
  if (tab?.taskId) contextProjectId.value = taskFor(tab.taskId)?.projectId || ''
  emit('focus-task', tab?.taskId || '', contextProjectId.value, visibleTaskIds)
}
function openSession(task) {
  if (!task) return
  openTab(layout.value, { type: 'session', taskId: task.id })
  announceFocus(); revealActiveTab()
}
function openSettings() {
  openTab(layout.value, { type: 'settings' })
  announceFocus(); revealActiveTab()
}
function focusGroup(id) {
  if (!layout.value) return
  layout.value.focusedId = id
  announceFocus()
}
function revealActiveTab(focus = false) {
  nextTick(() => {
    const tab = rootElement.value?.querySelector(`[data-group-id="${layout.value?.focusedId}"] [role="tab"][aria-selected="true"]`)
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (focus) tab?.focus({ preventScroll: true })
  })
}
function activate(group, id) {
  group.activeId = id
  focusGroup(group.id)
  revealActiveTab()
}
function close(id) { closeTab(layout.value, id); announceFocus(); revealActiveTab(true) }
function openResource(taskId, request, sourceGroupId) {
  const state = layout.value
  if (!state || !taskFor(taskId)) return
  const source = sourceGroupId || state.focusedId
  const id = openTab(state, { type: request.type || (request.intent === 'diff' ? 'diff' : 'files'), taskId, ...(request.path ? { path: request.path, line: request.line || null } : {}) }, source)
  if (request.terminalId) {
    const tab = groups(state.root).flatMap(group => group.tabs).find(tab => tab.id === id)
    updateSelection(id, { terminalId: request.terminalId, terminalSelection: (tab?.terminalSelection || 0) + 1 })
  }
  announceFocus(); revealActiveTab()
}
function updateSelection(id, selection) {
  const tab = groups(layout.value.root).flatMap(group => group.tabs).find(tab => tab.id === id)
  if (tab) Object.assign(tab, selection)
}
function split(id, direction, tab = '') {
  const group = findNode(layout.value.root, id)
  const moving = tab || group.activeId
  if (moving && group.tabs.length > 1) moveTab(layout.value, moving, id, direction)
  else splitGroup(layout.value, id, direction)
  announceFocus()
}
function tabMenu(group, tab) {
  return [...splitItems, ...(geometry.value.leaves.length > 1 ? [{ separator: true }, ...geometry.value.leaves.filter(item => item.group.id !== group.id).map(item => ({ id: `move:${item.group.id}`, label: `移至分区 ${geometry.value.leaves.indexOf(item) + 1}`, icon: Columns2 }))] : []), { separator: true }, { id: 'close', label: '关闭标签', icon: X }, { id: 'close-others', label: '关闭其他标签', icon: X, disabled: group.tabs.length < 2 }]
}
function menuAction(action, group, tab) {
  if (action === 'close') close(tab.id)
  else if (action === 'close-others') {
    for (const other of [...group.tabs]) if (other.id !== tab.id) closeTab(layout.value, other.id)
    activate(group, tab.id)
    revealActiveTab(true)
  }
  else if (action.startsWith('move:')) { moveTab(layout.value, tab.id, action.slice(5)); announceFocus() }
  else split(group.id, action, tab.id)
}
function rectStyle(rect, content = false) {
  if (!rect) return { display: 'none' }
  return { left: `calc(${rect.x}% + 2px)`, top: `calc(${rect.y}% + ${content ? 38 : 2}px)`, width: `calc(${rect.w}% - 4px)`, height: `calc(${rect.h}% - ${content ? 40 : 4}px)` }
}
function panelStyle(panel) { return rectStyle(geometry.value.leaves.find(rect => rect.group.id === panel.groupId), true) }
function dividerStyle(rect) {
  return rect.node.axis === 'x'
    ? { left: `calc(${rect.x + rect.w * rect.node.ratio}% - 3px)`, top: `${rect.y}%`, width: '6px', height: `${rect.h}%`, cursor: 'col-resize' }
    : { left: `${rect.x}%`, top: `calc(${rect.y + rect.h * rect.node.ratio}% - 3px)`, width: `${rect.w}%`, height: '6px', cursor: 'row-resize' }
}
function startResize(event, rect) {
  if (event.button !== 0) return
  event.preventDefault()
  resizeCleanup?.()
  resizingId.value = rect.node.id
  const bounds = rootElement.value.getBoundingClientRect()
  const horizontal = rect.node.axis === 'x'
  const move = event => {
    const position = horizontal ? (event.clientX - bounds.left) / bounds.width * 100 : (event.clientY - bounds.top) / bounds.height * 100
    rect.node.ratio = Math.max(0.15, Math.min(0.85, (position - (horizontal ? rect.x : rect.y)) / (horizontal ? rect.w : rect.h)))
  }
  resizeCleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', resizeCleanup); window.removeEventListener('pointercancel', resizeCleanup); resizeCleanup = null; resizingId.value = '' }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', resizeCleanup)
  window.addEventListener('pointercancel', resizeCleanup)
}
function resizeKey(event, node) {
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return
  event.preventDefault()
  node.ratio = Math.max(0.15, Math.min(0.85, node.ratio + (['ArrowLeft', 'ArrowUp'].includes(event.key) ? -0.05 : 0.05)))
}
function startDrag(event, tab) {
  dragging.value = tab.id
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData('application/x-promptx-tab', tab.id)
}
function endDrag() { dragging.value = ''; dropTarget.value = null }
function dragOver(event, rect) {
  if (!dragging.value) return
  event.preventDefault()
  const bounds = event.currentTarget.getBoundingClientRect()
  const x = (event.clientX - bounds.left) / bounds.width, y = (event.clientY - bounds.top) / bounds.height
  const direction = y < 0.2 ? 'top' : y > 0.8 ? 'bottom' : x < 0.25 ? 'left' : x > 0.75 ? 'right' : ''
  dropTarget.value = { groupId: rect.group.id, direction }
}
function drop(event, rect, beforeId = '') {
  event.preventDefault()
  if (!dragging.value) return
  moveTab(layout.value, dragging.value, rect.group.id, beforeId ? '' : dropTarget.value?.direction || '', beforeId)
  endDrag(); announceFocus()
}
function tabKey(event, group, tab) {
  if (event.target !== event.currentTarget) return
  if (['Enter', ' '].includes(event.key)) { event.preventDefault(); activate(group, tab.id); return }
  if (event.key === 'Delete') { event.preventDefault(); close(tab.id); return }
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const index = group.tabs.findIndex(item => item.id === tab.id)
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? group.tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + group.tabs.length) % group.tabs.length
  activate(group, group.tabs[next].id)
  const container = event.currentTarget.parentElement
  nextTick(() => container?.querySelector('[aria-selected="true"]')?.focus())
}
watch(() => props.ready, ready => {
  if (!ready || initialized.value) return
  let raw
  try { raw = localStorage.getItem(WORKBENCH_STORAGE_KEY) } catch {}
  const restored = restoreWorkbenchLayout(raw, props.tasks)
  layout.value = restored || createLayout()
  contextProjectId.value = taskFor(props.fallbackTaskId)?.projectId || props.projects[0]?.id || ''
  initialized.value = true
  if (!restored) {
    const task = taskFor(props.fallbackTaskId) || props.tasks[0]
    if (task) openSession(task)
  }
  announceFocus(); persist()
}, { immediate: true })
watch(layout, persist, { deep: true })
watch(() => props.mobile, mobile => { if (!mobile && initialized.value) announceFocus() })
watch(() => props.tasks, () => {
  if (!initialized.value) return
  const ids = new Set(props.tasks.map(task => task.id))
  for (const tab of groups(layout.value.root).flatMap(group => group.tabs)) if (tab.taskId && !ids.has(tab.taskId)) closeTab(layout.value, tab.id)
  if (!props.projects.some(project => project.id === contextProjectId.value)) contextProjectId.value = props.projects[0]?.id || ''
  announceFocus()
})
onBeforeUnmount(() => resizeCleanup?.())
defineExpose({ openSession, openSettings })
</script>

<template>
  <div ref="rootElement" class="desktop-workbench relative h-full min-h-0 min-w-0 overflow-hidden" @dragend="endDrag">
    <section v-for="rect in geometry.leaves" :key="rect.group.id" class="workbench-group absolute overflow-hidden" :class="{ 'is-focused': layout.focusedId === rect.group.id }" :style="rectStyle(rect)" :data-group-id="rect.group.id" @pointerdown="focusGroup(rect.group.id)" @focusin="focusGroup(rect.group.id)">
      <header class="workbench-tab-bar flex h-9 min-w-0 items-center">
        <div class="workbench-tab-list flex h-full min-w-0 flex-1 overflow-x-auto" role="tablist" aria-label="工作区标签" @dragover.prevent="dropTarget = { groupId: rect.group.id, direction: '' }" @drop="drop($event, rect)">
          <div v-for="tab in rect.group.tabs" :key="tab.id" class="workbench-tab relative flex shrink-0 items-center gap-2 text-xs" :class="{ 'is-active': rect.group.activeId === tab.id }" role="tab" :aria-selected="rect.group.activeId === tab.id" :aria-label="title(tab)" :tabindex="rect.group.activeId === tab.id ? 0 : -1" :title="[projectFor(tab.taskId)?.displayName, title(tab)].filter(Boolean).join(' · ')" draggable="true" @click="activate(rect.group, tab.id)" @keydown="tabKey($event, rect.group, tab)" @dragstart="startDrag($event, tab)" @dragover.stop.prevent="dropTarget = { groupId: rect.group.id, direction: '' }" @drop.stop="drop($event, rect, tab.id)" @auxclick.middle.prevent="close(tab.id)">
            <AgentProviderIcon v-if="tab.type === 'session'" :provider-id="taskFor(tab.taskId)?.providerId" />
            <component :is="icons[tab.type]" v-else class="h-3.5 w-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ title(tab) }}</span>
            <span v-if="tab.type === 'session' && sessionActivity(taskFor(tab.taskId)).waiting" class="shrink-0 text-[10px] text-[var(--theme-warningText)]">待回答</span>
            <LoaderCircle v-else-if="tab.type === 'session' && sessionActivity(taskFor(tab.taskId)).running" class="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="运行中" />
            <span v-if="tab.type === 'session' && taskFor(tab.taskId)?.requiresAttention" class="workbench-attention" aria-label="需要关注" />
            <PxActionMenu class="tab-menu h-6 w-6 shrink-0" :label="`${title(tab)} 的标签操作`" :items="tabMenu(rect.group, tab)" @click.stop @select="menuAction($event, rect.group, tab)" />
            <button type="button" class="tab-close flex h-6 w-6 shrink-0 items-center justify-center rounded-full" :aria-label="`关闭标签 ${title(tab)}`" :title="`关闭标签 ${title(tab)}`" @click.stop="close(tab.id)"><X class="h-3 w-3" /></button>
          </div>
        </div>
        <PxIconButton class="h-7 w-7 shrink-0" label="向右拆分" @click="split(rect.group.id, 'right')"><Columns2 class="h-3.5 w-3.5" /></PxIconButton>
        <PxIconButton class="h-7 w-7 shrink-0" label="向下拆分" @click="split(rect.group.id, 'bottom')"><Rows2 class="h-3.5 w-3.5" /></PxIconButton>
      </header>
      <div v-if="!rect.group.tabs.length" class="theme-empty-state flex h-[calc(100%-36px)] flex-col items-center justify-center p-5 text-center text-xs">
        <MessageSquare class="mb-3 h-7 w-7" />
        <p>从左栏打开会话，或将标签拖到这里</p>
        <PxButton v-if="geometry.leaves.length > 1" variant="ghost" size="sm" class="mt-4" @click="closeEmptyGroup(layout, rect.group.id); announceFocus()">
          <X class="h-3.5 w-3.5" aria-hidden="true" />关闭空分区
        </PxButton>
      </div>
    </section>
    <!-- 内容保持平铺和稳定 key；移动标签、改变树结构时不会重建会话和输入框。 -->
    <section v-for="panel in renderedPanels" v-show="panel.active" :key="panel.key" class="workbench-content absolute flex min-h-0 min-w-0 flex-col overflow-hidden" :style="panelStyle(panel)" role="tabpanel" :aria-label="title(panel)" :inert="!panel.active" @pointerdown.capture="focusGroup(panel.groupId)" @focusin.capture="focusGroup(panel.groupId)">
      <TaskTimelinePane v-if="panel.type === 'session'" class="h-full" :task="taskFor(panel.taskId)" :project="projectFor(panel.taskId)" :focused="panel.active && layout?.focusedId === panel.groupId" :visible="panel.active" tabbed :split-enabled="geometry.leaves.length > 1" @open-tab="openResource(panel.taskId, $event, panel.groupId)" @agent-event="emit('agent-event', $event)" @changed="emit('changed')" />
      <WorkspaceInspector v-else-if="['files', 'diff'].includes(panel.type)" class="h-full" :task-id="panel.taskId" :workspace-cwd="taskFor(panel.taskId)?.environment?.cwd || projectFor(panel.taskId)?.repositoryRoot" :is-dark="isDark" :mode="panel.type" :target-path="panel.path || ''" :target-line="panel.line" :visible="panel.active" tabbed @selection-change="updateSelection(panel.id, $event)" @close="close(panel.id)" />
      <TaskDetailsDrawer tabbed v-else-if="panel.type === 'task-details'" class="h-full" :task-id="panel.taskId" @close="close(panel.id)" @changed="emit('changed')" />
      <TaskTerminal v-else-if="panel.type === 'terminal'" class="workbench-terminal" :task-id="panel.taskId" :terminal-id="panel.terminalId || ''" :selection-key="panel.terminalSelection || 0" :visible="panel.active" embedded @close="close(panel.id)" />
      <V2SettingsDialog v-else-if="panel.type === 'settings'" open embedded @close="close(panel.id)" @changed="emit('changed')" />
    </section>
    <div v-for="rect in geometry.dividers" :key="rect.node.id" class="workbench-divider theme-resize-handle absolute z-20" :class="{ 'is-resizing': resizingId === rect.node.id }" :style="dividerStyle(rect)" role="separator" :aria-orientation="rect.node.axis === 'x' ? 'vertical' : 'horizontal'" aria-label="调整分区大小" :aria-valuenow="Math.round(rect.node.ratio * 100)" aria-valuemin="15" aria-valuemax="85" tabindex="0" @pointerdown="startResize($event, rect)" @keydown="resizeKey($event, rect.node)" />
    <template v-if="dragging">
      <div v-for="rect in geometry.leaves" :key="rect.group.id" class="workbench-drop-zone absolute z-30" :style="rectStyle(rect, true)" @dragover="dragOver($event, rect)" @drop="drop($event, rect)">
        <div v-if="dropTarget?.groupId === rect.group.id" class="workbench-drop-preview absolute inset-0 flex items-center justify-center text-xs" :class="dropTarget.direction">{{ dropTarget.direction ? '松开以拆分' : '松开以移动标签' }}</div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.desktop-workbench { background: var(--theme-appBg); }
.workbench-group, .workbench-content { background: var(--theme-appPanel); }
.workbench-group { border: 0; border-radius: var(--theme-layoutRadius); }
.workbench-content { border-radius: 0 0 var(--theme-layoutRadius) var(--theme-layoutRadius); }
.workbench-content > :deep(.panel) { border-radius: 0; }
.workbench-tab-bar { background: var(--theme-appPanelInset); }
.workbench-tab-list { align-items: flex-end; padding: 4px 8px 0; scrollbar-width: none; }
.workbench-tab-list::-webkit-scrollbar { display: none; }
.workbench-tab {
  flex: 0 0 220px;
  width: 220px;
  height: 32px;
  padding: 0 10px;
  border-radius: 12px 12px 0 0;
  color: var(--theme-textMuted);
  cursor: pointer;
}
.workbench-tab:not(.is-active)::after {
  content: '';
  position: absolute;
  right: 0;
  top: 8px;
  bottom: 8px;
  width: 1px;
  background: var(--theme-borderStrong);
  opacity: 0.65;
  pointer-events: none;
}
.workbench-tab.is-active { z-index: 1; background: var(--theme-appPanel); color: var(--theme-textPrimary); }
.workbench-group.is-focused .workbench-tab.is-active { color: var(--theme-accent); font-weight: bold; }
.workbench-tab.is-active::before, .workbench-tab.is-active::after {
  content: '';
  position: absolute;
  bottom: 0;
  width: 8px;
  height: 8px;
  pointer-events: none;
}
.workbench-tab.is-active::before { left: -8px; background: radial-gradient(circle at 0 0, transparent 7.5px, var(--theme-appPanel) 8px); }
.workbench-tab.is-active::after { right: -8px; background: radial-gradient(circle at 100% 0, transparent 7.5px, var(--theme-appPanel) 8px); }
.workbench-tab:not(.is-active):hover { background: var(--theme-appPanelHover); }
.workbench-tab:has(+ .is-active)::after, .workbench-tab:has(+ :hover)::after, .workbench-tab:hover:not(.is-active)::after { opacity: 0; }
.tab-close:hover { background: var(--theme-appPanelActive); }
.workbench-tab:focus-visible { outline: 1px solid var(--theme-focusRing); outline-offset: -2px; }
.tab-menu { opacity: 0; }
.workbench-tab:hover .tab-menu, .workbench-tab:focus-within .tab-menu { opacity: 1; }
.workbench-attention { width: 6px; height: 6px; border-radius: 50%; background: var(--theme-warning); }
.workbench-drop-preview { border: 1px dashed var(--theme-accent); background: color-mix(in srgb, var(--theme-accent) 20%, transparent); color: var(--theme-textPrimary); pointer-events: none; }
.workbench-drop-preview.left { right: 50%; }
.workbench-drop-preview.right { left: 50%; }
.workbench-drop-preview.top { bottom: 50%; }
.workbench-drop-preview.bottom { top: 50%; }
.workbench-terminal { height: 100% !important; max-height: 100% !important; position: relative !important; inset: auto !important; }
.workbench-terminal :deep(.terminal-resizer) { display: none; }
</style>
