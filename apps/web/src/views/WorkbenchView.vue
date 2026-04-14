<script setup>
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import EditTaskDialog from '../components/EditTaskDialog.vue'
import WorkbenchActivityPanel from '../components/WorkbenchActivityPanel.vue'
import WorkbenchInputPanel from '../components/WorkbenchInputPanel.vue'
import WorkbenchMobileDetailHeader from '../components/WorkbenchMobileDetailHeader.vue'
import WorkbenchTaskListPanel from '../components/WorkbenchTaskListPanel.vue'
import WorkbenchTodoDialog from '../components/WorkbenchTodoDialog.vue'
import TopToast from '../components/TopToast.vue'
import { useI18n } from '../composables/useI18n.js'
import { useWorkbenchMobileLayout } from '../composables/useWorkbenchMobileLayout.js'
import { usePageTitle } from '../composables/usePageTitle.js'
import { useToast } from '../composables/useToast.js'
import { useWorkbenchTasks } from '../composables/useWorkbenchTasks.js'
import { useWorkbenchPreferences } from '../lib/workbenchPreferences.js'

const showClearDialog = ref(false)
const showDeleteDialog = ref(false)
const showDiffDialog = ref(false)
const showSettingsDialog = ref(false)
const showEditTaskDialog = ref(false)
const showTodoDialog = ref(false)
const showTodoDeleteConfirm = ref(false)
const showTodoUseConfirm = ref(false)
const pendingTodoDeleteId = ref('')
const pendingTodoUseId = ref('')
const editingTaskTitleSlug = ref('')
const diffFocusToken = ref(0)
const preferredDiffScope = ref('workspace')
const preferredDiffRunId = ref('')
const { t } = useI18n()
const { toastMessage, toastType, flashToast, clearToast } = useToast()
const { sendBehavior } = useWorkbenchPreferences()
const TaskDiffReviewDialog = defineAsyncComponent(() => import('../components/TaskDiffReviewDialog.vue'))
const WorkbenchSettingsDialog = defineAsyncComponent(() => import('../components/WorkbenchSettingsDialog.vue'))

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
  addCurrentDraftToTodo,
  addReviewCommentToTask,
  applyTaskSettingsUpdate,
  buildPromptForTask,
  getPromptBlocksForTask,
  clearCurrentTaskContent,
  clearReviewCommentsForTask,
  createTaskAndSelect,
  creatingTask,
  currentSelectedSessionId,
  currentTaskSendState,
  currentTaskAutoTitle,
  currentTaskDisplayTitle,
  currentTaskSlug,
  currentReviewComments,
  draft,
  editorRef,
  error,
  handleImportPdfFiles,
  handleImportTextFiles,
  handleTaskSendingChange,
  handleTaskSessionChange,
  handleUpload,
  hasCurrentDraftContent,
  hasUnsavedChanges,
  initializeWorkbench,
  isCurrentTaskSending,
  loadingTask,
  loadingTasks,
  pageTitle,
  prepareCodexPromptForTask,
  currentTodoItems,
  removeReviewCommentFromTask,
  removeTodoItem,
  removeCurrentTask,
  reorderTaskList,
  removingTask,
  renderedTasks,
  saveTask,
  saving,
  selectTask,
  updateLastPromptPreview,
  useTodoItem,
  uploading,
} = useWorkbenchTasks({
  clearToast,
  flashToast,
  scrollCurrentPanelToBottom,
})

const currentRenderedTask = computed(() =>
  renderedTasks.value.find((task) => task.slug === currentTaskSlug.value) || null
)
const currentTaskDiffSupported = computed(() => Boolean(currentRenderedTask.value?.workspaceDiffSummary?.supported))
const currentTaskBuildPrompt = computed(() => {
  const task = currentRenderedTask.value
  if (!task) {
    return null
  }

  return () => prepareCodexPromptForTask(task.slug)
})
const currentTaskBuildPromptBlocks = computed(() => {
  const task = currentRenderedTask.value
  if (!task) {
    return null
  }

  return () => getPromptBlocksForTask(task.slug)
})
const taskListPanelProps = computed(() => ({
  creatingTask: creatingTask.value,
  currentTaskAutoTitle: draft.value.autoTitle || currentTaskAutoTitle.value,
  currentTaskSlug: currentTaskSlug.value,
  draftTitle: draft.value.title,
  editingTaskTitleSlug: editingTaskTitleSlug.value,
  error: error.value,
  isCurrentTaskSending: isCurrentTaskSending.value,
  loadingTask: loadingTask.value,
  loadingTasks: loadingTasks.value,
  removingTask: removingTask.value,
  tasks: renderedTasks.value,
  uploading: uploading.value,
}))
const activityPanelProps = computed(() => ({
  buildPromptBlocks: currentTaskBuildPromptBlocks.value,
  buildPrompt: currentTaskBuildPrompt.value,
  diffSupported: currentTaskDiffSupported.value,
  selectedSessionId: currentRenderedTask.value?.codexSessionId || '',
  sessionSelectionLockReason: currentRenderedTask.value?.sessionSelectionLockReason || '',
  sessionSelectionLocked: Boolean(currentRenderedTask.value?.sessionSelectionLocked),
  taskSlug: currentRenderedTask.value?.slug || '',
  taskRunning: Boolean(currentRenderedTask.value?.running),
}))
const inputPanelProps = computed(() => ({
  canAddTodo: hasCurrentDraftContent.value,
  codexSessionId: currentSelectedSessionId.value,
  isCurrentTaskSending: isCurrentTaskSending.value,
  reviewComments: currentReviewComments.value,
  sendBehavior: sendBehavior.value,
  sendState: currentTaskSendState.value,
  loading: loadingTask.value,
  todoCount: currentTodoItems.value.length,
  uploading: uploading.value,
}))
const mobileDetailHeaderProps = computed(() => ({
  currentTaskAutoTitle: draft.value.autoTitle || currentTaskAutoTitle.value,
  currentTaskSlug: currentTaskSlug.value,
  editingTaskTitleSlug: editingTaskTitleSlug.value,
  title: currentTaskDisplayTitle.value,
  titleInputValue: draft.value.title,
}))
const {
  enterMobileDetail,
  isMobileLayout,
  leaveMobileDetail,
  mobileDetailTab,
  mobileView,
} = useWorkbenchMobileLayout({
  currentTaskSlug,
})

function resolvePreferredMobileDetailTab(task) {
  if (task?.sending || Number(task?.codexRunCount || 0) > 0) {
    return 'activity'
  }

  return 'input'
}

usePageTitle(pageTitle)

function openTaskDiff(scope = 'workspace', runId = '') {
  preferredDiffScope.value = scope === 'run' ? 'run' : scope === 'task' ? 'task' : 'workspace'
  preferredDiffRunId.value = preferredDiffScope.value === 'run' ? String(runId || '') : ''
  showDiffDialog.value = true
  diffFocusToken.value += 1
}

function closeTaskDiff() {
  showDiffDialog.value = false
}

function openSettingsDialog() {
  showSettingsDialog.value = true
}

function closeSettingsDialog() {
  showSettingsDialog.value = false
}

function openEditTaskDialog() {
  if (!currentTaskSlug.value) {
    return
  }

  showEditTaskDialog.value = true
}

function closeEditTaskDialog() {
  showEditTaskDialog.value = false
}

function openTodoDialog() {
  showTodoDialog.value = true
}

function closeTodoDialog() {
  showTodoDialog.value = false
  closeTodoDeleteConfirm()
  closeTodoUseConfirm()
}

function closeTodoDeleteConfirm() {
  showTodoDeleteConfirm.value = false
  pendingTodoDeleteId.value = ''
}

function closeTodoUseConfirm() {
  showTodoUseConfirm.value = false
  pendingTodoUseId.value = ''
}

function handleTaskSettingsSaved(task) {
  applyTaskSettingsUpdate(task)
}

function updateDraftTitle(value) {
  draft.value.title = value
}

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

async function handleTaskTitleClick(taskSlug) {
  if (isMobileLayout.value) {
    await handleTaskSelect(taskSlug)
    return
  }

  if (taskSlug !== currentTaskSlug.value) {
    await handleTaskSelect(taskSlug)
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
  if (isMobileLayout.value) {
    leaveMobileDetail({ useHistory: false })
  }
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

function handleCurrentTaskSendingChange(nextSending) {
  const task = currentRenderedTask.value
  if (!task) {
    return
  }

  handleTaskSendingChange(task.slug, nextSending)
}

function handleCurrentTaskSessionChange(nextSessionId) {
  const task = currentRenderedTask.value
  if (!task) {
    return
  }

  handleTaskSessionChange(task.slug, nextSessionId)
}

function handleActivityToast(message) {
  flashToast(message)

  if (!isMobileLayout.value || !currentTaskSlug.value) {
    return
  }

  mobileDetailTab.value = 'activity'
}

async function flushCurrentEditorInput() {
  if (typeof document !== 'undefined' && editorRef.value?.isComposing?.()) {
    document.activeElement?.blur?.()
  }

  editorRef.value?.flushPendingInput?.()
  await nextTick()
  editorRef.value?.flushPendingInput?.()
  await nextTick()
}

async function copyCodexPrompt() {
  await flushCurrentEditorInput()
  await navigator.clipboard.writeText(buildPromptForTask(currentTaskSlug.value))
  flashToast({ message: t('workbench.promptCopied'), type: 'info' })
}

async function handleCreateTask() {
  const created = await createTaskAndSelect()
  if (created && isMobileLayout.value) {
    mobileDetailTab.value = 'input'
    enterMobileDetail()
  }
}

async function handleTaskSelect(taskSlug) {
  const targetSlug = String(taskSlug || '').trim()
  if (!targetSlug) {
    return
  }

  if (targetSlug !== currentTaskSlug.value) {
    await selectTask(targetSlug)
  }

  if (isMobileLayout.value && currentTaskSlug.value === targetSlug) {
    mobileDetailTab.value = resolvePreferredMobileDetailTab(currentRenderedTask.value)
    enterMobileDetail()
  }
}

async function handleTaskReorder(slugs = []) {
  await reorderTaskList(slugs)
}

async function handleAddTodo() {
  await flushCurrentEditorInput()
  addCurrentDraftToTodo()
}

function handleDeleteTodo(todoId) {
  pendingTodoDeleteId.value = String(todoId || '').trim()
  showTodoDeleteConfirm.value = Boolean(pendingTodoDeleteId.value)
}

function confirmDeleteTodo() {
  if (!pendingTodoDeleteId.value) {
    return
  }

  removeTodoItem(pendingTodoDeleteId.value)
  closeTodoDeleteConfirm()
}

async function applyTodoToEditor(todoId = pendingTodoUseId.value) {
  const normalizedTodoId = String(todoId || '').trim()
  if (!normalizedTodoId) {
    return false
  }

  const appliedTodo = useTodoItem(normalizedTodoId)
  if (!appliedTodo) {
    return false
  }

  closeTodoUseConfirm()
  closeTodoDialog()
  return true
}

async function handleUseTodo(todoId) {
  await flushCurrentEditorInput()
  const normalizedTodoId = String(todoId || '').trim()
  if (!normalizedTodoId) {
    return
  }

  if (!hasCurrentDraftContent.value) {
    await applyTodoToEditor(normalizedTodoId)
    return
  }

  pendingTodoUseId.value = normalizedTodoId
  showTodoUseConfirm.value = true
}

async function sendToCodex() {
  const taskSlug = currentTaskSlug.value
  if (!taskSlug) {
    return
  }

  const shouldPreserveDraftAfterSend = Boolean(currentRenderedTask.value?.automation?.enabled)
  await flushCurrentEditorInput()
  updateLastPromptPreview(taskSlug, buildPromptForTask(taskSlug))
  const didSend = await getCurrentPanelRef(taskSlug)?.send?.()
  if (!didSend || taskSlug !== currentTaskSlug.value) {
    return
  }

  if (isMobileLayout.value) {
    mobileDetailTab.value = 'activity'
  }

  if (!shouldPreserveDraftAfterSend) {
    clearCurrentTaskContent({ silent: true })
  }
  clearReviewCommentsForTask(taskSlug)
  await saveTask({ auto: false, silent: true })
}

function handleCreateReviewComment(payload = {}) {
  const taskSlug = currentTaskSlug.value
  if (!taskSlug) {
    return
  }

  const isEditingExistingComment = Boolean(String(payload?.id || '').trim())
  const createdComment = addReviewCommentToTask(taskSlug, payload)
  if (createdComment) {
    flashToast({
      message: t(isEditingExistingComment ? 'reviewComments.saved' : 'reviewComments.added'),
      type: 'success',
    })
  }
}

function handleRemoveReviewComment(commentId = '') {
  const taskSlug = currentTaskSlug.value
  if (!taskSlug) {
    return
  }

  removeReviewCommentFromTask(taskSlug, commentId)
}

function focusMobileEditorIfNeeded() {
  if (!isMobileLayout.value || mobileView.value !== 'detail' || mobileDetailTab.value !== 'input' || !currentTaskSlug.value) {
    return
  }

  nextTick(() => {
    editorRef.value?.focusEditor?.()
  })
}

function handleBeforeUnload(event) {
  if (!hasUnsavedChanges.value && !uploading.value && !saving.value) {
    return
  }

  event.preventDefault()
  event.returnValue = ''
}

function closeTopWorkbenchDialog() {
  if (showTodoUseConfirm.value) {
    closeTodoUseConfirm()
    return true
  }

  if (showTodoDeleteConfirm.value) {
    closeTodoDeleteConfirm()
    return true
  }

  if (showClearDialog.value) {
    closeClearDialog()
    return true
  }

  if (showDeleteDialog.value) {
    closeDeleteDialog()
    return true
  }

  if (showEditTaskDialog.value) {
    closeEditTaskDialog()
    return true
  }

  if (showTodoDialog.value) {
    closeTodoDialog()
    return true
  }

  if (showDiffDialog.value) {
    closeTaskDiff()
    return true
  }

  if (showSettingsDialog.value) {
    closeSettingsDialog()
    return true
  }

  if (getCurrentPanelRef(currentTaskSlug.value)?.closeTopDialog?.()) {
    return true
  }

  return false
}

function handleWindowKeydown(event) {
  const key = String(event.key || '')
  const keyLower = key.toLowerCase()
  const commandPressed = event.metaKey || event.ctrlKey

  if (key === 'Escape') {
    if (closeTopWorkbenchDialog()) {
      event.preventDefault()
      event.stopImmediatePropagation?.()
    }
    return
  }

  if (!commandPressed) {
    return
  }

  if (keyLower === 's') {
    event.preventDefault()
    saveTask({ auto: false })
    return
  }

  if (event.shiftKey && key === 'Backspace') {
    event.preventDefault()
    openClearDialog()
    return
  }

  if (event.isComposing) {
    return
  }

  if (event.shiftKey && event.code === 'Comma') {
    event.preventDefault()
    openSettingsDialog()
    return
  }

  if (event.shiftKey && keyLower === 'k') {
    event.preventDefault()
    getCurrentPanelRef(currentTaskSlug.value)?.openProjectManager?.()
    return
  }

  if (event.shiftKey && keyLower === 'o') {
    event.preventDefault()
    getCurrentPanelRef(currentTaskSlug.value)?.openSourceBrowser?.()
    return
  }

  if (event.shiftKey && keyLower === 'd') {
    event.preventDefault()
    if (currentTaskDiffSupported.value) {
      openTaskDiff('workspace')
    }
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

watch(
  [isMobileLayout, mobileView, mobileDetailTab, currentTaskSlug],
  ([mobile, view, tab, taskSlug]) => {
    if (!mobile || view !== 'detail' || tab !== 'input' || !taskSlug) {
      return
    }
    focusMobileEditorIfNeeded()
  }
)

const taskListPanelListeners = {
  'update:draftTitle': updateDraftTitle,
  'cancel-title-edit': () => {
    editingTaskTitleSlug.value = ''
  },
  'create-task': handleCreateTask,
  'edit-task': openEditTaskDialog,
  'delete-task': openDeleteDialog,
  'open-settings': openSettingsDialog,
  'reorder-task': handleTaskReorder,
  'select-task': handleTaskSelect,
  'title-blur': handleTaskTitleBlur,
  'title-click': handleTaskTitleClick,
}

const activityPanelListeners = {
  'open-diff': ({ scope, runId }) => openTaskDiff(scope, runId),
  'project-created': () => flashToast({ message: t('workbench.projectCreated'), type: 'success' }),
  'selected-session-change': handleCurrentTaskSessionChange,
  'sending-change': handleCurrentTaskSendingChange,
  toast: handleActivityToast,
}

const inputPanelListeners = {
  'add-todo': handleAddTodo,
  'clear-request': openClearDialog,
  'copy-request': copyCodexPrompt,
  'file-feedback': (message) => flashToast({ message, type: 'warning' }),
  'import-pdf-files': handleImportPdfFiles,
  'import-text-files': handleImportTextFiles,
  'manage-todo': openTodoDialog,
  'remove-review-comment': handleRemoveReviewComment,
  'send-request': sendToCodex,
  'upload-files': handleUpload,
}

const mobileDetailHeaderListeners = {
  'begin-edit': () => beginTaskTitleEdit(currentTaskSlug.value),
  'back': leaveMobileDetail,
  'cancel-title-edit': () => {
    editingTaskTitleSlug.value = ''
  },
  'title-blur': handleTaskTitleBlur,
  'update:titleInputValue': updateDraftTitle,
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <TopToast :message="toastMessage" :type="toastType" />

    <ConfirmDialog
      :open="showClearDialog"
      :title="t('workbench.confirmClearTitle')"
      :description="t('workbench.confirmClearDescription')"
      :confirm-text="t('workbench.confirmClearAction')"
      :cancel-text="t('workbench.continueEditing')"
      @cancel="closeClearDialog"
      @confirm="clearAllContent"
    />
    <ConfirmDialog
      :open="showDeleteDialog"
      :title="t('workbench.confirmDeleteTitle')"
      :description="t('workbench.confirmDeleteDescription', { title: currentTaskDisplayTitle })"
      :confirm-text="t('workbench.confirmDeleteAction')"
      :cancel-text="t('workbench.keepForNow')"
      :loading="removingTask"
      danger
      @cancel="closeDeleteDialog"
      @confirm="confirmRemoveCurrentTask"
    />
    <ConfirmDialog
      :open="showTodoDeleteConfirm"
      :title="t('workbench.confirmDeleteTodoTitle')"
      :description="t('workbench.confirmDeleteTodoDescription')"
      :confirm-text="t('workbench.confirmDeleteAction')"
      :cancel-text="t('workbench.keepForNow')"
      danger
      @cancel="closeTodoDeleteConfirm"
      @confirm="confirmDeleteTodo"
    />
    <ConfirmDialog
      :open="showTodoUseConfirm"
      :title="t('workbench.replaceEditorTitle')"
      :description="t('workbench.replaceEditorDescription')"
      :confirm-text="t('workbench.confirmReplaceAction')"
      :cancel-text="t('workbench.dontReplaceYet')"
      @cancel="closeTodoUseConfirm"
      @confirm="applyTodoToEditor()"
    />
    <WorkbenchTodoDialog
      :open="showTodoDialog"
      :items="currentTodoItems"
      @close="closeTodoDialog"
      @delete="handleDeleteTodo"
      @use="handleUseTodo"
    />
    <TaskDiffReviewDialog
      :open="showDiffDialog"
      :review-comments="currentReviewComments"
      :task-slug="currentTaskSlug"
      :task-title="currentTaskDisplayTitle"
      :preferred-scope="preferredDiffScope"
      :preferred-run-id="preferredDiffRunId"
      :focus-token="diffFocusToken"
      @save-review-comment="handleCreateReviewComment"
      @remove-review-comment="handleRemoveReviewComment"
      @close="closeTaskDiff"
    />
    <WorkbenchSettingsDialog :open="showSettingsDialog" @close="closeSettingsDialog" />
    <EditTaskDialog
      :open="showEditTaskDialog"
      :task-slug="currentTaskSlug"
      :task-title="currentTaskDisplayTitle"
      @close="closeEditTaskDialog"
      @saved="handleTaskSettingsSaved"
    />

    <div v-if="!isMobileLayout" class="workbench-desktop-layout grid min-h-0 flex-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)] lg:grid-rows-1">
      <WorkbenchTaskListPanel
        v-bind="taskListPanelProps"
        v-on="taskListPanelListeners"
      />

      <div class="workbench-detail-layout grid min-h-0 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <div class="min-h-0 min-w-0 overflow-hidden">
          <WorkbenchActivityPanel
            v-if="currentRenderedTask"
            ref="codexPanelRef"
            v-bind="activityPanelProps"
            v-on="activityPanelListeners"
          />
        </div>

        <div class="min-h-0 min-w-0 overflow-hidden">
          <WorkbenchInputPanel
            ref="editorRef"
            v-model="draft.blocks"
            v-bind="inputPanelProps"
            v-on="inputPanelListeners"
          />
        </div>
      </div>
    </div>

    <div v-else class="min-h-0 flex-1 overflow-hidden">
      <WorkbenchTaskListPanel
        v-if="mobileView === 'tasks'"
        v-bind="taskListPanelProps"
        mobile
        v-on="taskListPanelListeners"
      />

      <div v-else class="workbench-mobile-detail-layout flex h-full min-h-0 flex-col gap-1.5 overflow-hidden">
        <WorkbenchMobileDetailHeader
          v-bind="mobileDetailHeaderProps"
          v-on="mobileDetailHeaderListeners"
        />

        <section class="workbench-mobile-tabs-panel shrink-0">
          <div class="workbench-mobile-tabs grid grid-cols-2 gap-2">
            <button
              type="button"
              class="tool-button px-3 py-1.5 text-sm"
              :class="mobileDetailTab === 'activity' ? 'tool-button-accent-subtle' : ''"
              @click="mobileDetailTab = 'activity'"
            >
              {{ t('workbench.activity') }}
            </button>
            <button
              type="button"
              class="tool-button px-3 py-1.5 text-sm"
              :class="mobileDetailTab === 'input' ? 'tool-button-accent-subtle' : ''"
              @click="mobileDetailTab = 'input'"
            >
              {{ t('workbench.input') }}
            </button>
          </div>
        </section>

        <div class="min-h-0 flex-1 overflow-hidden">
          <div v-show="mobileDetailTab === 'activity'" class="h-full min-h-0">
            <WorkbenchActivityPanel
              ref="codexPanelRef"
              v-bind="activityPanelProps"
              :empty-message="t('workbench.selectTask')"
              v-on="activityPanelListeners"
            />
          </div>

          <div v-show="mobileDetailTab === 'input'" class="h-full min-h-0">
            <WorkbenchInputPanel
              ref="editorRef"
              v-model="draft.blocks"
              v-bind="inputPanelProps"
              v-on="inputPanelListeners"
            />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
