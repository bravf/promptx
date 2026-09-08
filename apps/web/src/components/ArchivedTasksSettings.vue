<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { ArchiveRestore, CopyPlus, FolderOpen, LoaderCircle, Search, Trash2, Unplug } from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'
import PxAlert from './PxAlert.vue'
import PxButton from './PxButton.vue'
import { v2Api } from '../lib/v2Api.js'

const emit = defineEmits(['changed'])
const projects = ref([])
const tasks = ref([])
const query = ref('')
const loading = ref(false)
const pendingKey = ref('')
const error = ref('')
const confirmation = ref(null)
let searchTimer = null

const hasEntries = computed(() => projects.value.length > 0 || tasks.value.length > 0)

function environmentLabel(environment) {
  if (environment?.kind !== 'worktree') return '当前目录'
  return environment.branchName ? `Worktree · ${environment.branchName}` : 'Worktree'
}

function formatDate(value) {
  if (!value) return '未知时间'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [projectResult, taskResult] = await Promise.all([
      v2Api.listArchivedProjects(query.value),
      v2Api.listArchivedTasks(query.value),
    ])
    projects.value = projectResult.projects || []
    tasks.value = taskResult.tasks || []
  } catch (cause) {
    error.value = cause.message
  } finally {
    loading.value = false
  }
}

async function run(key, action) {
  pendingKey.value = key
  error.value = ''
  try {
    await action()
    await load()
    emit('changed')
  } catch (cause) {
    error.value = cause.message
  } finally {
    pendingKey.value = ''
  }
}

const restoreProject = (project) => run(`project:${project.id}`, () => v2Api.restoreProject(project.id))
const restoreTask = (task) => run(`task:${task.id}`, () => v2Api.restoreTask(task.id))
const copyTask = (task) => run(`task:${task.id}`, () => v2Api.copyTask(task.id))

async function rebindTask(task) {
  const key = `task:${task.id}`
  pendingKey.value = key
  error.value = ''
  try {
    const selection = await v2Api.pickDirectory(task.environment?.cwd || task.project?.repositoryRoot || '')
    if (selection.canceled || !selection.path) return
    await v2Api.rebindTaskEnvironment(task.id, { cwd: selection.path })
    await v2Api.restoreTask(task.id)
    await load()
    emit('changed')
  } catch (cause) {
    error.value = cause.message
  } finally {
    pendingKey.value = ''
  }
}

function askClean(task) {
  confirmation.value = { type: 'clean', task, force: false, title: '清理 Worktree？',
    description: '将从磁盘移除 PromptX 创建的 Worktree。会话和 Timeline 会继续保留。', confirmText: '清理' }
}

function askDeleteTask(task) {
  confirmation.value = { type: 'delete-task', task, title: '永久删除会话？',
    description: '会话、Timeline、附件和执行环境记录将永久删除，此操作不可撤销。', confirmText: '永久删除' }
}

function askDeleteProject(project) {
  confirmation.value = { type: 'delete-project', project, title: '永久删除工作区？',
    description: '工作区记录将永久删除，不会删除本地目录。', confirmText: '永久删除' }
}

async function confirmAction() {
  const action = confirmation.value
  if (!action) return
  confirmation.value = null
  const item = action.task || action.project
  const key = `${action.project ? 'project' : 'task'}:${item.id}`
  pendingKey.value = key
  error.value = ''
  try {
    if (action.type === 'delete-task') await v2Api.deleteTask(action.task.id)
    else if (action.type === 'delete-project') await v2Api.deleteProject(action.project.id)
    else await v2Api.removeTaskWorktree(action.task.id, action.force)
    await load()
    emit('changed')
  } catch (cause) {
    if (action.type === 'clean' && cause.code === 'worktree_has_changes' && !action.force) {
      const risk = cause.details?.risk || {}
      const parts = []
      if (risk.files?.length) parts.push(`${risk.files.length} 项未提交修改`)
      if (risk.unpushedCommits) parts.push(`${risk.unpushedCommits} 个未推送提交`)
      confirmation.value = { ...action, force: true, title: '强制清理 Worktree？',
        description: `检测到${parts.join('和') || '尚未交付的修改'}。强制清理会丢失这些代码。`, confirmText: '强制清理' }
    } else error.value = cause.message
  } finally {
    pendingKey.value = ''
  }
}

function taskAction(task) {
  if (task.project?.lifecycle === 'archived') return 'project-archived'
  if (task.environment?.status === 'removed') return 'copy'
  if (['missing', 'unavailable'].includes(task.environment?.status)) return 'rebind'
  return 'restore'
}

onMounted(load)
watch(query, () => {
  clearTimeout(searchTimer)
  searchTimer = setTimeout(load, 200)
})
onBeforeUnmount(() => clearTimeout(searchTimer))
</script>

<template>
  <section class="mx-auto w-full max-w-3xl">
    <div class="mb-5">
      <h2 class="theme-heading text-lg font-semibold">归档</h2>
      <p class="theme-muted-text mt-1 text-xs">归档只隐藏记录，不会删除 Timeline、目录或 Worktree。</p>
    </div>

    <form class="archive-search flex h-9 items-center gap-2 rounded-sm border px-3" @submit.prevent="load">
      <Search class="theme-muted-text h-3.5 w-3.5 shrink-0" />
      <input v-model="query" class="min-w-0 flex-1 bg-transparent text-xs outline-none" placeholder="搜索工作区、会话、Provider 或分支" />
      <LoaderCircle v-if="loading" class="theme-muted-text h-3.5 w-3.5 animate-spin" />
    </form>

    <PxAlert v-if="error" class="mt-4" dismissible @dismiss="error = ''">{{ error }}</PxAlert>

    <template v-if="hasEntries">
      <section v-if="projects.length" class="mt-6">
        <h3 class="theme-muted-text text-[10px] font-medium">工作区</h3>
        <div class="archive-list mt-2 divide-y">
          <article v-for="project in projects" :key="project.id" class="archive-row flex min-w-0 flex-col gap-3 py-4 sm:flex-row sm:items-center">
            <div class="min-w-0 flex-1">
              <div class="theme-heading truncate text-sm font-medium">{{ project.displayName }}</div>
              <div class="theme-muted-text mt-1 truncate font-mono text-[10px]">{{ project.repositoryRoot }}</div>
              <div class="theme-muted-text mt-1 text-[10px]">{{ project.activeTaskCount }} 个活动会话 · {{ project.archivedTaskCount }} 个归档会话 · 归档于 {{ formatDate(project.archivedAt) }}</div>
            </div>
            <div class="flex shrink-0 gap-2">
              <PxButton size="sm" class="h-8 text-xs" :loading="pendingKey === `project:${project.id}`" :disabled="Boolean(pendingKey)" @click="restoreProject(project)"><ArchiveRestore class="h-3.5 w-3.5" />恢复</PxButton>
              <PxButton v-if="project.activeTaskCount + project.archivedTaskCount === 0" variant="danger" size="sm" class="h-8 text-xs" :disabled="Boolean(pendingKey)" @click="askDeleteProject(project)"><Trash2 class="h-3.5 w-3.5" />永久删除</PxButton>
            </div>
          </article>
        </div>
      </section>

      <section v-if="tasks.length" class="mt-6">
        <h3 class="theme-muted-text text-[10px] font-medium">会话</h3>
        <div class="archive-list mt-2 divide-y">
          <article v-for="task in tasks" :key="task.id" class="archive-row py-4">
            <div class="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center">
              <div class="min-w-0 flex-1">
                <div class="theme-heading truncate text-sm font-medium">{{ task.title }}</div>
                <div class="theme-muted-text mt-1 flex flex-wrap gap-x-2 gap-y-1 text-[11px]">
                  <span>{{ task.project?.displayName }}</span><span>{{ task.agent?.providerId || task.providerId }}</span>
                  <span>{{ environmentLabel(task.environment) }}</span><span>{{ task.environment?.status }}</span>
                </div>
                <div class="theme-muted-text mt-1 text-[10px]">归档于 {{ formatDate(task.archivedAt) }}</div>
              </div>
              <div class="flex shrink-0 flex-wrap gap-2">
                <PxButton v-if="taskAction(task) === 'restore'" size="sm" class="h-8 text-xs" :loading="pendingKey === `task:${task.id}`" :disabled="Boolean(pendingKey)" @click="restoreTask(task)"><ArchiveRestore class="h-3.5 w-3.5" />恢复</PxButton>
                <PxButton v-else-if="taskAction(task) === 'copy'" size="sm" class="h-8 text-xs" :loading="pendingKey === `task:${task.id}`" :disabled="Boolean(pendingKey)" @click="copyTask(task)"><CopyPlus class="h-3.5 w-3.5" />复制到新 Worktree</PxButton>
                <PxButton v-else-if="taskAction(task) === 'rebind'" size="sm" class="h-8 text-xs" :loading="pendingKey === `task:${task.id}`" :disabled="Boolean(pendingKey)" @click="rebindTask(task)"><FolderOpen class="h-3.5 w-3.5" />重新绑定目录</PxButton>
                <PxButton v-else size="sm" class="h-8 text-xs" disabled>先恢复工作区</PxButton>
                <PxButton v-if="task.environment?.kind === 'worktree' && task.environment?.ownership === 'promptx' && task.environment?.status !== 'removed'" size="sm" class="h-8 text-xs" :disabled="Boolean(pendingKey)" @click="askClean(task)"><Unplug class="h-3.5 w-3.5" />清理 Worktree</PxButton>
                <PxButton variant="danger" size="sm" class="h-8 text-xs" :disabled="Boolean(pendingKey)" @click="askDeleteTask(task)"><Trash2 class="h-3.5 w-3.5" />永久删除</PxButton>
              </div>
            </div>
          </article>
        </div>
      </section>
    </template>
    <div v-else-if="!loading" class="theme-empty-state mt-5 rounded-sm border border-dashed px-4 py-12 text-center text-xs">没有符合条件的归档记录</div>
  </section>

  <ConfirmDialog v-if="confirmation" :open="true" :title="confirmation.title" :description="confirmation.description"
    :confirm-text="confirmation.confirmText" :danger="true" @cancel="confirmation = null" @confirm="confirmAction" />
</template>

<style scoped>
.archive-search { border-color: var(--theme-inputBorder); background: var(--theme-inputBg); color: var(--theme-textPrimary); }
.archive-search:focus-within { border-color: var(--theme-borderStrong); }
.archive-list { border-color: var(--theme-borderMuted); }
.archive-row { border-color: var(--theme-borderMuted); }
</style>
