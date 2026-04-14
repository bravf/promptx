import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { BLOCK_TYPES, deriveTitleFromBlocks } from '@promptx/shared'
import {
  createTask,
  deleteTask,
  getApiBase,
  getTask,
  importPdf,
  listTasks,
  listTaskWorkspaceDiffSummaries,
  reorderTasks,
  resolveAssetUrl,
  updateTaskCodexSession,
  updateTask,
  uploadImage,
} from '../lib/api.js'
import { buildCodexPrompt } from '../lib/codex.js'
import {
  buildReviewCommentPromptBlocks,
  getTaskReviewComments,
  loadReviewCommentMap,
  saveReviewCommentMap,
  setTaskReviewComments,
} from '../lib/reviewComments.js'
import { translate } from './useI18n.js'
import { useWorkbenchRealtime } from './useWorkbenchRealtime.js'

const ACTIVE_TASK_STORAGE_KEY = 'promptx:active-task-slug'
const SERVER_SYNC_DELAY = 150
const LOCAL_REORDER_SSE_SUPPRESS_MS = 1500

function normalizeWorkspaceDiffSummary(summary = null) {
  if (!summary || typeof summary !== 'object') {
    return null
  }

  return {
    supported: Boolean(summary.supported),
    fileCount: Math.max(0, Number(summary.fileCount) || 0),
    additions: Math.max(0, Number(summary.additions) || 0),
    deletions: Math.max(0, Number(summary.deletions) || 0),
    statsComplete: Boolean(summary.statsComplete),
  }
}

function cloneBlocks(blocks = []) {
  return (blocks || []).map((block) => ({
    ...block,
    clientId: String(block?.clientId || block?.id || globalThis.crypto?.randomUUID?.() || `block-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
    meta: block?.meta ? { ...block.meta } : {},
  }))
}

function cloneTodoItems(items = []) {
  return (items || []).map((item) => ({
    id: String(item?.id || '').trim(),
    createdAt: String(item?.createdAt || ''),
    blocks: cloneBlocks(item?.blocks || []),
  }))
}

function cloneDraftState(state = {}) {
  return {
    title: String(state.title || ''),
    autoTitle: String(state.autoTitle || ''),
    lastPromptPreview: String(state.lastPromptPreview || ''),
    codexSessionId: String(state.codexSessionId || ''),
    blocks: cloneBlocks(state.blocks || []),
    todoItems: cloneTodoItems(state.todoItems || []),
  }
}

function normalizeTodoItemBlocks(blocks = []) {
  return cloneBlocks(blocks).filter((block) => {
    if (block?.type === BLOCK_TYPES.IMAGE) {
      return Boolean(String(block.content || '').trim())
    }

    return Boolean(String(block?.content || '').trim())
  })
}

function hasMeaningfulBlocks(blocks = []) {
  return normalizeTodoItemBlocks(blocks).length > 0
}

function createTodoItemId() {
  const randomUuid = globalThis.crypto?.randomUUID?.()
  if (randomUuid) {
    return `todo-${randomUuid}`
  }

  return `todo-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
}

function createEmptyTextBlocks() {
  return cloneBlocks([
    {
      type: BLOCK_TYPES.TEXT,
      content: '',
      meta: {},
    },
  ])
}

function deriveAutoTaskTitle(blocks = [], max = 16) {
  return deriveTitleFromBlocks(blocks, max) || ''
}

export function deriveTaskPreview(blocks = [], max = 120) {
  const firstTextBlock = blocks.find((block) => {
    const isTextBlock = block?.type === 'text' || block?.type === 'imported_text'
    return isTextBlock && String(block.content || '').trim()
  })

  return String(firstTextBlock?.content || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function resolveTaskDisplayTitle(task = {}, blocks = []) {
  const manualTitle = String(task?.title || '').trim()
  if (manualTitle) {
    return manualTitle
  }

  const cachedAutoTitle = String(task?.autoTitle || '').trim()
  if (cachedAutoTitle) {
    return cachedAutoTitle
  }

  const derivedFromBlocks = deriveAutoTaskTitle(blocks)
  if (derivedFromBlocks) {
    return derivedFromBlocks
  }

  const preview = String(task?.preview || '').trim()
  if (preview) {
    return preview.slice(0, 16)
  }

  return translate('workbench.untitledTask')
}

export function isTaskRunning(task = {}) {
  return Boolean(task?.running)
}

export function isCurrentTaskSendingState(task = {}, localSending = false) {
  return Boolean(isTaskRunning(task) || localSending)
}

export function getCurrentTaskSendState(task = {}, localSending = false) {
  if (Boolean(localSending) && !isTaskRunning(task)) {
    return 'sending'
  }

  if (isTaskRunning(task)) {
    return 'running'
  }

  return 'idle'
}

export function isActiveRunStatus(status = '') {
  return ['queued', 'starting', 'running', 'stopping'].includes(String(status || '').trim())
}

export function buildPromptPreview(prompt = '', max = 72) {
  return String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

export function reorderTaskSummaries(items = [], orderedSlugs = []) {
  const nextItems = Array.isArray(items) ? [...items] : []
  const requestedOrder = Array.isArray(orderedSlugs)
    ? orderedSlugs.map((slug) => String(slug || '').trim()).filter(Boolean)
    : []

  if (!requestedOrder.length) {
    return nextItems
  }

  const itemBySlug = new Map(
    nextItems
      .map((item) => {
        const slug = String(item?.slug || '').trim()
        return slug ? [slug, item] : null
      })
      .filter(Boolean)
  )

  const orderedItems = requestedOrder
    .map((slug) => itemBySlug.get(slug) || null)
    .filter(Boolean)

  const remainingItems = nextItems.filter((item) => {
    const slug = String(item?.slug || '').trim()
    return slug && !requestedOrder.includes(slug)
  })

  return [
    ...orderedItems,
    ...remainingItems,
  ]
}

export function mergeTaskSummariesWithWorkspaceDiff(prevItems = [], nextItems = []) {
  const previousBySlug = new Map(
    (prevItems || [])
      .map((item) => {
        const slug = String(item?.slug || '').trim()
        return slug ? [slug, item] : null
      })
      .filter(Boolean)
  )

  const normalizedNextItems = (nextItems || []).map((item) => {
    const slug = String(item?.slug || '').trim()
    const nextSessionId = String(item?.codexSessionId || '').trim()

    if (!slug) {
      return item
    }

    if (Object.prototype.hasOwnProperty.call(item, 'workspaceDiffSummary')) {
      return {
        ...item,
        workspaceDiffSummary: normalizeWorkspaceDiffSummary(item.workspaceDiffSummary),
      }
    }

    if (!nextSessionId) {
      return {
        ...item,
        workspaceDiffSummary: null,
      }
    }

    const previousItem = previousBySlug.get(slug)
    const previousSessionId = String(previousItem?.codexSessionId || '').trim()
    if (previousSessionId && previousSessionId === nextSessionId) {
      return {
        ...item,
        workspaceDiffSummary: normalizeWorkspaceDiffSummary(previousItem.workspaceDiffSummary),
      }
    }

    return {
      ...item,
      workspaceDiffSummary: null,
    }
  })

  return normalizedNextItems
}

export function shouldRefreshWorkspaceDiffSummaries(prevItems = [], nextItems = []) {
  const previousItems = Array.isArray(prevItems) ? prevItems : []
  const nextTaskItems = Array.isArray(nextItems) ? nextItems : []

  if (!nextTaskItems.length) {
    return false
  }

  if (previousItems.length !== nextTaskItems.length) {
    return true
  }

  const previousBySlug = new Map(
    previousItems
      .map((item) => {
        const slug = String(item?.slug || '').trim()
        return slug ? [slug, item] : null
      })
      .filter(Boolean)
  )

  return nextTaskItems.some((item) => {
    const slug = String(item?.slug || '').trim()
    if (!slug) {
      return true
    }

    const previousItem = previousBySlug.get(slug)
    if (!previousItem) {
      return true
    }

    const currentSessionId = String(item?.codexSessionId || '').trim()
    const previousSessionId = String(previousItem?.codexSessionId || '').trim()
    if (currentSessionId !== previousSessionId) {
      return true
    }

    if (Boolean(item?.running) !== Boolean(previousItem?.running)) {
      return true
    }

    if (currentSessionId && !Object.prototype.hasOwnProperty.call(previousItem || {}, 'workspaceDiffSummary')) {
      return true
    }

    if (currentSessionId && previousItem?.workspaceDiffSummary == null) {
      return true
    }

    return false
  })
}

function persistActiveTaskSlug(slug) {
  if (typeof window === 'undefined') {
    return
  }

  const value = String(slug || '').trim()
  if (value) {
    window.localStorage.setItem(ACTIVE_TASK_STORAGE_KEY, value)
    return
  }

  window.localStorage.removeItem(ACTIVE_TASK_STORAGE_KEY)
}

function getPersistedActiveTaskSlug() {
  if (typeof window === 'undefined') {
    return ''
  }

  return String(window.localStorage.getItem(ACTIVE_TASK_STORAGE_KEY) || '').trim()
}

function getRequestedTaskSlug() {
  if (typeof window === 'undefined') {
    return ''
  }

  try {
    const url = new URL(window.location.href)
    return String(url.searchParams.get('task') || '').trim()
  } catch {
    return ''
  }
}

function clearRequestedTaskSlug() {
  if (typeof window === 'undefined') {
    return
  }

  try {
    const url = new URL(window.location.href)
    if (!url.searchParams.has('task')) {
      return
    }
    url.searchParams.delete('task')
    const nextUrl = `${url.pathname}${url.search}${url.hash}`
    window.history.replaceState({}, '', nextUrl || '/')
  } catch {
    // ignore malformed location values
  }
}

function toTaskSummary(taskRecord) {
  const summary = {
    slug: taskRecord.slug,
    sortOrder: Number(taskRecord.sortOrder) || 0,
    title: String(taskRecord.title || ''),
    autoTitle: String(taskRecord.autoTitle || ''),
    lastPromptPreview: String(taskRecord.lastPromptPreview || ''),
    codexSessionId: String(taskRecord.codexSessionId || ''),
    codexRunCount: Math.max(0, Number(taskRecord.codexRunCount) || 0),
    todoCount: Math.max(0, Number(taskRecord.todoCount) || 0),
    running: Boolean(taskRecord.running),
    preview: String(taskRecord.lastPromptPreview || ''),
    updatedAt: taskRecord.updatedAt || taskRecord.createdAt || new Date().toISOString(),
    createdAt: taskRecord.createdAt || taskRecord.updatedAt || new Date().toISOString(),
    automation: taskRecord?.automation
      ? {
          enabled: Boolean(taskRecord.automation.enabled),
          cron: String(taskRecord.automation.cron || ''),
          nextTriggerAt: String(taskRecord.automation.nextTriggerAt || ''),
        }
      : undefined,
    notification: taskRecord?.notification
      ? {
          enabled: Boolean(taskRecord.notification.enabled),
          channelType: String(taskRecord.notification.channelType || ''),
          triggerOn: String(taskRecord.notification.triggerOn || ''),
          lastStatus: String(taskRecord.notification.lastStatus || ''),
          lastSentAt: String(taskRecord.notification.lastSentAt || ''),
        }
      : undefined,
  }

  if (Object.prototype.hasOwnProperty.call(taskRecord, 'workspaceDiffSummary')) {
    summary.workspaceDiffSummary = normalizeWorkspaceDiffSummary(taskRecord.workspaceDiffSummary)
  }

  return summary
}

export function useWorkbenchTasks(options = {}) {
  const {
    clearToast = () => {},
    flashToast = () => {},
    scrollCurrentPanelToBottom = () => {},
  } = options

  const apiBase = getApiBase()
  const realtime = useWorkbenchRealtime()
  const editorRef = ref(null)
  const tasks = ref([])
  const taskDraftMap = ref({})
  const reviewCommentsMap = ref(loadReviewCommentMap())
  const selectedSessionMap = ref({})
  const sendingTaskMap = ref({})
  const currentTaskSlug = ref('')
  const draft = ref({
    title: '',
    autoTitle: '',
    lastPromptPreview: '',
    codexSessionId: '',
    blocks: [],
    todoItems: [],
  })
  const loadingTasks = ref(true)
  const loadingTask = ref(false)
  const creatingTask = ref(false)
  const removingTask = ref(false)
  const saving = ref(false)
  const uploading = ref(false)
  const error = ref('')
  const hasUnsavedChanges = ref(false)
  const lastSavedSnapshot = ref('')

  let autoSaveTimer = null
  let savePromise = null
  let loadRequestId = 0
  let serverSyncTimer = null
  let workspaceDiffSummaryRequestId = 0
  let pendingServerSyncTaskSlug = null
  let suppressLocalReorderSseUntil = 0
  let hydratedTaskUpdatedAtMap = {}

  const currentTaskAutoTitle = computed(() => deriveAutoTaskTitle(draft.value.blocks))
  const currentTaskDisplayTitle = computed(() => resolveTaskDisplayTitle({
    title: draft.value.title,
    autoTitle: draft.value.autoTitle,
    preview: deriveTaskPreview(draft.value.blocks),
  }, draft.value.blocks))
  const currentSelectedSessionId = computed(() => selectedSessionMap.value[currentTaskSlug.value] || '')
  const currentTaskSendState = computed(() => getCurrentTaskSendState(
    getTaskSummary(currentTaskSlug.value),
    sendingTaskMap.value[currentTaskSlug.value]
  ))
  const isCurrentTaskSending = computed(() => currentTaskSendState.value !== 'idle')
  const hasAnyTaskSending = computed(() => (
    tasks.value.some((task) => isTaskRunning(task))
    || Object.values(sendingTaskMap.value).some(Boolean)
  ))
  const hasCurrentDraftContent = computed(() => hasMeaningfulBlocks(draft.value.blocks))
  const currentTodoItems = computed(() => cloneTodoItems(draft.value.todoItems))
  const currentReviewComments = computed(() => getTaskReviewComments(reviewCommentsMap.value, currentTaskSlug.value))
  const pageTitle = computed(() => currentTaskDisplayTitle.value || translate('workbench.untitledTask'))
  const renderedTasks = computed(() => tasks.value.map((task) => buildRenderedTask(task)))

  function normalizeImageContent(content = '') {
    if (!content || !content.startsWith(apiBase)) {
      return content
    }

    return content.slice(apiBase.length)
  }

  function getReviewCommentsForTask(slug) {
    return getTaskReviewComments(reviewCommentsMap.value, slug)
  }

  function setReviewCommentsForTask(slug, comments = []) {
    reviewCommentsMap.value = setTaskReviewComments(reviewCommentsMap.value, slug, comments)
    saveReviewCommentMap(reviewCommentsMap.value)
  }

  function addReviewCommentToTask(slug, comment = {}) {
    const normalizedSlug = String(slug || '').trim()
    if (!normalizedSlug) {
      return null
    }

    const nextComment = {
      id: String(
        comment?.id
        || globalThis.crypto?.randomUUID?.()
        || `review-comment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      ).trim(),
      createdAt: String(comment?.createdAt || new Date().toISOString()).trim(),
      ...comment,
    }

    const existingComments = getReviewCommentsForTask(normalizedSlug)
    const existingIndex = existingComments.findIndex((item) => item.id === nextComment.id)
    const nextComments = [...existingComments]

    if (existingIndex >= 0) {
      nextComments.splice(existingIndex, 1, {
        ...existingComments[existingIndex],
        ...nextComment,
      })
      setReviewCommentsForTask(normalizedSlug, nextComments)
      return nextComments[existingIndex] || null
    }

    nextComments.push(nextComment)
    setReviewCommentsForTask(normalizedSlug, nextComments)
    return nextComments[nextComments.length - 1] || null
  }

  function removeReviewCommentFromTask(slug, commentId = '') {
    const normalizedSlug = String(slug || '').trim()
    const normalizedCommentId = String(commentId || '').trim()
    if (!normalizedSlug || !normalizedCommentId) {
      return
    }

    setReviewCommentsForTask(
      normalizedSlug,
      getReviewCommentsForTask(normalizedSlug).filter((item) => item.id !== normalizedCommentId)
    )
  }

  function clearReviewCommentsForTask(slug) {
    const normalizedSlug = String(slug || '').trim()
    if (!normalizedSlug) {
      return
    }

    setReviewCommentsForTask(normalizedSlug, [])
  }

function trimBoundaryBlankLines(value = '') {
  const lines = String(value || '').replace(/\r\n/g, '\n').split('\n')

  while (lines.length && !String(lines[0] || '').trim()) {
    lines.shift()
  }

  while (lines.length && !String(lines[lines.length - 1] || '').trim()) {
    lines.pop()
  }

  return lines.join('\n')
}

function normalizeBlocksForSave(blocks = []) {
  return blocks.map((block) => ({
    id: Number.isInteger(Number(block?.id)) ? Number(block.id) : null,
    type: block?.type,
    content:
      block?.type === 'image'
        ? normalizeImageContent(block.content)
        : trimBoundaryBlankLines(block.content),
    meta: block?.meta ? { ...block.meta } : {},
  }))
}

function normalizeTodoItemsForSnapshot(items = []) {
  return (items || []).map((item) => ({
    id: String(item?.id || '').trim(),
    createdAt: String(item?.createdAt || ''),
    blocks: normalizeBlocksForSave(item?.blocks || []),
  }))
}

  function createSnapshot(
    title = draft.value.title,
    autoTitle = draft.value.autoTitle,
    lastPromptPreview = draft.value.lastPromptPreview,
    todoItems = draft.value.todoItems,
    codexSessionId = draft.value.codexSessionId,
    blocks = draft.value.blocks
  ) {
    return JSON.stringify({
      title: String(title || ''),
      autoTitle: String(autoTitle || ''),
      lastPromptPreview: String(lastPromptPreview || ''),
      todoItems: normalizeTodoItemsForSnapshot(todoItems),
      codexSessionId: String(codexSessionId || ''),
      blocks: normalizeBlocksForSave(blocks),
    })
  }

  function hasPendingDraftChanges() {
    return createSnapshot() !== lastSavedSnapshot.value
  }

  function isCurrentTaskEditorEditing() {
    return Boolean(editorRef.value?.isEditing?.())
  }

  function getTaskSummary(slug) {
    return tasks.value.find((task) => task.slug === slug) || null
  }

  function getTaskDraftState(slug) {
    if (!slug) {
      return null
    }

    return taskDraftMap.value[slug] || null
  }

  function markTaskHydrated(taskSlug, updatedAt = '') {
    const normalizedSlug = String(taskSlug || '').trim()
    if (!normalizedSlug) {
      return
    }

    hydratedTaskUpdatedAtMap = {
      ...hydratedTaskUpdatedAtMap,
      [normalizedSlug]: String(updatedAt || '').trim(),
    }
  }

  function isTaskHydrationFresh(taskSlug = '') {
    const normalizedSlug = String(taskSlug || '').trim()
    if (!normalizedSlug) {
      return false
    }

    const summaryUpdatedAt = String(getTaskSummary(normalizedSlug)?.updatedAt || '').trim()
    const hydratedUpdatedAt = String(hydratedTaskUpdatedAtMap[normalizedSlug] || '').trim()
    return Boolean(summaryUpdatedAt && hydratedUpdatedAt && summaryUpdatedAt === hydratedUpdatedAt)
  }

  function buildRenderedTask(task) {
    const cachedDraft = getTaskDraftState(task.slug)
    const blocks = task.slug === currentTaskSlug.value
      ? draft.value.blocks
      : cachedDraft?.blocks || []
    const title = task.slug === currentTaskSlug.value
      ? draft.value.title
      : cachedDraft?.title ?? task.title
    const autoTitle = task.slug === currentTaskSlug.value
      ? draft.value.autoTitle
      : cachedDraft?.autoTitle ?? task.autoTitle
    const todoCount = task.slug === currentTaskSlug.value
      ? cloneTodoItems(draft.value.todoItems).length
      : cloneTodoItems(cachedDraft?.todoItems || []).length || Number(task.todoCount || 0)
    const preview = task.slug === currentTaskSlug.value
      ? draft.value.lastPromptPreview || task.lastPromptPreview || ''
      : cachedDraft?.lastPromptPreview || task.lastPromptPreview || ''
    const codexSessionId = task.slug === currentTaskSlug.value
      ? selectedSessionMap.value[task.slug] || draft.value.codexSessionId || task.codexSessionId || ''
      : cachedDraft?.codexSessionId || task.codexSessionId || ''

    return {
      ...task,
      title,
      autoTitle,
      todoCount,
      preview,
      codexSessionId,
      sessionSelectionLocked: Boolean(codexSessionId && Number(task.codexRunCount || 0) > 0),
      sessionSelectionLockReason: codexSessionId && Number(task.codexRunCount || 0) > 0
        ? translate('taskActions.sessionLocked')
        : '',
      displayTitle: resolveTaskDisplayTitle({ title, autoTitle, preview }, blocks),
      sending: isTaskRunning(task),
    }
  }

  function upsertTaskSummary(summary, options = {}) {
    const { insertAtStart = false } = options
    if (!summary?.slug) {
      return
    }

    const nextTasks = [...tasks.value]
    const existingIndex = nextTasks.findIndex((task) => task.slug === summary.slug)

    if (existingIndex >= 0) {
      nextTasks.splice(existingIndex, 1, {
        ...nextTasks[existingIndex],
        ...summary,
      })
      tasks.value = nextTasks
      return
    }

    if (insertAtStart) {
      nextTasks.unshift(summary)
    } else {
      nextTasks.push(summary)
    }
    tasks.value = nextTasks
  }

  function setTaskDraftState(slug, state) {
    if (!slug) {
      return
    }

    taskDraftMap.value = {
      ...taskDraftMap.value,
      [slug]: cloneDraftState(state),
    }
  }

  function getTaskRawUrl(slug) {
    return slug ? `${apiBase}/api/tasks/${slug}/raw` : `${apiBase}/api/tasks/`
  }

  function applyTaskRunningStateFromRealtime(taskSlug = '') {
    const normalizedTaskSlug = String(taskSlug || '').trim()
    if (!normalizedTaskSlug) {
      return
    }

    const currentSummary = getTaskSummary(normalizedTaskSlug)
    const change = realtime.getTaskRunChange(normalizedTaskSlug)
    if (!currentSummary || !change?.status) {
      return
    }

    const nextRunning = isActiveRunStatus(change.status)
    if (Boolean(currentSummary.running) === nextRunning) {
      return
    }

    upsertTaskSummary({
      ...currentSummary,
      running: nextRunning,
    })
  }

  function handleTaskSendingChange(slug, value) {
    sendingTaskMap.value = {
      ...sendingTaskMap.value,
      [slug]: Boolean(value),
    }
  }

  function syncSendingTaskMapWithTasks(nextTasks = tasks.value) {
    const nextMap = {}

    ;(nextTasks || []).forEach((task) => {
      if (!task?.slug) {
        return
      }
      nextMap[task.slug] = Boolean(task.running)
    })

    sendingTaskMap.value = nextMap
  }

  function setTaskSelectedSessionId(slug, sessionId) {
    if (!slug) {
      return
    }

    selectedSessionMap.value = {
      ...selectedSessionMap.value,
      [slug]: String(sessionId || '').trim(),
    }
  }

  async function handleTaskSessionChange(slug, sessionId) {
    const targetSlug = String(slug || '').trim()
    if (!targetSlug) {
      return
    }

    const normalizedSessionId = String(sessionId || '').trim()
    const currentSummary = getTaskSummary(targetSlug)
    const previousSessionId = selectedSessionMap.value[targetSlug] || currentSummary?.codexSessionId || ''
    const sessionSelectionLocked = Boolean(previousSessionId && Number(currentSummary?.codexRunCount || 0) > 0)
    if (sessionSelectionLocked && normalizedSessionId !== previousSessionId) {
      error.value = translate('taskActions.sessionLocked')
      return
    }

    setTaskSelectedSessionId(targetSlug, normalizedSessionId)

    const cachedDraft = getTaskDraftState(targetSlug)
    if (cachedDraft) {
      setTaskDraftState(targetSlug, {
        ...cachedDraft,
        codexSessionId: normalizedSessionId,
      })
    }
    if (currentSummary) {
      upsertTaskSummary({
        ...currentSummary,
        codexSessionId: normalizedSessionId,
        workspaceDiffSummary: normalizedSessionId && normalizedSessionId === previousSessionId
          ? currentSummary.workspaceDiffSummary
          : null,
      })
    }

    if (targetSlug === currentTaskSlug.value) {
      draft.value = {
        ...draft.value,
        codexSessionId: normalizedSessionId,
      }
    }

    try {
      await updateTaskCodexSession(targetSlug, normalizedSessionId)
    } catch (err) {
      setTaskSelectedSessionId(targetSlug, previousSessionId)
      if (cachedDraft) {
        setTaskDraftState(targetSlug, {
          ...cachedDraft,
          codexSessionId: previousSessionId,
        })
      }
      if (currentSummary) {
        upsertTaskSummary({
          ...currentSummary,
          codexSessionId: previousSessionId,
        })
      }
      if (targetSlug === currentTaskSlug.value) {
        draft.value = {
          ...draft.value,
          codexSessionId: previousSessionId,
        }
      }
      error.value = err.message
    }
  }

  function clearAutoSaveTimer() {
    if (autoSaveTimer) {
      window.clearTimeout(autoSaveTimer)
      autoSaveTimer = null
    }
  }

  function clearServerSyncTimer() {
    if (serverSyncTimer) {
      window.clearTimeout(serverSyncTimer)
      serverSyncTimer = null
    }
  }

  function scheduleAutoSave() {
    clearAutoSaveTimer()
    if (loadingTask.value || !currentTaskSlug.value) {
      return
    }

    autoSaveTimer = window.setTimeout(() => {
      saveTask({ auto: true, silent: true })
    }, 1500)
  }

  function syncDraftSummary() {
    if (!currentTaskSlug.value) {
      return
    }

    const currentSummary = getTaskSummary(currentTaskSlug.value) || {
      slug: currentTaskSlug.value,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    upsertTaskSummary({
      ...currentSummary,
      title: String(draft.value.title || ''),
      autoTitle: String(draft.value.autoTitle || ''),
      lastPromptPreview: String(draft.value.lastPromptPreview || ''),
      todoCount: cloneTodoItems(draft.value.todoItems).length,
      codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || draft.value.codexSessionId || ''),
      preview: String(draft.value.lastPromptPreview || ''),
    })
  }

  function applyTaskSettingsUpdate(taskRecord = {}) {
    const slug = String(taskRecord?.slug || '').trim()
    if (!slug) {
      return
    }

    const summary = toTaskSummary(taskRecord)
    upsertTaskSummary(summary)
    markTaskHydrated(slug, summary.updatedAt || taskRecord.updatedAt || '')

    if (slug !== currentTaskSlug.value) {
      return
    }

    if (Object.prototype.hasOwnProperty.call(taskRecord, 'title')) {
      draft.value.title = String(taskRecord.title || '')
    }
    if (Object.prototype.hasOwnProperty.call(taskRecord, 'autoTitle')) {
      draft.value.autoTitle = String(taskRecord.autoTitle || '')
    }

    setTaskDraftState(slug, {
      ...draft.value,
    })
  }

  function applyTaskWorkspaceDiffSummaries(items = []) {
    const summaryBySlug = new Map(
      (items || [])
        .map((item) => {
          const slug = String(item?.slug || '').trim()
          if (!slug) {
            return null
          }

          return [slug, normalizeWorkspaceDiffSummary(item.workspaceDiffSummary)]
        })
        .filter(Boolean)
    )

    if (!summaryBySlug.size) {
      return
    }

    tasks.value = tasks.value.map((task) => {
      if (!summaryBySlug.has(task.slug)) {
        return task
      }

      return {
        ...task,
        workspaceDiffSummary: summaryBySlug.get(task.slug),
      }
    })
  }

  async function refreshTaskWorkspaceDiffSummaries(taskItems = tasks.value) {
    const nextTaskItems = Array.isArray(taskItems) ? taskItems : []
    const tasksWithSessions = nextTaskItems.filter((task) => String(task?.codexSessionId || '').trim())
    const requestId = ++workspaceDiffSummaryRequestId

    if (!tasksWithSessions.length) {
      tasks.value = nextTaskItems.map((task) => {
        if (Object.prototype.hasOwnProperty.call(task, 'workspaceDiffSummary')) {
          return task
        }

        return {
          ...task,
          workspaceDiffSummary: null,
        }
      })
      return
    }

    try {
      const payload = await listTaskWorkspaceDiffSummaries(nextTaskItems.length || 30)
      if (requestId !== workspaceDiffSummaryRequestId) {
        return
      }

      applyTaskWorkspaceDiffSummaries(payload.items || [])
    } catch {
      // Ignore summary fetch failures so the main task list stays responsive.
    }
  }

  async function refreshTaskList(options = {}) {
    const { silent = false } = options
    if (!silent) {
      loadingTasks.value = true
      error.value = ''
    }

    try {
      const previousTasks = tasks.value
      const payload = await listTasks()
      const nextTasks = mergeTaskSummariesWithWorkspaceDiff(
        previousTasks,
        (payload.items || []).map(toTaskSummary)
      )
      tasks.value = nextTasks
      syncSendingTaskMapWithTasks(nextTasks)
      if (shouldRefreshWorkspaceDiffSummaries(previousTasks, nextTasks)) {
        refreshTaskWorkspaceDiffSummaries(nextTasks)
      }
    } catch (err) {
      if (!silent) {
        error.value = err.message
      }
    } finally {
      if (!silent) {
        loadingTasks.value = false
      }
    }
  }

  async function reorderTaskList(orderedSlugs = []) {
    const nextTasks = reorderTaskSummaries(tasks.value, orderedSlugs)
    const currentOrder = tasks.value.map((task) => String(task?.slug || '').trim()).filter(Boolean)
    const nextOrder = nextTasks.map((task) => String(task?.slug || '').trim()).filter(Boolean)

    if (!nextOrder.length || nextOrder.join(',') === currentOrder.join(',')) {
      return false
    }

    const previousTasks = tasks.value
    tasks.value = nextTasks

    try {
      const payload = await reorderTasks(nextOrder)
      suppressLocalReorderSseUntil = Date.now() + LOCAL_REORDER_SSE_SUPPRESS_MS
      const mergedTasks = mergeTaskSummariesWithWorkspaceDiff(
        previousTasks,
        (payload.items || []).map(toTaskSummary)
      )
      tasks.value = mergedTasks
      syncSendingTaskMapWithTasks(mergedTasks)
      return true
    } catch (err) {
      tasks.value = previousTasks
      error.value = err.message
      return false
    }
  }

  async function syncTaskStateAfterServerChange(taskSlug = '') {
    const currentSlug = String(currentTaskSlug.value || '').trim()
    const changedTaskSlug = String(taskSlug || '').trim()
    if (!currentSlug) {
      return
    }

    const currentStillExists = tasks.value.some((task) => task.slug === currentSlug)
    if (!currentStillExists) {
      if (tasks.value.length) {
        await loadTask(tasks.value[0].slug, { force: true, skipIfDirtyOnApply: true })
        return
      }

      currentTaskSlug.value = ''
      persistActiveTaskSlug('')
      draft.value = { title: '', autoTitle: '', lastPromptPreview: '', codexSessionId: '', blocks: [], todoItems: [] }
      lastSavedSnapshot.value = createSnapshot('', '', '', [], '', [])
      hasUnsavedChanges.value = false
      return
    }

    if (changedTaskSlug && changedTaskSlug !== currentSlug) {
      return
    }

    if (!changedTaskSlug) {
      return
    }

    if (
      isCurrentTaskEditorEditing()
      || hasPendingDraftChanges()
      || hasUnsavedChanges.value
      || saving.value
      || uploading.value
      || loadingTask.value
    ) {
      return
    }

    await loadTask(currentSlug, {
      force: true,
      skipIfDirtyOnApply: true,
      skipIfEditingOnApply: true,
    })
  }

  function scheduleServerRefresh(taskSlug = '') {
    const nextTaskSlug = String(taskSlug || '').trim()
    if (pendingServerSyncTaskSlug === null) {
      pendingServerSyncTaskSlug = nextTaskSlug
    } else if (pendingServerSyncTaskSlug !== nextTaskSlug) {
      pendingServerSyncTaskSlug = ''
    }

    if (serverSyncTimer) {
      return
    }

    serverSyncTimer = window.setTimeout(async () => {
      const taskSlug = pendingServerSyncTaskSlug
      pendingServerSyncTaskSlug = null
      serverSyncTimer = null

      await refreshTaskList({ silent: true })
      await syncTaskStateAfterServerChange(taskSlug || '')
    }, SERVER_SYNC_DELAY)
  }

  async function hydrateTaskFromServer(slug) {
    const task = await getTask(slug)
    const normalizedBlocks = (task.blocks || []).map((block) => ({
      ...block,
      content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
    }))

    const state = {
      title: String(task.title || ''),
      autoTitle: String(task.autoTitle || ''),
      lastPromptPreview: String(task.lastPromptPreview || ''),
      codexSessionId: String(task.codexSessionId || ''),
      blocks: normalizedBlocks,
      todoItems: cloneTodoItems(task.todoItems || []),
    }

    return {
      state,
      summary: toTaskSummary({
        ...task,
        blocks: normalizedBlocks,
      }),
      updatedAt: String(task.updatedAt || ''),
    }
  }

  async function loadTask(slug, options = {}) {
    const {
      focusEditor = false,
      force = false,
      skipIfDirtyOnApply = false,
      skipIfEditingOnApply = false,
      scrollPanelToBottom = false,
    } = options
    const targetSlug = String(slug || '').trim()
    if (!targetSlug) {
      return false
    }

    const requestId = ++loadRequestId
    loadingTask.value = true
    error.value = ''
    clearToast()

    try {
      const previousTaskSlug = String(currentTaskSlug.value || '').trim()
      const cachedState = getTaskDraftState(targetSlug)
      const canReuseForcedCache = force && cachedState && isTaskHydrationFresh(targetSlug)
      let state = force && !canReuseForcedCache ? null : cachedState
      let summary = null
      if (!state) {
        const hydrated = await hydrateTaskFromServer(targetSlug)
        state = hydrated?.state || null
        summary = hydrated?.summary || null
        markTaskHydrated(targetSlug, hydrated?.updatedAt || summary?.updatedAt || '')
      }

      if (requestId !== loadRequestId) {
        return false
      }

      if (
        skipIfDirtyOnApply
        && targetSlug === currentTaskSlug.value
        && (hasPendingDraftChanges() || hasUnsavedChanges.value)
      ) {
        return false
      }

      if (
        skipIfEditingOnApply
        && targetSlug === currentTaskSlug.value
        && isCurrentTaskEditorEditing()
      ) {
        return false
      }

      currentTaskSlug.value = targetSlug
      persistActiveTaskSlug(targetSlug)
      draft.value = cloneDraftState(state)
      setTaskDraftState(targetSlug, state)
      if (summary) {
        upsertTaskSummary(summary)
      }
      setTaskSelectedSessionId(targetSlug, state.codexSessionId)
      lastSavedSnapshot.value = createSnapshot(
        draft.value.title,
        draft.value.autoTitle,
        draft.value.lastPromptPreview,
        draft.value.todoItems,
        draft.value.codexSessionId,
        draft.value.blocks
      )
      hasUnsavedChanges.value = false

      if (focusEditor) {
        nextTick(() => editorRef.value?.focusEditor?.())
      }
      if (scrollPanelToBottom || targetSlug !== previousTaskSlug) {
        scrollCurrentPanelToBottom()
      }
      return true
    } catch (err) {
      if (requestId === loadRequestId) {
        error.value = err.message
      }
      return false
    } finally {
      if (requestId === loadRequestId) {
        loadingTask.value = false
      }
    }
  }

  async function saveTask(options = {}) {
    const { auto = false, silent = false } = options
    if (!currentTaskSlug.value) {
      return false
    }

    const snapshot = createSnapshot()
    if (snapshot === lastSavedSnapshot.value) {
      return true
    }

    if (savePromise) {
      return savePromise
    }

    clearAutoSaveTimer()
    saving.value = true
    error.value = ''

    savePromise = (async () => {
      try {
        const task = await updateTask(currentTaskSlug.value, {
          title: String(draft.value.title || ''),
          autoTitle: String(draft.value.autoTitle || ''),
          lastPromptPreview: String(draft.value.lastPromptPreview || ''),
          todoItems: cloneTodoItems(draft.value.todoItems),
          codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || draft.value.codexSessionId || ''),
          expiry: 'none',
          visibility: 'private',
          blocks: normalizeBlocksForSave(draft.value.blocks),
        })

        const normalizedState = {
          title: String(task.title || ''),
          autoTitle: String(task.autoTitle || ''),
          lastPromptPreview: String(task.lastPromptPreview || ''),
          todoItems: cloneTodoItems(task.todoItems || draft.value.todoItems || []),
          codexSessionId: String(selectedSessionMap.value[currentTaskSlug.value] || task.codexSessionId || ''),
          blocks: cloneBlocks(draft.value.blocks),
        }
        setTaskDraftState(currentTaskSlug.value, normalizedState)
        lastSavedSnapshot.value = createSnapshot(
          normalizedState.title,
          normalizedState.autoTitle,
          normalizedState.lastPromptPreview,
          normalizedState.todoItems,
          normalizedState.codexSessionId,
          normalizedState.blocks
        )
        hasUnsavedChanges.value = false
        upsertTaskSummary(toTaskSummary(task))
        markTaskHydrated(currentTaskSlug.value, task.updatedAt || '')
        if (!auto && !silent) {
          flashToast({
            message: translate('taskActions.taskSaved'),
            type: 'success',
          })
        }
        return true
      } catch (err) {
        error.value = err.message
        return false
      } finally {
        saving.value = false
        savePromise = null
        if (createSnapshot() !== lastSavedSnapshot.value) {
          hasUnsavedChanges.value = true
          scheduleAutoSave()
        }
      }
    })()

    return savePromise
  }

  async function ensureCurrentTaskReady() {
    if (uploading.value) {
      error.value = translate('taskActions.fileProcessing')
      return false
    }

    if (savePromise) {
      return savePromise
    }

    if (!hasUnsavedChanges.value) {
      return true
    }

    return saveTask({ auto: false, silent: true })
  }

  async function createTaskAndSelect() {
    if (!(await ensureCurrentTaskReady()) && currentTaskSlug.value) {
      return false
    }

    creatingTask.value = true
    error.value = ''

    try {
      const task = await createTask({
        title: '',
        expiry: 'none',
        visibility: 'private',
      })

      const initialState = {
        title: String(task.title || ''),
        autoTitle: String(task.autoTitle || ''),
        lastPromptPreview: String(task.lastPromptPreview || ''),
        codexSessionId: String(task.codexSessionId || ''),
        blocks: cloneBlocks(task.blocks || []),
        todoItems: cloneTodoItems(task.todoItems || []),
      }
      setTaskDraftState(task.slug, initialState)
      upsertTaskSummary(toTaskSummary(task), { insertAtStart: true })
      await loadTask(task.slug, { focusEditor: true })
      flashToast({
        message: translate('taskActions.taskCreated'),
        type: 'success',
      })
      return true
    } catch (err) {
      error.value = err.message
      return false
    } finally {
      creatingTask.value = false
    }
  }

  async function selectTask(slug) {
    const targetSlug = String(slug || '').trim()
    if (!targetSlug || targetSlug === currentTaskSlug.value) {
      return
    }

    const ready = await ensureCurrentTaskReady()
    if (!ready) {
      return
    }

    await loadTask(targetSlug)
  }

  async function removeCurrentTask() {
    if (!currentTaskSlug.value) {
      return
    }

    removingTask.value = true
    error.value = ''

    try {
      const targetSlug = currentTaskSlug.value
      await deleteTask(targetSlug)
      tasks.value = tasks.value.filter((task) => task.slug !== targetSlug)
      clearReviewCommentsForTask(targetSlug)

      const nextDraftMap = { ...taskDraftMap.value }
      delete nextDraftMap[targetSlug]
      taskDraftMap.value = nextDraftMap

      const nextSessionMap = { ...selectedSessionMap.value }
      delete nextSessionMap[targetSlug]
      selectedSessionMap.value = nextSessionMap

      const nextSendingMap = { ...sendingTaskMap.value }
      delete nextSendingMap[targetSlug]
      sendingTaskMap.value = nextSendingMap

      if (tasks.value.length) {
        await loadTask(tasks.value[0].slug, { focusEditor: true })
      } else {
        currentTaskSlug.value = ''
        persistActiveTaskSlug('')
        draft.value = { title: '', autoTitle: '', lastPromptPreview: '', codexSessionId: '', blocks: [], todoItems: [] }
        lastSavedSnapshot.value = createSnapshot('', '', '', [], '', [])
        hasUnsavedChanges.value = false
        await createTaskAndSelect()
      }
    } catch (err) {
      error.value = err.message
    } finally {
      removingTask.value = false
    }
  }

  function clearCurrentTaskContent(options = {}) {
    const { silent = false } = options
    if (!currentTaskSlug.value) {
      return
    }

    draft.value = {
      ...draft.value,
      blocks: createEmptyTextBlocks(),
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    if (!silent) {
      flashToast({
        message: translate('taskActions.taskCleared'),
        type: 'info',
      })
    }
  }

  function addCurrentDraftToTodo() {
    if (!currentTaskSlug.value) {
      return false
    }

    const todoBlocks = normalizeTodoItemBlocks(draft.value.blocks)
    if (!todoBlocks.length) {
      return false
    }

    draft.value = {
      ...draft.value,
      blocks: createEmptyTextBlocks(),
      todoItems: [
        {
          id: createTodoItemId(),
          createdAt: new Date().toISOString(),
          blocks: todoBlocks,
        },
        ...cloneTodoItems(draft.value.todoItems),
      ],
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    flashToast({
      message: translate('taskActions.todoAdded'),
      type: 'success',
    })
    return true
  }

  function removeTodoItem(todoId = '') {
    const normalizedTodoId = String(todoId || '').trim()
    if (!currentTaskSlug.value || !normalizedTodoId) {
      return false
    }

    const nextTodoItems = cloneTodoItems(draft.value.todoItems).filter((item) => item.id !== normalizedTodoId)
    if (nextTodoItems.length === cloneTodoItems(draft.value.todoItems).length) {
      return false
    }

    draft.value = {
      ...draft.value,
      todoItems: nextTodoItems,
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    return true
  }

  function useTodoItem(todoId = '') {
    const normalizedTodoId = String(todoId || '').trim()
    if (!currentTaskSlug.value || !normalizedTodoId) {
      return null
    }

    const targetTodo = cloneTodoItems(draft.value.todoItems).find((item) => item.id === normalizedTodoId)
    if (!targetTodo) {
      return null
    }

    draft.value = {
      ...draft.value,
      blocks: cloneBlocks(targetTodo.blocks),
      todoItems: cloneTodoItems(draft.value.todoItems).filter((item) => item.id !== normalizedTodoId),
    }
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
    hasUnsavedChanges.value = true
    nextTick(() => {
      editorRef.value?.focusEditor?.()
    })
    return targetTodo
  }

  async function initializeWorkbench() {
    await refreshTaskList()
    if (!tasks.value.length) {
      await createTaskAndSelect()
      return
    }

    const requestedSlug = getRequestedTaskSlug()
    if (requestedSlug) {
      const loaded = await loadTask(requestedSlug, { focusEditor: true, force: true })
      clearRequestedTaskSlug()
      if (loaded) {
        return
      }
    }

    const latestRunningTaskSlug = tasks.value.find((task) => Boolean(task?.running))?.slug || ''
    const persistedSlug = getPersistedActiveTaskSlug()
    const initialSlug = latestRunningTaskSlug
      || (tasks.value.some((task) => task.slug === persistedSlug)
        ? persistedSlug
        : tasks.value[0].slug)

    await loadTask(initialSlug, { focusEditor: true, force: true })
  }

  async function handleUpload(files) {
    uploading.value = true
    error.value = ''

    try {
      const insertedAfterImported = editorRef.value?.isImportedBlockActive?.() || false
      const uploadedBlocks = []

      for (const file of files) {
        const asset = await uploadImage(file)
        uploadedBlocks.push({
          type: 'image',
          content: resolveAssetUrl(asset.url),
          meta: {},
        })
      }

      editorRef.value?.insertUploadedBlocks(uploadedBlocks)
      flashToast({
        message: translate('taskActions.imageInserted', {
          count: uploadedBlocks.length,
          appended: insertedAfterImported,
        }),
        type: 'success',
      })
    } catch (err) {
      error.value = err.message
    } finally {
      uploading.value = false
    }
  }

  async function handleImportTextFiles(files) {
    error.value = ''

    try {
      const insertedAfterImported = editorRef.value?.isImportedBlockActive?.() || false
      const importedBlocks = []

      for (const file of files) {
        const text = await file.text()
        if (!text.trim()) {
          continue
        }
        importedBlocks.push({
          type: 'imported_text',
          content: text,
          meta: {
            fileName: file.name || translate('workbench.untitledTask'),
            collapsed: true,
          },
        })
      }

      if (!importedBlocks.length) {
        flashToast({
          message: translate('taskActions.noTextImported'),
          type: 'warning',
        })
        return
      }

      editorRef.value?.insertImportedBlocks(importedBlocks)
      flashToast({
        message: translate('taskActions.importedBlocksInserted', {
          count: importedBlocks.length,
          appended: insertedAfterImported,
        }),
        type: 'success',
      })
    } catch {
      error.value = translate('taskActions.textImportFailed')
    }
  }

  async function handleImportPdfFiles(files) {
    uploading.value = true
    error.value = ''

    try {
      let insertedBlockCount = 0
      let insertedPageCount = 0

      for (const file of files) {
        const payload = await importPdf(file)
        const blocks = (payload.blocks || []).map((block) => ({
          ...block,
          content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
        }))

        if (!blocks.length) {
          continue
        }

        editorRef.value?.insertBlocks(blocks)
        insertedBlockCount += blocks.length
        insertedPageCount += Number(payload.pageCount || 0)
      }

      if (!insertedBlockCount) {
        flashToast({
          message: translate('taskActions.noPdfContent'),
          type: 'warning',
        })
        return
      }

      flashToast({
        message: translate('taskActions.pdfBlocksInserted', {
          blockCount: insertedBlockCount,
          pageCount: insertedPageCount,
        }),
        type: 'success',
      })
    } catch (err) {
      error.value = err.message || translate('taskActions.pdfImportFailed')
    } finally {
      uploading.value = false
    }
  }

  function buildPromptForTask(slug) {
    const state = slug === currentTaskSlug.value
      ? draft.value
      : getTaskDraftState(slug)

    if (!state) {
      return ''
    }

    const reviewCommentBlocks = buildReviewCommentPromptBlocks(getReviewCommentsForTask(slug))

    return buildCodexPrompt({
      title: String(state.title || ''),
      blocks: [
        ...reviewCommentBlocks,
        ...normalizeBlocksForSave(state.blocks || []),
      ],
    }, getTaskRawUrl(slug))
  }

  function getPromptBlocksForTask(slug) {
    const state = slug === currentTaskSlug.value
      ? draft.value
      : getTaskDraftState(slug)

    if (!state) {
      return []
    }

    return cloneBlocks([
      ...buildReviewCommentPromptBlocks(getReviewCommentsForTask(slug)),
      ...normalizeBlocksForSave(state.blocks || []),
    ])
  }

  async function ensureCodexPromptReady(taskSlug) {
    if (uploading.value) {
      error.value = translate('taskActions.fileProcessingBeforeSend')
      return false
    }

    if (taskSlug !== currentTaskSlug.value) {
      return true
    }

    if (saving.value && savePromise) {
      return savePromise
    }

    if (!hasUnsavedChanges.value) {
      return true
    }

    return saveTask({ auto: false, silent: true })
  }

  async function prepareCodexPromptForTask(taskSlug) {
    const ready = await ensureCodexPromptReady(taskSlug)
    if (!ready) {
      return ''
    }

    return buildPromptForTask(taskSlug)
  }

  function updateLastPromptPreview(taskSlug, prompt) {
    const promptPreview = buildPromptPreview(prompt)
    if (!promptPreview || taskSlug !== currentTaskSlug.value) {
      return
    }

    draft.value.lastPromptPreview = promptPreview
    setTaskDraftState(currentTaskSlug.value, draft.value)
    syncDraftSummary()
  }

  watch(
    draft,
    () => {
      if (loadingTask.value || !currentTaskSlug.value) {
        return
      }

      const derivedAutoTitle = deriveAutoTaskTitle(draft.value.blocks)
      if (!String(draft.value.title || '').trim() && derivedAutoTitle && derivedAutoTitle !== draft.value.autoTitle) {
        draft.value.autoTitle = derivedAutoTitle
      }

      setTaskDraftState(currentTaskSlug.value, draft.value)
      hasUnsavedChanges.value = createSnapshot() !== lastSavedSnapshot.value
      syncDraftSummary()
      if (hasUnsavedChanges.value && !saving.value) {
        scheduleAutoSave()
      }
    },
    { deep: true }
  )

  watch(currentTaskSlug, (slug) => {
    if (slug) {
      persistActiveTaskSlug(slug)
    }
  })

  onBeforeUnmount(() => {
    clearAutoSaveTimer()
    clearServerSyncTimer()
  })

  watch(
    () => realtime.listSyncVersion.value,
    () => {
      if (
        realtime.listSyncReason.value === 'reordered'
        && Date.now() < suppressLocalReorderSseUntil
      ) {
        return
      }
      applyTaskRunningStateFromRealtime(realtime.listSyncTaskSlug.value)
      scheduleServerRefresh(realtime.listSyncTaskSlug.value)
    }
  )

  return {
    addReviewCommentToTask,
    addCurrentDraftToTodo,
    applyTaskSettingsUpdate,
    buildPromptForTask,
    getPromptBlocksForTask,
    buildPromptPreview,
    clearCurrentTaskContent,
    clearReviewCommentsForTask,
    createTaskAndSelect,
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
    hasAnyTaskSending,
    hasUnsavedChanges,
    initializeWorkbench,
    isCurrentTaskSending,
    loadingTask,
    loadingTasks,
    pageTitle,
    prepareCodexPromptForTask,
    currentTodoItems,
    removeTodoItem,
    removeCurrentTask,
    reorderTaskList,
    removingTask,
    renderedTasks,
    refreshTaskList,
    removeReviewCommentFromTask,
    saveTask,
    saving,
    selectTask,
    selectedSessionMap,
    sendingTaskMap,
    taskDraftMap,
    tasks,
    useTodoItem,
    updateLastPromptPreview,
    uploading,
    creatingTask,
  }
}
