<script setup>
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Maximize2, Minimize2, Plus, X, RotateCw, Pencil } from 'lucide-vue-next'
import PxIconButton from './PxIconButton.vue'
import TerminalScreen from './TerminalScreen.vue'
import { request } from '../lib/request.js'

const props = defineProps({ taskId: { type: String, required: true }, visible: { type: Boolean, default: true }, embedded: Boolean })
const emit = defineEmits(['close'])
const root = ref(null)
const terminals = ref([])
const error = ref('')
const busy = ref(false)
const loading = ref(true)
const activeId = ref('')
const editingId = ref('')
const editName = ref('')
const maximized = ref(false)
const height = ref(260)
const active = computed(() => terminals.value.find(item => item.id === activeId.value))
const base = `/api/v2/tasks/${encodeURIComponent(props.taskId)}/terminals`
const storageKey = `promptx:terminal-tab:${props.taskId}`
let disposed = false, timer, revision = 0, dragCleanup
try { activeId.value = localStorage.getItem(storageKey) || '' } catch {}
watch(activeId, value => { try { localStorage.setItem(storageKey, value) } catch {} })
watch(() => props.visible, visibility)
function select(id) { activeId.value = id; editingId.value = '' }
function reconcile(items) {
  terminals.value = items
  if (!items.some(item => item.id === activeId.value)) activeId.value = items[0]?.id || ''
}
async function refresh() {
  const version = ++revision
  try {
    const data = await request(base, { cache: 'no-store' })
    if (!disposed && version === revision) reconcile(data.terminals)
  } catch (cause) { if (!disposed && version === revision) error.value = cause.message }
}
function scheduleList() {
  clearTimeout(timer)
  if (!disposed && props.visible && !document.hidden) timer = setTimeout(async () => { if (!busy.value) await refresh(); scheduleList() }, 5000)
}
function visibility() {
  clearTimeout(timer)
  if (props.visible && !document.hidden) { if (!busy.value) refresh(); scheduleList() }
}
async function create(ensure = false) {
  if (busy.value || disposed) return
  busy.value = true; error.value = ''; revision++
  try {
    const data = await request(base, { method: 'POST', body: JSON.stringify({ requestId: crypto.randomUUID(), ensure, cols: 80, rows: 24 }) })
    if (disposed) return
    if (!terminals.value.some(item => item.id === data.terminal.id)) terminals.value.push(data.terminal)
    activeId.value = data.terminal.id
  } catch (cause) { if (!disposed) error.value = cause.message }
  finally { busy.value = false }
}
async function remove(item) {
  if (busy.value) return
  busy.value = true; error.value = ''; revision++
  try {
    await request(`${base}/${item.id}`, { method: 'DELETE' })
    if (disposed) return
    const index = terminals.value.findIndex(entry => entry.id === item.id)
    terminals.value = terminals.value.filter(entry => entry.id !== item.id)
    if (activeId.value === item.id) activeId.value = terminals.value[Math.max(0, index - 1)]?.id || terminals.value[0]?.id || ''
    if (editingId.value === item.id) editingId.value = ''
  } catch (cause) { error.value = cause.message }
  finally { busy.value = false }
}
function edit(item) { editingId.value = item.id; editName.value = item.name }
async function rename(item) {
  if (busy.value || editingId.value !== item.id) return
  const name = editName.value.trim()
  editingId.value = ''
  if (!name || name === item.name) return
  busy.value = true; revision++
  try {
    const data = await request(`${base}/${item.id}`, { method: 'PATCH', body: JSON.stringify({ name }) })
    Object.assign(item, data.terminal)
  } catch (cause) { error.value = cause.message }
  finally { busy.value = false }
}
async function restart() {
  const item = active.value
  if (!item || busy.value) return
  busy.value = true; error.value = ''; revision++
  try {
    const data = await request(`${base}/${item.id}/restart`, { method: 'POST', body: JSON.stringify({ cols: 80, rows: 24 }) })
    if (disposed) return
    const index = terminals.value.findIndex(entry => entry.id === item.id)
    terminals.value.splice(index, 1, data.terminal)
    activeId.value = data.terminal.id
  } catch (cause) { error.value = cause.message }
  finally { busy.value = false }
}
function updateState(state) {
  const item = terminals.value.find(item => item.id === state.id)
  if (item) Object.assign(item, state)
}
function startDrag(event) {
  if (maximized.value) return
  event.preventDefault()
  const startY = event.clientY, initial = height.value
  const move = event => { height.value = Math.max(140, Math.min(root.value.parentElement.clientHeight - 100, initial + startY - event.clientY)) }
  const end = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', end); dragCleanup = null }
  dragCleanup = end
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', end)
}
onMounted(async () => {
  await refresh()
  if (!disposed && !error.value && !terminals.value.length) await create(true)
  loading.value = false
  if (!disposed) { document.addEventListener('visibilitychange', visibility); scheduleList() }
})
onBeforeUnmount(() => { disposed = true; revision++; clearTimeout(timer); dragCleanup?.(); document.removeEventListener('visibilitychange', visibility) })
</script>

<template>
  <section ref="root" class="task-terminal flex min-h-0 shrink-0 flex-col" :class="{ 'is-maximized': maximized }" :style="maximized ? {} : { height: `${height}px`, maxHeight: '75%' }">
    <div class="terminal-resizer shrink-0" role="separator" aria-label="调整终端高度" aria-orientation="horizontal" tabindex="0" @pointerdown="startDrag" @keydown.up.prevent="height += 20" @keydown.down.prevent="height = Math.max(140, height - 20)" />
    <header class="flex min-h-9 shrink-0 items-center gap-1 px-2">
      <div class="flex min-w-0 flex-1 items-center overflow-x-auto" role="tablist" aria-label="会话终端">
        <div v-for="item in terminals" :key="item.id" class="terminal-tab flex shrink-0 items-center" :class="{ 'is-active': item.id === activeId }">
          <input v-if="editingId === item.id" :ref="el => el?.focus()" v-model="editName" class="tool-input mx-1 w-28 px-1 text-xs" aria-label="终端名称" maxlength="40" @keydown.enter.prevent="rename(item)" @keydown.esc.prevent="editingId = ''" @blur="rename(item)">
          <button v-else class="max-w-40 truncate px-2 py-1.5 text-xs" role="tab" :aria-selected="item.id === activeId" :title="`${item.name} · ${item.running ? '运行中' : '已退出'}`" @click="select(item.id)" @dblclick="edit(item)">{{ item.name }}<span v-if="!item.running" class="theme-muted-text ml-1 text-[10px]">已退出</span></button>
          <PxIconButton class="h-6 w-6" :label="`关闭 ${item.name}（结束进程）`" :disabled="busy" @click="remove(item)"><X class="h-3 w-3" /></PxIconButton>
        </div>
      </div>
      <PxIconButton class="h-7 w-7 shrink-0" label="新建终端" :disabled="busy || loading" @click="create(false)"><Plus class="h-3.5 w-3.5" /></PxIconButton>
      <PxIconButton v-if="active" class="h-7 w-7 shrink-0" label="重命名终端" :disabled="busy" @click="edit(active)"><Pencil class="h-3.5 w-3.5" /></PxIconButton>
      <PxIconButton v-if="active && !active.running" class="h-7 w-7 shrink-0" label="重新启动终端" :disabled="busy" @click="restart"><RotateCw class="h-3.5 w-3.5" /></PxIconButton>
      <PxIconButton v-if="!embedded" class="h-7 w-7 shrink-0" :label="maximized ? '还原终端' : '放大终端'" @click="maximized = !maximized"><Minimize2 v-if="maximized" class="h-3.5 w-3.5" /><Maximize2 v-else class="h-3.5 w-3.5" /></PxIconButton>
      <PxIconButton v-if="!embedded" class="h-7 w-7 shrink-0" label="收起终端（保留进程）" @click="emit('close')"><X class="h-3.5 w-3.5" /></PxIconButton>
    </header>
    <p v-if="error" class="theme-status-danger px-2 py-1 text-xs" role="alert">{{ error }} <button class="underline" @click="refresh">刷新列表</button></p>
    <p v-if="loading" class="theme-muted-text p-3 text-xs">正在连接终端…</p>
    <TerminalScreen :visible="visible" v-if="activeId" :key="activeId" :task-id="taskId" :terminal-id="activeId" @state="updateState" @missing="refresh" />
    <div v-else-if="!loading" class="theme-empty-state flex flex-1 items-center justify-center text-xs">点击 ＋ 新建终端</div>
  </section>
</template>

<style scoped>
.task-terminal { background: var(--theme-appPanel); border-top: 1px solid var(--theme-borderDefault); }
.task-terminal.is-maximized { position: absolute; inset: 3.5rem 0 0; z-index: 25; }
.terminal-resizer { height: 5px; cursor: ns-resize; touch-action: none; }
.terminal-resizer:hover, .terminal-resizer:focus-visible { background: var(--theme-accent); }
.terminal-tab { color: var(--theme-textMuted); border-bottom: 2px solid transparent; }
.terminal-tab.is-active { color: var(--theme-accentText); border-bottom-color: var(--theme-accent); background: var(--theme-accentSoft); }
</style>
