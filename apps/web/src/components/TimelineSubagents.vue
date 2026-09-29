<script setup>
import { computed, inject, ref, watch } from 'vue'
import { ChevronRight } from 'lucide-vue-next'
import { buildBackgroundTaskTree, isBackgroundTaskRunning } from '../lib/backgroundTaskPresentation.js'
import TimelineBackgroundTask from './TimelineBackgroundTask.vue'
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
const taskTree = computed(() => buildBackgroundTaskTree(props.tasks))
const pauseTimelineFollow = inject('pauseTimelineFollow', () => {})
function isCommand(task) { return ['local_bash', 'bash', 'command', 'shell'].includes(task.kind) }
const title = computed(() => props.tasks.every(isCommand) ? '后台命令' : props.tasks.some(isCommand) ? '子 Agent 与后台命令' : '子 Agent')
watch(running, (count, previous) => { if (count > 0 && !previous) expanded.value = true })
</script>

<template>
  <section v-if="tasks.length" class="timeline-subagents mb-5 ml-7 min-w-0 rounded-sm border border-dashed px-3 py-2 text-xs" aria-label="子任务与结果">
    <button type="button" class="flex w-full min-w-0 items-center gap-2 text-left" :aria-expanded="expanded" @click="pauseTimelineFollow(); expanded = !expanded; emit('rendered')">
      <ChevronRight class="theme-muted-text h-3.5 w-3.5 shrink-0" :class="{ 'rotate-90': expanded }" />
      <span class="font-medium">{{ title }}</span>
      <span class="theme-muted-text">{{ completed }}/{{ tasks.length }} 已完成</span>
      <span v-if="taskTree.length < tasks.length" class="theme-muted-text">含子 Agent 内部任务</span>
      <span v-if="running" class="theme-muted-text ml-auto">{{ running }} 个执行中</span>
      <span v-else-if="errors" class="theme-danger-text ml-auto">{{ errors }} 个异常</span>
    </button>
    <div v-if="expanded" class="mt-2 space-y-2">
      <TimelineBackgroundTask v-for="item in taskTree" :key="item.id" :item="item" :is-dark="isDark" :workspace-cwd="workspaceCwd" :task-id="taskId" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
      <PxButton v-if="running" variant="ghost" size="sm" :disabled="stopping" @click="emit('stop-all')">{{ stopping ? '正在停止…' : '停止会话全部任务' }}</PxButton>
    </div>
  </section>
</template>

<style scoped>
button { background: transparent; }
summary::-webkit-details-marker { display: none; }
details[open] > summary .detail-chevron { transform: rotate(90deg); }
</style>
