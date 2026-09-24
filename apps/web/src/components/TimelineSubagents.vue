<script setup>
import { computed, ref, watch } from 'vue'
import { Bot, Check, ChevronRight, CircleAlert, LoaderCircle, TerminalSquare } from 'lucide-vue-next'
import { isBackgroundTaskRunning } from '../lib/backgroundTaskPresentation.js'
import TimelineMarkdown from './TimelineMarkdown.vue'
import PxButton from './PxButton.vue'

const props = defineProps({
  tasks: { type: Array, default: () => [] },
  isDark: Boolean,
  workspaceCwd: { type: String, default: '' },
  taskId: { type: String, default: '' },
  stopping: Boolean,
})
const emit = defineEmits(['stop-all', 'rendered', 'open-workspace-path'])
const running = computed(() => props.tasks.filter(isBackgroundTaskRunning).length)
const completed = computed(() => props.tasks.filter(task => task.status === 'completed').length)
const errors = computed(() => props.tasks.filter(task => ['failed', 'interrupted'].includes(task.status)).length)
const expanded = ref(running.value > 0)
const labels = { running: '执行中', pending: '等待中', completed: '已完成', failed: '失败', canceled: '已停止', interrupted: '已中断' }
function isCommand(task) { return ['local_bash', 'bash', 'command', 'shell'].includes(task.kind) }
const title = computed(() => props.tasks.every(isCommand) ? '后台命令' : props.tasks.some(isCommand) ? '子 Agent 与后台命令' : '子 Agent')
watch(running, (count, previous) => { if (count > 0 && !previous) expanded.value = true })
</script>

<template>
  <section v-if="tasks.length" class="timeline-subagents mb-5 ml-7 min-w-0 rounded-sm border border-dashed px-3 py-2 text-xs" aria-label="子任务与结果">
    <button type="button" class="flex w-full min-w-0 items-center gap-2 text-left" :aria-expanded="expanded" @click="expanded = !expanded; emit('rendered')">
      <ChevronRight class="theme-muted-text h-3.5 w-3.5 shrink-0" :class="{ 'rotate-90': expanded }" />
      <span class="font-medium">{{ title }}</span>
      <span class="theme-muted-text">{{ completed }}/{{ tasks.length }} 已完成</span>
      <span v-if="running" class="theme-muted-text ml-auto">{{ running }} 个执行中</span>
      <span v-else-if="errors" class="theme-danger-text ml-auto">{{ errors }} 个异常</span>
    </button>
    <div v-if="expanded" class="mt-2 space-y-2">
      <details v-for="item in tasks" :key="item.id" class="min-w-0 border-t pt-2" @toggle="emit('rendered')">
        <summary class="flex min-w-0 cursor-pointer items-start gap-2">
          <LoaderCircle v-if="isBackgroundTaskRunning(item)" class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
          <Check v-else-if="item.status === 'completed'" class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
          <CircleAlert v-else class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{ item.title || (isCommand(item) ? '后台命令' : '子 Agent') }}</span>
          <span class="theme-muted-text shrink-0">{{ labels[item.status] || '待核实' }}</span>
          <ChevronRight class="detail-chevron theme-muted-text mt-0.5 h-3 w-3 shrink-0" />
        </summary>
        <div class="mt-2 min-w-0 pl-5">
          <div class="theme-muted-text mb-2 flex items-center gap-1"><TerminalSquare v-if="isCommand(item)" class="h-3 w-3" /><Bot v-else class="h-3 w-3" />{{ isBackgroundTaskRunning(item) ? '当前进展' : '执行结果' }}</div>
          <TimelineMarkdown v-if="item.summary" :text="item.summary" :is-dark="isDark" :workspace-cwd="workspaceCwd" :task-id="taskId" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
          <p v-else class="theme-muted-text">{{ isBackgroundTaskRunning(item) ? '正在执行，等待结果…' : '未提供结果摘要' }}</p>
        </div>
      </details>
      <PxButton v-if="running" variant="ghost" size="sm" :disabled="stopping" @click="emit('stop-all')">{{ stopping ? '正在停止…' : '停止会话全部任务' }}</PxButton>
    </div>
  </section>
</template>

<style scoped>
button { background: transparent; }
summary::-webkit-details-marker { display: none; }
details[open] > summary .detail-chevron { transform: rotate(90deg); }
</style>
