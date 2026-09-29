<script setup>
import { computed, inject } from 'vue'
import { Bot, Check, ChevronRight, CircleAlert, LoaderCircle, TerminalSquare } from 'lucide-vue-next'
import { isBackgroundTaskRunning } from '../lib/backgroundTaskPresentation.js'
import TimelineMarkdown from './TimelineMarkdown.vue'

const props = defineProps({ item: { type: Object, required: true }, isDark: Boolean, workspaceCwd: String, taskId: String })
const emit = defineEmits(['rendered', 'open-workspace-path'])
const pauseTimelineFollow = inject('pauseTimelineFollow', () => {})
const command = computed(() => ['local_bash', 'bash', 'command', 'shell'].includes(props.item.kind))
const labels = { running: '执行中', pending: '等待中', completed: '已完成', failed: '失败', canceled: '已停止', interrupted: '已中断' }
</script>

<template>
  <details class="background-task min-w-0 border-t pt-2" :data-task-id="item.id" @toggle="emit('rendered')">
    <summary class="flex min-w-0 cursor-pointer items-start gap-2" @click="pauseTimelineFollow()">
      <LoaderCircle v-if="isBackgroundTaskRunning(item)" class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin" />
      <Check v-else-if="item.status === 'completed'" class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
      <CircleAlert v-else class="theme-muted-text mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{{ item.title || (command ? '后台命令' : '子 Agent') }}</span>
      <span class="theme-muted-text shrink-0">{{ labels[item.status] || '待核实' }}</span>
      <ChevronRight class="detail-chevron theme-muted-text mt-0.5 h-3 w-3 shrink-0" />
    </summary>
    <div class="mt-2 min-w-0 pl-3 sm:pl-5">
      <div class="theme-muted-text mb-2 flex items-center gap-1"><TerminalSquare v-if="command" class="h-3 w-3" /><Bot v-else class="h-3 w-3" />{{ isBackgroundTaskRunning(item) ? '当前进展' : '执行结果' }}</div>
      <TimelineMarkdown v-if="item.summary" :text="item.summary" :is-dark="isDark" :workspace-cwd="workspaceCwd" :task-id="taskId" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
      <p v-else class="theme-muted-text">{{ isBackgroundTaskRunning(item) ? '正在执行，等待结果…' : '未提供结果摘要' }}</p>
      <div v-if="item.children.length" class="mt-3 space-y-2">
        <p class="theme-muted-text">内部任务 · {{ item.children.length }}</p>
        <TimelineBackgroundTask v-for="child in item.children" :key="child.id" :item="child" :is-dark="isDark" :workspace-cwd="workspaceCwd" :task-id="taskId" @rendered="emit('rendered')" @open-workspace-path="emit('open-workspace-path', $event)" />
      </div>
    </div>
  </details>
</template>

<style scoped>
summary::-webkit-details-marker { display: none; }
details[open] > summary .detail-chevron { transform: rotate(90deg); }
</style>
