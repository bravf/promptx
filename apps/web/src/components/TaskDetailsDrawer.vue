<script setup>
import { computed, onMounted, ref } from 'vue'
import { Archive, Copy, ExternalLink, Info, Trash2 } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'

const props = defineProps({ taskId: { type: String, required: true } })
const emit = defineEmits(['close', 'changed'])
const loading = ref(true)
const error = ref('')
const data = ref(null)
const git = ref(null)
const commitMessage = ref('')
const task = computed(() => data.value?.task)
const environment = computed(() => data.value?.environment)

async function load() {
  loading.value = true
  error.value = ''
  try { data.value = await v2Api.getTask(props.taskId); git.value = (await v2Api.getTaskGitStatus(props.taskId)).git } catch (err) { error.value = err.message || '读取任务详情失败' } finally { loading.value = false }
}
async function archive() { await v2Api.archiveTask(props.taskId); emit('changed'); await load() }
async function reconcile() { data.value = { ...data.value, ...(await v2Api.reconcileTaskEnvironment(props.taskId)) }; emit('changed') }
async function copyTask() { await v2Api.copyTask(props.taskId, {}); emit('changed') }
async function commit() { if (!commitMessage.value.trim()) return; await v2Api.commitTask(props.taskId, commitMessage.value); commitMessage.value = ''; await load() }
async function push() { await v2Api.pushTask(props.taskId); await load() }
async function merge() { await v2Api.mergeTask(props.taskId, {}); emit('changed'); await load() }
async function remove() { if (!window.confirm('删除此任务？Worktree 默认保留。')) return; await v2Api.deleteTask(props.taskId); emit('changed'); emit('close') }
onMounted(load)
</script>

<template>
  <aside class="drawer-panel flex h-full w-full max-w-md flex-col border-l">
    <header class="flex items-center justify-between border-b px-4 py-3">
      <div class="flex items-center gap-2 font-medium"><Info class="h-4 w-4" />任务详情</div>
      <button class="quiet-icon-button h-8 w-8" title="关闭" @click="emit('close')">×</button>
    </header>
    <div v-if="loading" class="p-4 text-sm theme-muted-text">正在加载…</div>
    <div v-else-if="error" class="p-4 text-sm text-red-500">{{ error }}</div>
    <div v-else class="space-y-5 overflow-auto p-4 text-xs">
      <section><h3 class="theme-heading mb-2 text-sm">{{ task.title }}</h3><p class="theme-muted-text">{{ task.providerId }} · {{ task.lifecycle }}</p></section>
      <section class="space-y-2"><div class="theme-muted-text">执行环境</div><div>{{ environment.kind }} · {{ environment.status }}</div><div class="theme-muted-text break-all font-mono">{{ environment.cwd }}</div><button v-if="['missing', 'orphaned', 'unavailable'].includes(environment.status)" class="tool-button" @click="reconcile"><ExternalLink class="h-3.5 w-3.5" />重新检查目录</button></section>
      <section v-if="environment.kind === 'worktree'" class="space-y-2"><div class="theme-muted-text">分支</div><div class="font-mono">{{ environment.branchName }}</div><div class="theme-muted-text">基线 {{ environment.baseRef }}</div></section>
      <section v-if="git" class="space-y-1"><div class="theme-muted-text">Git 状态</div><div>{{ git.files?.length || 0 }} 个未提交文件</div><div>领先基线 {{ git.ahead || 0 }} 个提交 · 落后 {{ git.behind || 0 }} 个提交</div></section>
      <section v-if="environment.kind === 'worktree'" class="space-y-2"><input v-model="commitMessage" class="tool-input" placeholder="提交信息" /><div class="flex gap-2"><button class="tool-button" :disabled="!commitMessage.trim()" @click="commit">提交</button><button class="tool-button" @click="push">推送</button></div></section>
      <button v-if="environment.kind === 'worktree'" class="tool-button" @click="merge">合并到项目默认分支</button>
      <div class="flex flex-wrap gap-2"><button class="tool-button" @click="copyTask"><Copy class="h-3.5 w-3.5" />复制到新 Worktree</button><button class="tool-button" @click="archive"><Archive class="h-3.5 w-3.5" />归档任务</button><button class="tool-button" @click="remove"><Trash2 class="h-3.5 w-3.5" />删除任务</button></div>
    </div>
  </aside>
</template>
