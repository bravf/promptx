<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { Bot, Check, ChevronRight, Circle, CircleDot, FileDiff, FileText, LoaderCircle, Wrench } from 'lucide-vue-next'
import { formatElapsedTime, getTurnActivityState, userMessageCopyText } from '../lib/timelinePresentation.js'
import { workspaceLinksForTool } from '../lib/timelineWorkspaceLinks.js'
import TimelineMarkdown from './TimelineMarkdown.vue'
import TimelineMessageMeta from './TimelineMessageMeta.vue'
import TimelineUserMessage from './TimelineUserMessage.vue'

const props = defineProps({
  turn: { type: Object, required: true },
  timing: { type: Object, default: null },
  running: { type: Boolean, default: false },
  isDark: { type: Boolean, default: false },
  workspaceCwd: { type: String, default: '' },
})
const emit = defineEmits(['rendered', 'open-workspace-path'])

const expanded = ref(props.running)
const clock = ref(Date.now())
let clockTimer = null

const visibleProcessEntries = computed(() => props.turn.processEntries.filter((entry) => (
  props.running || entry.item?.type !== 'system_notice' || entry.item.code !== 'provider_retrying'
)))
const hasProcessEntries = computed(() => visibleProcessEntries.value.length > 0)
const showProcess = computed(() => props.running || hasProcessEntries.value)
const duration = computed(() => {
  const start = props.timing?.startedAt
  if (!Number.isFinite(start)) return null
  const end = props.running
    ? clock.value
    : (Number.isFinite(props.timing?.finishedAt) ? props.timing.finishedAt : start)
  return Math.max(0, end - start)
})
const activity = computed(() => getTurnActivityState(props.turn, { running: props.running, now: clock.value }))
const heading = computed(() => {
  const elapsed = formatElapsedTime(duration.value || 0)
  if (!props.running) return `耗时 ${elapsed}`
  if (activity.value.status === 'retrying') return `模型服务连接异常，正在重试 · ${elapsed}`
  if (activity.value.status === 'delayed') return `响应时间较长 · ${elapsed}`
  return `思考中 · ${elapsed}`
})

function syncClock() {
  clearInterval(clockTimer)
  clockTimer = null
  if (props.running) {
    clock.value = Date.now()
    clockTimer = setInterval(() => { clock.value = Date.now() }, 1000)
  }
}

function toolLinks(entry) {
  return workspaceLinksForTool(entry.item, props.workspaceCwd)
}

watch(() => props.running, (running, wasRunning) => {
  if (running && !wasRunning) expanded.value = true
  else if (!running && wasRunning) expanded.value = false
  syncClock()
}, { immediate: true })

onBeforeUnmount(() => clearInterval(clockTimer))
</script>

<template>
  <section class="timeline-turn min-w-0">
    <article v-for="entry in turn.userEntries" :key="entry.seqStart" class="timeline-message mb-5 flex min-w-0 max-w-full flex-col items-end" :data-timeline-seq="entry.seqEnd">
      <TimelineUserMessage :content="entry.item.content" />
      <TimelineMessageMeta :text="userMessageCopyText(entry.item.content)" :timestamp="entry.timestamp" align="right" />
    </article>

    <section v-if="showProcess" class="process-group mb-5 ml-7">
      <button v-if="hasProcessEntries" type="button" class="process-toggle theme-muted-text inline-flex items-center gap-1.5 py-1 text-left text-xs" :aria-expanded="expanded" @click="expanded = !expanded">
        <span>{{ heading }}</span>
        <ChevronRight class="h-3.5 w-3.5 shrink-0 transition-transform" :class="expanded ? 'rotate-90' : ''" />
      </button>
      <div v-else class="theme-muted-text py-1 text-xs">{{ heading }}</div>
      <div v-if="expanded && hasProcessEntries" class="process-content pb-1 pl-5 pt-1">
        <div v-for="entry in visibleProcessEntries" :key="`${entry.seqStart}-${entry.item.callId || entry.item.type}`" class="process-entry py-1.5 text-xs">
          <TimelineMarkdown v-if="entry.item.type === 'assistant_message'" class="theme-secondary-text" :text="entry.item.text" :is-dark="isDark" :streaming="running" :workspace-cwd="workspaceCwd" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
          <div v-else-if="entry.item.type === 'reasoning'" class="theme-secondary-text whitespace-pre-wrap leading-5">{{ entry.item.text }}</div>
          <div v-else-if="entry.item.type === 'tool_call'" class="flex min-w-0 items-start gap-2">
            <Wrench class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2"><span class="truncate font-medium">{{ entry.item.name }}</span><Check v-if="entry.item.status === 'completed'" class="h-3.5 w-3.5 shrink-0" /><LoaderCircle v-else-if="entry.item.status === 'running'" class="h-3.5 w-3.5 shrink-0 animate-spin" /></div>
              <div v-if="entry.item.detail?.command || entry.item.detail?.type" class="theme-muted-text mt-0.5 truncate font-mono text-[10px]">{{ entry.item.detail?.command || entry.item.detail?.type }}</div>
              <div v-if="toolLinks(entry).length" class="mt-1 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                <button v-for="link in toolLinks(entry)" :key="`${link.intent}:${link.path}`" type="button" class="workspace-path-link inline-flex h-auto min-h-0 min-w-0 items-center justify-start gap-1 border-0 p-0 text-left font-mono text-[10px]" :title="link.path" @click="emit('open-workspace-path', link)">
                  <FileDiff v-if="link.intent === 'diff'" class="h-3 w-3 shrink-0" />
                  <FileText v-else class="h-3 w-3 shrink-0" />
                  <span class="truncate">{{ link.path }}<template v-if="link.line">:{{ link.line }}</template></span>
                </button>
              </div>
              <div v-if="entry.item.error?.message" class="theme-danger-text mt-1">{{ entry.item.error.message }}</div>
            </div>
          </div>
          <div v-else-if="entry.item.type === 'todo'" class="space-y-1">
            <div v-for="(item, index) in entry.item.items" :key="`${index}-${item.text}`" class="theme-secondary-text flex items-start gap-2">
              <Check v-if="item.status === 'completed'" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <CircleDot v-else-if="item.status === 'in_progress'" class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <Circle v-else class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{{ item.text }}</span>
            </div>
          </div>
          <div v-else-if="entry.item.type === 'system_notice'" class="flex items-center gap-2 text-[var(--theme-warningText)]">
            <LoaderCircle class="h-3.5 w-3.5 shrink-0 animate-spin" />
            <span>{{ entry.item.text }}</span>
          </div>
        </div>
      </div>
    </section>

    <article v-for="entry in turn.outputEntries" :key="entry.seqStart" class="mb-5" :class="entry.item.type === 'assistant_message' ? 'timeline-message' : ''" :data-timeline-seq="entry.seqEnd">
      <div v-if="entry.item.type === 'assistant_message'" class="flex gap-3">
        <Bot class="mt-1 h-4 w-4 shrink-0" />
        <div class="min-w-0 flex-1">
          <TimelineMarkdown :text="entry.item.text" :is-dark="isDark" :streaming="running" :workspace-cwd="workspaceCwd" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
          <TimelineMessageMeta :text="entry.item.text" :timestamp="entry.timestamp" />
        </div>
      </div>
      <div v-else-if="entry.item.type === 'error'" class="error-row ml-7 rounded-sm border px-3 py-2 text-xs">{{ entry.item.message }}</div>
      <div v-else-if="entry.item.type === 'system_notice'" class="theme-muted-text ml-7 text-xs">{{ entry.item.text }}</div>
    </article>

  </section>
</template>

<style scoped>
.process-toggle { border: 0; background: transparent; }
.process-toggle:hover { color: var(--theme-textPrimary); }
.error-row { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.workspace-path-link { color: var(--theme-accentText); }
.workspace-path-link:hover { text-decoration: underline; }
</style>
