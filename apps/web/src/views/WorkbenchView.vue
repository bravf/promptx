<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  CircleAlert,
  Copy,
  Plus,
  SendHorizontal,
  Square,
  Trash2,
  Upload,
  WandSparkles,
} from 'lucide-vue-next'
import BlockEditor from '../components/BlockEditor.vue'
import CodexSessionPanel from '../components/CodexSessionPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import TopToast from '../components/TopToast.vue'
import { usePageTitle } from '../composables/usePageTitle.js'
import { useToast } from '../composables/useToast.js'
import { useWorkbenchTasks } from '../composables/useWorkbenchTasks.js'

const showClearDialog = ref(false)
const showDeleteDialog = ref(false)
const editingTaskTitleSlug = ref('')
const { toastMessage, flashToast, clearToast } = useToast()

const codexPanelRef = ref(null)

function getCurrentPanelRef(currentTaskSlug) {
  if (!currentTaskSlug) {
    return null
  }

  return codexPanelRef.value
}

function scrollCurrentPanelToBottom() {
  nextTick(() => {
    getCurrentPanelRef(currentTaskSlug.value)?.scrollToBottom?.()
  })
}

const {
  buildPromptForTask,
  clearCurrentTaskContent,
  createTaskAndSelect,
  creatingTask,
  currentSelectedSessionId,
  currentTaskAutoTitle,
  currentTaskDisplayTitle,
  currentTaskSlug,
  draft,
  editorRef,
  error,
  handleImportPdfFiles,
  handleImportTextFiles,
  handleTaskSendingChange,
  handleTaskSessionChange,
  handleUpload,
  hasUnsavedChanges,
  initializeWorkbench,
  isCurrentTaskSending,
  loadingTask,
  loadingTasks,
  pageTitle,
  prepareCodexPromptForTask,
  removeCurrentTask,
  removingTask,
  renderedTasks,
  saveTask,
  selectTask,
  updateLastPromptPreview,
  uploading,
} = useWorkbenchTasks({
  clearToast,
  flashToast,
  scrollCurrentPanelToBottom,
})

const currentRenderedTask = computed(() =>
  renderedTasks.value.find((task) => task.slug === currentTaskSlug.value) || null
)

usePageTitle(pageTitle)

async function handleTaskTitleBlur() {
  editingTaskTitleSlug.value = ''
  if (hasUnsavedChanges.value) {
    await saveTask({ auto: false, silent: true })
  }
}

function beginTaskTitleEdit(taskSlug) {
  if (taskSlug !== currentTaskSlug.value) {
    return
  }

  editingTaskTitleSlug.value = taskSlug
  nextTick(() => {
    const element = document.querySelector('[data-task-title-input="current"]')
    element?.focus?.()
    element?.select?.()
  })
}

function handleTaskTitleClick(taskSlug) {
  if (taskSlug !== currentTaskSlug.value) {
    selectTask(taskSlug)
    return
  }

  beginTaskTitleEdit(taskSlug)
}

function openDeleteDialog() {
  showDeleteDialog.value = true
}

function closeDeleteDialog() {
  if (removingTask.value) {
    return
  }

  showDeleteDialog.value = false
}

async function confirmRemoveCurrentTask() {
  await removeCurrentTask()
  showDeleteDialog.value = false
}

function openClearDialog() {
  showClearDialog.value = true
}

function closeClearDialog() {
  showClearDialog.value = false
}

function clearAllContent() {
  showClearDialog.value = false
  clearCurrentTaskContent()
}

async function copyCodexPrompt() {
  await navigator.clipboard.writeText(buildPromptForTask(currentTaskSlug.value))
  flashToast('已复制给 Codex')
}

async function sendToCodex() {
  updateLastPromptPreview(currentTaskSlug.value, buildPromptForTask(currentTaskSlug.value))

  const started = await getCurrentPanelRef(currentTaskSlug.value)?.send?.()
  if (started) {
    editorRef.value?.clearContent?.()
  }
}

function stopCodex() {
  getCurrentPanelRef(currentTaskSlug.value)?.stop?.()
}

function handleBeforeUnload(event) {
  event.preventDefault()
  event.returnValue = ''
}

function handleWindowKeydown(event) {
  if (!event.metaKey && !event.ctrlKey && event.shiftKey && event.key === 'Enter') {
    event.preventDefault()
    sendToCodex()
    return
  }

  if (!(event.metaKey || event.ctrlKey)) {
    return
  }

  if (event.key.toLowerCase() === 's') {
    event.preventDefault()
    saveTask({ auto: false })
    return
  }

  if (event.shiftKey && event.key === 'Backspace') {
    event.preventDefault()
    openClearDialog()
  }
}

onMounted(() => {
  initializeWorkbench()
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleWindowKeydown)
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleWindowKeydown)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <TopToast :message="toastMessage" />

    <ConfirmDialog
      :open="showClearDialog"
      title="确认清空当前任务？"
      description="将清空右侧编辑区内容，但会保留当前任务本身。"
      confirm-text="确认清空"
      cancel-text="继续编辑"
      @cancel="closeClearDialog"
      @confirm="clearAllContent"
    />
    <ConfirmDialog
      :open="showDeleteDialog"
      title="确认删除当前任务？"
      :description="`将删除「${currentTaskDisplayTitle}」，删除后无法恢复。`"
      confirm-text="确认删除"
      cancel-text="先保留"
      :loading="removingTask"
      danger
      @cancel="closeDeleteDialog"
      @confirm="confirmRemoveCurrentTask"
    />

    <div class="grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1">
      <aside class="panel flex min-h-0 flex-col overflow-hidden">
        <div class="border-b border-stone-200 px-4 py-4 dark:border-stone-800">
          <div class="flex items-center justify-between gap-3">
            <div class="flex min-h-8 items-center">
              <div class="text-sm font-medium text-stone-900 dark:text-stone-100">PromptX 工作台</div>
            </div>
            <ThemeToggle />
          </div>
          <button
            type="button"
            class="tool-button tool-button-primary mt-4 inline-flex w-full items-center justify-center gap-2 px-3 py-2 text-sm"
            :disabled="creatingTask || loadingTask || uploading"
            @click="createTaskAndSelect"
          >
            <Plus class="h-4 w-4" />
            <span>{{ creatingTask ? '创建中...' : '新建任务' }}</span>
          </button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
          <div v-if="loadingTasks && !renderedTasks.length" class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-3 py-4 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
            正在加载任务...
          </div>

          <div v-else class="space-y-2">
            <article
              v-for="task in renderedTasks"
              :key="task.slug"
              class="group relative rounded-sm border px-3 py-3 transition cursor-default"
              :class="task.slug === currentTaskSlug
                ? 'border-stone-500 bg-stone-100 text-stone-900 dark:border-stone-500 dark:bg-stone-800 dark:text-stone-100'
                : 'border-stone-300 bg-stone-50 hover:bg-stone-100 dark:border-stone-700 dark:bg-stone-900 dark:hover:bg-stone-800'"
              @click="selectTask(task.slug)"
            >
              <span
                v-if="task.slug === currentTaskSlug"
                class="absolute inset-y-2 left-0 w-1 rounded-full bg-emerald-500 dark:bg-emerald-400"
              />
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0 h-5 flex-1 overflow-hidden">
                  <input
                    v-if="task.slug === currentTaskSlug && editingTaskTitleSlug === task.slug"
                    v-model="draft.title"
                    type="text"
                    maxlength="140"
                    data-task-title-input="current"
                    class="block h-5 min-h-0 w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-5 outline-none placeholder:text-stone-500 dark:placeholder:text-stone-400"
                    :placeholder="draft.autoTitle || currentTaskAutoTitle || '未命名任务'"
                    @click.stop
                    @keydown.enter.prevent="$event.target.blur()"
                    @keydown.esc.prevent="editingTaskTitleSlug = ''"
                    @blur="handleTaskTitleBlur"
                  >
                  <button
                    v-else
                    type="button"
                    class="block h-5 w-full cursor-pointer truncate bg-transparent p-0 text-left text-sm leading-5"
                    :class="task.slug === currentTaskSlug ? 'font-semibold' : 'font-medium'"
                    @click.stop="handleTaskTitleClick(task.slug)"
                  >{{ task.displayTitle }}</button>
                </div>
                <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
                  <span
                    v-if="task.sending"
                    class="rounded-sm border border-dashed px-1.5 py-0.5"
                    :class="'border-amber-300 text-amber-700 dark:border-amber-800 dark:text-amber-300'"
                  >运行中</span>
                </div>
              </div>
              <div class="mt-2 truncate text-xs opacity-80">{{ task.lastPromptPreview || '还没有发送记录' }}</div>
              <div class="mt-2 text-[11px] opacity-70">{{ new Date(task.updatedAt).toLocaleString('zh-CN') }}</div>
              <button
                type="button"
                class="absolute bottom-2 right-2 inline-flex h-6 w-6 items-center justify-center rounded-sm text-stone-500 opacity-0 transition hover:bg-red-100 hover:text-red-700 group-hover:opacity-100 focus:opacity-100 dark:text-stone-400 dark:hover:bg-red-950/40 dark:hover:text-red-300"
                :disabled="removingTask || creatingTask || task.sending"
                @click.stop="selectTask(task.slug); openDeleteDialog()"
              >
                <Trash2 class="h-3.5 w-3.5" />
              </button>
            </article>
          </div>
        </div>

        <div class="border-t border-stone-200 px-3 py-3 dark:border-stone-800">
          <div v-if="error" class="mb-3 inline-flex min-w-0 items-start gap-2 text-xs text-red-700 dark:text-red-300">
            <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
            <span class="min-w-0 break-words">{{ error }}</span>
          </div>
        </div>
      </aside>

      <div class="grid min-h-0 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <div class="min-h-0 min-w-0 overflow-hidden">
          <div v-if="currentRenderedTask" class="h-full min-h-0">
            <CodexSessionPanel
              ref="codexPanelRef"
              :active="Boolean(currentRenderedTask?.slug)"
              :task-slug="currentRenderedTask.slug"
              :build-prompt="() => prepareCodexPromptForTask(currentRenderedTask.slug)"
              :selected-session-id="currentRenderedTask.codexSessionId || ''"
              @sending-change="handleTaskSendingChange(currentRenderedTask.slug, $event)"
              @selected-session-change="handleTaskSessionChange(currentRenderedTask.slug, $event)"
            />
          </div>
        </div>

        <div class="min-h-0 min-w-0 overflow-hidden">
          <section v-if="loadingTask && !draft.blocks.length" class="panel flex h-full items-center px-5 py-4 text-sm text-stone-500 dark:text-stone-400">
            正在加载任务内容...
          </section>
          <BlockEditor
            v-else
            ref="editorRef"
            v-model="draft.blocks"
            :codex-session-id="currentSelectedSessionId"
            :uploading="uploading"
            @upload-files="handleUpload"
            @import-text-files="handleImportTextFiles"
            @import-pdf-files="handleImportPdfFiles"
            @clear-request="openClearDialog"
          >
            <template #header-actions>
              <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="editorRef?.openFilePicker?.()">
                <Upload class="h-4 w-4" />
                <span>选文件</span>
              </button>
              <button type="button" class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3" @click="openClearDialog">
                <WandSparkles class="h-4 w-4" />
                <span>清空</span>
              </button>
              <button type="button" class="tool-button hidden items-center justify-center gap-1.5 px-2 py-2 text-xs sm:inline-flex sm:w-auto sm:gap-2 sm:px-3" @click="copyCodexPrompt">
                <Copy class="h-4 w-4" />
                <span>复制</span>
              </button>
              <button
                v-if="!isCurrentTaskSending"
                type="button"
                class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                @click="sendToCodex"
              >
                <SendHorizontal class="h-4 w-4" />
                <span>发送</span>
              </button>
              <button
                v-else
                type="button"
                class="tool-button inline-flex w-full items-center justify-center gap-1.5 px-2 py-2 text-xs sm:w-auto sm:gap-2 sm:px-3"
                @click="stopCodex"
              >
                <Square class="h-4 w-4" />
                <span>停止</span>
              </button>
            </template>
          </BlockEditor>
        </div>
      </div>
    </div>
  </div>
</template>
