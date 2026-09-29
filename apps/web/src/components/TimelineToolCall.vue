<script>
import { createToolDetailClient } from '../lib/toolDetailClient.js'
import { request } from '../lib/request.js'
import { isRemoteTransport } from '../lib/transport.js'
let localClient, relayClient
function getClient(remote) {
  if (remote) return relayClient ||= createToolDetailClient({ request, remote: true })
  return localClient ||= createToolDetailClient({ request })
}
</script>

<script setup>
import { computed, inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { Check, ChevronRight, Circle, CircleAlert, FileDiff, FileText, Globe, LoaderCircle, Search, Terminal, Users, Wrench } from 'lucide-vue-next'
import { isToolExpanded, toolExpansionKey } from '../lib/toolExpansion.js'
import { useToolPreferences } from '../composables/useToolPreferences.js'
import ToolDetailContent from './ToolDetailContent.vue'
import { workspaceLinksForTool } from '../lib/timelineWorkspaceLinks.js'

const props = defineProps({ entry: { type: Object, required: true }, taskId: String, workspaceCwd: String, running: Boolean, activeTurnId: String })
const emit = defineEmits(['rendered', 'open-workspace-path'])
const visible = inject('timelineVisible', ref(true))
const pauseTimelineFollow = inject('pauseTimelineFollow', () => {})
const epoch = inject('timelineEpoch', ref(''))
const expansionState = inject('toolExpansion', new Map())
const expansionKey = computed(() => toolExpansionKey(epoch.value, props.entry.turnId, props.entry.item.callId))
const remote = isRemoteTransport()
const client = getClient(remote)
const { autoExpand } = useToolPreferences()
const expanded = computed(() => isToolExpanded({ enabled: autoExpand.value, remote, manual: expansionState.get(expansionKey.value) }))
const loading = ref(false), error = ref(''), data = ref(null)
const pageVisible = ref(typeof document === 'undefined' || !document.hidden)
const copied = ref('')
const item = computed(() => props.entry.item)
const summary = computed(() => item.value.detail || {})
const links = computed(() => workspaceLinksForTool(item.value, props.workspaceCwd))
const icon = computed(() => ({ shell: Terminal, read: FileText, write: FileText, edit: FileDiff, search: Search, fetch: Globe, sub_agent: Users }[summary.value.kind] || Wrench))
const active = computed(() => item.value.status === 'running' && props.running && props.entry.turnId === props.activeTurnId)
const identity = computed(() => JSON.stringify([props.taskId, props.entry.turnId || '', item.value.callId, epoch.value]))
const cacheKey = computed(() => `${identity.value}:${props.entry.seqEnd}`)
const canLoad = computed(() => expanded.value && visible.value && pageVisible.value)
const bodySections = computed(() => (data.value?.sections || []).filter(section => !['cwd', 'exit', 'duration'].includes(section.id)))
const directory = computed(() => data.value?.sections?.find(section => section.id === 'cwd'))
const exitCode = computed(() => data.value?.sections?.find(section => section.id === 'exit'))
const elapsed = computed(() => {
  const section = data.value?.sections?.find(section => section.id === 'duration')
  if (!section) return ''
  const ms = Number(section.text)
  return Number.isFinite(ms) ? ms < 1000 ? `${ms} 毫秒` : `${(ms / 1000).toFixed(1)} 秒` : section.text
})
const hasModification = computed(() => data.value?.hasChanges && item.value.status === 'completed')
let controller, timer, generation = 0, loadedRevision = 0

function toggleExpanded() {
  if (!expanded.value) pauseTimelineFollow()
  expansionState.set(expansionKey.value, !expanded.value)
}

function stop() {
  generation++; clearTimeout(timer); controller?.abort(); controller = null; loading.value = false
}
async function load(section = null) {
  if (!canLoad.value || loading.value) return
  clearTimeout(timer)
  const token = generation
  const revision = props.entry.seqEnd
  const key = cacheKey.value
  controller = new AbortController(); loading.value = true; error.value = ''
  const params = { turnId: props.entry.turnId || '', callId: item.value.callId, epoch: epoch.value }
  try {
    if (section) {
      const result = await client.fetch(props.taskId, { ...params, section: section.id, cursor: section.cursor }, controller.signal)
      if (token !== generation) return
      section.text += result.section.text
      Object.assign(section, { hasMore: result.section.hasMore, nextOffset: result.section.nextOffset, cursor: result.section.cursor })
      data.value.revision = result.revision
    } else {
      const result = await client.fetch(props.taskId, { ...params, ...(data.value ? { manifest: '1' } : {}) }, controller.signal)
      if (token !== generation) return
      if (data.value) for (const next of result.sections) {
        const current = data.value.sections.find(value => value.id === next.id)
        // 尚有未读内容时不后台预取正文；由“加载更多”校验游标。
        if (current?.hasMore) { Object.assign(next, current); continue }
        const tail = await client.fetch(props.taskId, { ...params, section: next.id, ...(current?.cursor ? { cursor: current.cursor } : {}) }, controller.signal)
        if (token !== generation) return
        Object.assign(next, tail.section, { text: (current?.text || '') + tail.section.text })
      }
      data.value = result
      loadedRevision = revision
    }
    client.put(key, data.value)
    await nextTick(); emit('rendered')
  } catch (reason) {
    if (token !== generation || reason.name === 'AbortError') return
    if (reason.statusCode === 409) {
      data.value = null; loadedRevision = 0
      error.value = '详情已更新，请点击重新加载。'
    } else error.value = reason.message || '详情加载失败。'
  } finally {
    if (token === generation) {
      loading.value = false
      if (!error.value && props.entry.seqEnd !== revision && canLoad.value) schedule()
    }
  }
}
function schedule() {
  clearTimeout(timer)
  if (!canLoad.value || loading.value) return
  if (!data.value) {
    const cached = client.get(cacheKey.value)
    if (cached) { data.value = cached; loadedRevision = props.entry.seqEnd; return }
  }
  if (!data.value || loadedRevision !== props.entry.seqEnd) timer = setTimeout(() => load(), data.value ? client.delay : 0)
}
async function copy(section) {
  try { await navigator.clipboard.writeText(section.text); copied.value = section.id } catch { error.value = '复制失败，请手动选择文本复制。' }
}
function onVisibility() { pageVisible.value = !document.hidden }
document.addEventListener('visibilitychange', onVisibility)
watch(identity, () => { stop(); data.value = null; loadedRevision = 0; schedule() })
watch(canLoad, enabled => { if (enabled) schedule(); else stop() }, { immediate: true })
watch(() => props.entry.seqEnd, schedule)
onBeforeUnmount(() => { stop(); document.removeEventListener('visibilitychange', onVisibility) })
</script>

<template>
  <div class="timeline-tool min-w-0" :data-tool-kind="summary.kind">
    <button type="button" class="tool-toggle flex w-full min-w-0 items-start gap-2 text-left" :aria-expanded="expanded" :title="item.name" @click="toggleExpanded">
      <component :is="icon" class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span class="min-w-0 flex-1">
        <span class="flex min-w-0 items-center gap-2">
          <span class="shrink-0 font-medium">{{ summary.displayName || item.name }}</span>
          <span v-if="remote" class="theme-muted-text truncate">{{ summary.summary }}</span>
          <Check v-if="item.status === 'completed'" class="h-3.5 w-3.5 shrink-0" aria-label="执行完成" />
          <LoaderCircle v-else-if="active" class="h-3.5 w-3.5 shrink-0 animate-spin" aria-label="执行中" />
          <CircleAlert v-else-if="item.status === 'failed'" class="theme-danger-text h-3.5 w-3.5 shrink-0" aria-label="工具执行失败" />
          <Circle v-else class="theme-muted-text h-3.5 w-3.5 shrink-0" :aria-label="item.status === 'canceled' ? '已取消' : '本轮已结束，未收到工具完成状态'" />
          <ChevronRight class="theme-muted-text ml-auto h-3.5 w-3.5 shrink-0" :class="{ 'rotate-90': expanded }" />
        </span>
        <span v-if="!remote && summary.summary" class="theme-muted-text tool-summary mt-1 block font-mono text-[11px]">{{ summary.summary }}</span>
      </span>
    </button>
    <div v-if="!remote && links.length || expanded && links.length" class="ml-5 mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
      <button v-for="link in links" :key="link.path" type="button" class="workspace-path-link min-w-0 truncate border-0 bg-transparent p-0 text-left font-mono text-[10px]" :title="`${link.intent === 'diff' ? '查看当前 Diff' : '查看当前文件'}：${link.path}`" @click="emit('open-workspace-path', link)">{{ link.path }}<template v-if="link.line">:{{ link.line }}</template></button>
    </div>
    <div v-if="item.error?.message && !expanded" class="theme-danger-text ml-5 mt-1 break-words">{{ item.error.message }}</div>
    <div v-if="expanded" class="tool-details ml-5 mt-2 min-w-0 space-y-3 rounded border p-3">
      <div class="theme-muted-text text-[10px]">{{ item.name }}</div>
      <div v-if="directory" class="tool-directory theme-muted-text flex min-w-0 items-center gap-2 text-[11px]">
        <span class="shrink-0">目录</span><code class="min-w-0 flex-1 truncate" :title="directory.text">{{ directory.text }}</code>
        <button type="button" class="shrink-0 border-0 bg-transparent" @click="copy(directory)">{{ copied === 'cwd' ? '已复制' : '复制' }}</button>
      </div>
      <section v-for="section in bodySections" :key="section.id" class="min-w-0">
        <div class="mb-1 flex items-center justify-between gap-2">
          <span class="theme-secondary-text font-medium">{{ section.title }}</span>
          <button type="button" class="theme-muted-text border-0 bg-transparent text-[10px]" @click="copy(section)">{{ copied === section.id ? '已复制' : section.hasMore ? '复制已加载内容' : '复制' }}</button>
        </div>
        <ToolDetailContent v-if="section.text" :section="section" :active="canLoad" :class="{ 'theme-danger-text': section.id === 'error' }" @rendered="emit('rendered')" />
        <div v-else class="theme-muted-text">{{ active && section.id === 'output' ? '等待输出' : '（空）' }}</div>
        <button v-if="section.hasMore" type="button" class="tool-button mt-2 px-2 py-1 text-[11px]" :disabled="loading" @click="pauseTimelineFollow(); load(section)">加载更多</button>
      </section>
      <div v-if="data?.resultState === 'missing' && !hasModification" class="theme-muted-text">{{ active ? '等待输出' : '记录未提供执行结果' }}</div>
      <div v-else-if="data?.resultState === 'empty' && item.status === 'completed' && !hasModification" class="theme-muted-text">执行完成，无输出</div>
      <div v-if="exitCode || elapsed" class="tool-result-meta theme-muted-text flex flex-wrap items-center gap-x-3 gap-y-1 border-t pt-2 text-[11px]">
        <span v-if="exitCode" :class="Number(exitCode.text) === 0 ? 'theme-success-text' : 'theme-danger-text'">{{ Number(exitCode.text) === 0 ? '✓' : '!' }} 退出码 {{ exitCode.text }}</span>
        <span v-if="elapsed">耗时 {{ elapsed }}</span>
      </div>
      <div v-if="loading" class="theme-muted-text flex items-center gap-1"><LoaderCircle class="h-3 w-3 animate-spin" />加载中</div>
      <div v-if="error" class="theme-danger-text">{{ error }} <button type="button" class="underline" @click="load()">重新加载</button></div>
    </div>
  </div>
</template>

<style scoped>
.tool-toggle { border: 0; background: transparent; padding: 0; color: var(--theme-textPrimary); }
.tool-toggle:hover { color: var(--theme-accentText); }
.tool-summary { overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.tool-details { border-color: var(--theme-borderDefault); background: var(--theme-appPanelMuted); }
.tool-result-meta { border-color: var(--theme-borderMuted); }
.workspace-path-link { color: var(--theme-accentText); }
.workspace-path-link:hover { text-decoration: underline; }
</style>
