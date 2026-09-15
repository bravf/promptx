<script setup>
import { computed, ref, watch } from 'vue'
import { Copy, FolderOpen, Info, RefreshCw, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'
import PxButton from './PxButton.vue'
import PxIconButton from './PxIconButton.vue'

const props = defineProps({ taskId: { type: String, required: true } })
const emit = defineEmits(['close', 'changed'])
const loading = ref(true)
const error = ref('')
const data = ref(null)
const git = ref(null)
const gitError = ref('')
const copied = ref('')
const providerLabel = computed(() => ({ codex: 'Codex', claude: 'Claude Code', kimi: 'Kimi' })[task.value?.providerId] || task.value?.providerId)
function formatTime(value) {
  const date = new Date(value)
  return value && !Number.isNaN(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '暂无记录'
}
async function copyValue(value) {
  try { await navigator.clipboard.writeText(value); copied.value = value }
  catch { error.value = '复制失败，请手动选择并复制' }
}
const rebinding = ref(false)
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
  gitError.value = ''
  copied.value = ''
  try {
    const taskDetails = await v2Api.getTask(taskId)
    if (requestVersion !== loadVersion || props.taskId !== taskId) return
    data.value = taskDetails
    try {
      const gitStatus = await v2Api.getTaskGitStatus(taskId)
      if (requestVersion === loadVersion && props.taskId === taskId) git.value = gitStatus.git
    } catch (cause) {
      if (requestVersion !== loadVersion || props.taskId !== taskId) return
      gitError.value = cause.message || '读取 Git 状态失败'
      git.value = null
    }
  } catch (err) {
    if (requestVersion === loadVersion && props.taskId === taskId) error.value = err.message || '读取任务详情失败'
  } finally {
    if (requestVersion === loadVersion && props.taskId === taskId) loading.value = false
  }
}
async function reconcile() {
  error.value = ''
  try {
    const result = await v2Api.reconcileTaskEnvironment(props.taskId)
    if (result?.environment) data.value = { ...data.value, environment: result.environment }
    emit('changed')
  } catch (cause) {
    error.value = cause.message || '重新检查目录失败'
  }
}
async function rebind() {
  rebinding.value = true
  error.value = ''
  try {
    const selection = await v2Api.pickDirectory(environment.value?.cwd || '')
    if (selection.canceled || !selection.path) return
    await v2Api.rebindTaskEnvironment(props.taskId, { cwd: selection.path })
    await load()
    emit('changed')
  } catch (cause) {
    error.value = cause.message || '重新绑定目录失败'
  } finally {
    rebinding.value = false
  }
}
watch(() => props.taskId, load, { immediate: true })
</script>

<template>
  <aside class="task-details-drawer relative flex min-h-0 min-w-0 flex-col">
    <header class="flex h-12 shrink-0 items-center border-b px-3">
      <div class="flex min-w-0 flex-1 items-center gap-2">
        <Info class="h-4 w-4 shrink-0" />
        <h2 class="truncate text-xs font-medium" :title="task?.title || '任务详情'">{{ task?.title || '任务详情' }}</h2>
        <span v-if="task" class="details-status shrink-0 px-1.5 py-0.5 text-[9px]">{{ task.lifecycle === 'archived' ? '已归档' : '未归档' }}</span>
      </div>
      <PxIconButton class="h-8 w-8" label="刷新详情" :disabled="loading" @click="load"><RefreshCw class="h-4 w-4" /></PxIconButton>
      <PxIconButton class="h-8 w-8" label="关闭抽屉" @click="emit('close')"><X class="h-4 w-4" /></PxIconButton>
    </header>
    <div v-if="error" class="details-error shrink-0 border-b px-3 py-2 text-xs">{{ error }}</div>
    <div v-if="loading" class="details-loading min-h-0 flex-1 p-3" role="status" aria-label="正在加载任务详情">
      <div v-for="index in 7" :key="index" class="details-skeleton-line" :class="index % 3 === 0 ? 'is-short' : ''" />
    </div>
    <div v-else-if="data" class="details-body min-h-0 flex-1 overflow-auto text-xs">
      <section class="details-section border-b p-3">
        <h3 class="details-label mb-3">会话信息</h3>
        <dl class="details-grid">
          <dt>Agent</dt><dd>{{ providerLabel }}</dd>
          <dt>工作区</dt><dd>{{ data.project?.displayName || '—' }}</dd>
          <dt>创建时间</dt><dd>{{ formatTime(task.createdAt) }}</dd>
          <dt>最近活跃</dt><dd>{{ formatTime(task.lastActiveAt) }}</dd>
        </dl>
      </section>
      <section class="details-section border-b p-3">
        <h3 class="details-label mb-3">工作目录与 Git</h3>
        <dl class="details-grid">
          <dt>执行方式</dt><dd>{{ environment.kind === 'worktree' ? '独立工作树（Worktree）' : '本地目录' }}</dd>
          <dt>目录状态</dt><dd>{{ ({ ready: '可用', clean: '可用', dirty: '有未提交改动', missing: '目录不存在', removed: '已移除', unavailable: '不可用' })[environment.status] || '未知' }}</dd>
          <dt>目录</dt><dd class="flex items-start gap-1"><span class="min-w-0 flex-1 break-all font-mono">{{ environment.cwd }}</span><PxIconButton class="h-6 w-6 shrink-0" :label="copied === environment.cwd ? '已复制目录' : '复制目录'" @click="copyValue(environment.cwd)"><Copy class="h-3 w-3" /></PxIconButton></dd>
          <template v-if="git?.available">
            <dt>当前分支</dt><dd class="flex items-start gap-1"><span class="min-w-0 flex-1 break-all font-mono">{{ git.branch === 'HEAD' ? '游离 HEAD' : git.branch }}</span><PxIconButton class="h-6 w-6 shrink-0" :label="copied === git.branch ? '已复制分支名' : '复制分支名'" @click="copyValue(git.branch)"><Copy class="h-3 w-3" /></PxIconButton></dd>
            <dt>工作区改动</dt><dd>{{ git.files.length ? `${git.files.length} 个未提交文件` : '无未提交改动' }}</dd>
            <dt>跟踪的远端分支</dt><dd class="break-all font-mono">{{ git.upstream || (git.upstream === undefined ? '暂无法获取，请更新本地服务' : '未关联远端分支') }}{{ git.upstreamGone ? '（已删除）' : '' }}</dd>
            <template v-if="git.upstream && !git.upstreamGone"><dt>同步状态</dt><dd>领先 {{ git.ahead }} · 落后 {{ git.behind }}<span class="theme-muted-text block text-[10px]">基于本地远端跟踪记录</span></dd></template>
          </template>
          <template v-else><dt>Git 状态</dt><dd :class="gitError ? 'theme-status-danger' : 'theme-muted-text'">{{ gitError || 'Git 不可用或当前目录不是 Git 仓库' }}</dd></template>
          <template v-if="environment.kind === 'worktree'">
            <dt>主仓库目录</dt><dd class="break-all font-mono">{{ environment.repositoryRoot }}</dd>
            <dt>基线分支</dt><dd class="break-all font-mono">{{ environment.baseRef || '—' }}</dd>
            <dt>基线提交</dt><dd class="break-all font-mono">{{ environment.baseCommit || '—' }}</dd>
          </template>
        </dl>
        <div v-if="['missing', 'unavailable'].includes(environment.status)" class="mt-3 flex flex-wrap gap-2">
          <PxButton variant="secondary" size="sm" @click="reconcile"><RefreshCw class="h-3.5 w-3.5" />重新检查</PxButton>
          <PxButton variant="secondary" size="sm" :loading="rebinding" @click="rebind"><FolderOpen class="h-3.5 w-3.5" />重新绑定目录</PxButton>
        </div>
      </section>
      <details class="p-3">
        <summary class="theme-muted-text cursor-pointer">高级信息</summary>
        <dl class="details-grid mt-3"><dt>会话 ID</dt><dd class="break-all font-mono">{{ task.id }}</dd><dt>环境 ID</dt><dd class="break-all font-mono">{{ environment.id }}</dd></dl>
      </details>
    </div>
  </aside>
</template>

<style scoped>
.task-details-drawer { background: var(--theme-appPanel); border-color: var(--theme-borderDefault); box-shadow: var(--theme-shadowPanel); }
.task-details-drawer header, .details-section { border-color: var(--theme-borderDefault); }
.details-grid { display: grid; grid-template-columns: 5.5rem minmax(0, 1fr); gap: 0.75rem 1rem; align-items: baseline; line-height: 1.6; }
.details-grid dt { color: var(--theme-textMuted); }
.details-grid dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.details-label { color: var(--theme-textMuted); font-size: 10px; font-weight: 500; }
.details-status { border-radius: 999px; background: var(--theme-appPanelStrong); color: var(--theme-textMuted); }
.details-error { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.details-skeleton-line { height: 1.75rem; margin-bottom: 0.5rem; border-radius: 2px; background: var(--theme-appPanelInset); opacity: 0.7; animation: details-skeleton-pulse 1.2s ease-in-out infinite; }
.details-skeleton-line.is-short { width: 68%; }
@keyframes details-skeleton-pulse { 0%, 100% { opacity: 0.42; } 50% { opacity: 0.82; } }
@media (prefers-reduced-motion: reduce) { .details-skeleton-line { animation: none; opacity: 0.62; } }
</style>
