<script setup>
import { computed, ref, watch } from 'vue'
import { GitBranch, Info, RefreshCw, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'

const props = defineProps({ taskId: { type: String, required: true } })
const emit = defineEmits(['close', 'changed'])
const loading = ref(true)
const error = ref('')
const data = ref(null)
const git = ref(null)
const task = computed(() => data.value?.task)
const environment = computed(() => data.value?.environment)
let loadVersion = 0

async function load() {
  const taskId = props.taskId
  const requestVersion = ++loadVersion
  loading.value = true
  error.value = ''
  data.value = null
  git.value = null
  try {
    const [taskDetails, gitStatus] = await Promise.all([
      v2Api.getTask(taskId),
      v2Api.getTaskGitStatus(taskId),
    ])
    if (requestVersion !== loadVersion || props.taskId !== taskId) return
    data.value = taskDetails
    git.value = gitStatus.git
  } catch (err) {
    if (requestVersion === loadVersion && props.taskId === taskId) error.value = err.message || '读取任务详情失败'
  } finally {
    if (requestVersion === loadVersion && props.taskId === taskId) loading.value = false
  }
}
async function reconcile() { data.value = { ...data.value, ...(await v2Api.reconcileTaskEnvironment(props.taskId)) }; emit('changed') }
watch(() => props.taskId, load, { immediate: true })
</script>

<template>
  <aside class="task-details-drawer relative flex min-h-0 min-w-0 flex-col">
    <header class="flex h-12 shrink-0 items-center border-b px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Info class="h-4 w-4 shrink-0" />
        <span class="truncate font-mono text-xs font-medium" :title="task?.title || '任务详情'">{{ task?.title || '任务详情' }}</span>
        <span v-if="task" class="details-status shrink-0 px-1.5 py-0.5 text-[9px]">{{ task.lifecycle }}</span>
      </div>
      <button class="quiet-icon-button h-8 w-8" title="关闭抽屉" @click="emit('close')"><X class="h-4 w-4" /></button>
    </header>
    <div v-if="error" class="details-error shrink-0 border-b px-3 py-2 text-xs">{{ error }}</div>
    <div v-if="loading" class="details-loading min-h-0 flex-1 p-3" role="status" aria-label="正在加载任务详情">
      <div v-for="index in 7" :key="index" class="details-skeleton-line" :class="index % 3 === 0 ? 'is-short' : ''" />
    </div>
    <div v-else-if="data" class="details-body min-h-0 flex-1 overflow-auto text-xs">
      <section class="details-section border-b p-3">
        <div class="details-label">会话</div>
        <h3 class="theme-heading mt-2 text-sm font-medium">{{ task.title }}</h3>
        <p class="theme-muted-text mt-1 font-mono text-[10px]">{{ task.providerId }}</p>
      </section>
      <section class="details-section border-b p-3">
        <div class="details-label">执行环境</div>
        <div class="mt-2 flex items-center gap-2"><span>{{ environment.kind }}</span><span class="theme-muted-text">{{ environment.status }}</span></div>
        <div class="theme-muted-text mt-2 break-all font-mono text-[10px] leading-5">{{ environment.cwd }}</div>
        <button v-if="['missing', 'orphaned', 'unavailable'].includes(environment.status)" type="button" class="tool-button mt-3 gap-1.5 px-2.5 py-1.5 text-xs" @click="reconcile"><RefreshCw class="h-3.5 w-3.5" />重新检查目录</button>
      </section>
      <section v-if="environment.kind === 'worktree'" class="details-section border-b p-3">
        <div class="details-label flex items-center gap-1.5"><GitBranch class="h-3.5 w-3.5" />分支</div>
        <div class="mt-2 break-all font-mono text-[11px]">{{ environment.branchName }}</div>
        <div class="theme-muted-text mt-1 text-[10px]">基线 {{ environment.baseRef }}</div>
      </section>
      <section v-if="git" class="details-section border-b p-3">
        <div class="details-label">Git 状态</div>
        <div class="mt-2">{{ git.files?.length || 0 }} 个未提交文件</div>
        <div class="theme-muted-text mt-1 text-[10px]">领先 {{ git.ahead || 0 }} · 落后 {{ git.behind || 0 }}</div>
      </section>
    </div>
  </aside>
</template>

<style scoped>
.task-details-drawer { background: var(--theme-appPanel); border-color: var(--theme-borderDefault); box-shadow: var(--theme-shadowPanel); }
.task-details-drawer header, .details-section { border-color: var(--theme-borderDefault); }
.details-label { color: var(--theme-textMuted); font-size: 10px; font-weight: 500; }
.details-status { border-radius: 999px; background: var(--theme-appPanelStrong); color: var(--theme-textMuted); }
.details-error { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.details-skeleton-line { height: 1.75rem; margin-bottom: 0.5rem; border-radius: 2px; background: var(--theme-appPanelInset); opacity: 0.7; animation: details-skeleton-pulse 1.2s ease-in-out infinite; }
.details-skeleton-line.is-short { width: 68%; }
@keyframes details-skeleton-pulse { 0%, 100% { opacity: 0.42; } 50% { opacity: 0.82; } }
@media (prefers-reduced-motion: reduce) { .details-skeleton-line { animation: none; opacity: 0.62; } }
</style>
