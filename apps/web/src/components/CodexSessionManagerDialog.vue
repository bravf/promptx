<script setup>
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { normalizeComparablePath } from '../../../../packages/shared/src/index.js'
import {
  ArrowLeft,
  Bot,
  CircleAlert,
  Eye,
  RotateCcw,
  PencilLine,
  Trash2,
} from 'lucide-vue-next'
import { compareByLocale, formatDateTime, useI18n } from '../composables/useI18n.js'
import { useMediaQuery } from '../composables/useMediaQuery.js'
import ConfirmDialog from './ConfirmDialog.vue'
import CodexDirectoryPickerDialog from './CodexDirectoryPickerDialog.vue'
import DialogShell from './DialogShell.vue'
import CodexSessionManagerForm from './CodexSessionManagerForm.vue'
import CodexSessionManagerList from './CodexSessionManagerList.vue'
import CodexSessionManagerStatus from './CodexSessionManagerStatus.vue'
import {
  fetchEnabledAgentEngineOptions,
  getEnabledAgentEngineOptions,
  normalizeAgentEngine,
} from '../lib/agentEngines.js'
import { listAgentSessionCandidates } from '../lib/codexApi.js'

const SESSION_CANDIDATE_CACHE_TTL_MS = 3000
const sessionCandidateCache = new Map()

function getSessionCandidateCacheKey(engine = '', cwd = '') {
  const normalizedEngine = normalizeAgentEngine(engine)
  const normalizedCwd = normalizeComparablePath(cwd)
  if (!normalizedEngine || !normalizedCwd) {
    return ''
  }

  return `${normalizedEngine}\n${normalizedCwd}`
}

function readSessionCandidateCache(key = '') {
  if (!key) {
    return null
  }

  const cached = sessionCandidateCache.get(key)
  if (!cached) {
    return null
  }

  if (cached.expiresAt <= Date.now()) {
    sessionCandidateCache.delete(key)
    return null
  }

  return Array.isArray(cached.items) ? cached.items : []
}

function writeSessionCandidateCache(key = '', items = []) {
  if (!key) {
    return
  }

  sessionCandidateCache.set(key, {
    expiresAt: Date.now() + SESSION_CANDIDATE_CACHE_TTL_MS,
    items: Array.isArray(items) ? items : [],
  })
}

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  sessions: {
    type: Array,
    default: () => [],
  },
  workspaces: {
    type: Array,
    default: () => [],
  },
  selectedSessionId: {
    type: String,
    default: '',
  },
  selectionLocked: {
    type: Boolean,
    default: false,
  },
  selectionLockReason: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  sending: {
    type: Boolean,
    default: false,
  },
  onRefresh: {
    type: Function,
    default: null,
  },
  onCreate: {
    type: Function,
    default: null,
  },
  onUpdate: {
    type: Function,
    default: null,
  },
  onDelete: {
    type: Function,
    default: null,
  },
  onReset: {
    type: Function,
    default: null,
  },
})

const emit = defineEmits(['close', 'project-created', 'select-session', 'open-source-browser'])
const { locale, t } = useI18n()

const mode = ref('edit')
const editingSessionId = ref('')
const form = reactive({
  title: '',
  engine: 'codex',
  agentEngines: [],
  cwd: '',
  sessionId: '',
})
const error = ref('')
const creating = ref(false)
const saving = ref(false)
const deleting = ref(false)
const resetting = ref(false)
const showDeleteDialog = ref(false)
const showResetDialog = ref(false)
const showDirectoryPicker = ref(false)
const threadIdCopied = ref(false)
const { matches: isMobileLayout } = useMediaQuery('(max-width: 767px)')
const mobileView = ref('list')
const mobileDetailTab = ref('basic')
const loadedEngineOptions = ref(getEnabledAgentEngineOptions())
const sessionCandidates = ref([])
const sessionCandidatesLoading = ref(false)
let threadIdCopyTimer = null
let sessionCandidateTimer = null
let sessionCandidateController = null
let sessionCandidateRequestSeq = 0

const sortedSessions = computed(() => sortSessions(props.sessions))
const activeSession = computed(() => props.sessions.find((session) => session.id === editingSessionId.value) || null)
const hasSessions = computed(() => props.sessions.length > 0)
const currentSession = computed(() => props.sessions.find((session) => session.id === props.selectedSessionId) || null)
const activeSessionRunning = computed(() => Boolean(activeSession.value && isSessionRunning(activeSession.value.id)))
const canEditCwd = computed(() => !activeSession.value?.started)
const canEditEngine = computed(() => !activeSession.value?.started)
const canEditSessionId = computed(() => !activeSession.value?.started)
const busy = computed(() => props.loading || creating.value || saving.value || deleting.value || resetting.value)
const activeFormSessionId = computed(() => String(form.sessionId || '').trim())
const workspaceSuggestions = computed(() => {
  const seen = new Set()
  const items = []

  ;[
    form.cwd,
    activeSession.value?.cwd,
    currentSession.value?.cwd,
    ...props.workspaces,
    ...props.sessions.map((session) => session.cwd),
  ].forEach((value) => {
    const normalized = String(value || '').trim()
    if (!normalized || seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    items.push(normalized)
  })

  return items.slice(0, 12)
})
const engineOptions = computed(() => loadedEngineOptions.value)
const decoratedSessionCandidates = computed(() => sessionCandidates.value.map((item) => ({
  ...item,
  updatedAtLabel: item.updatedAt ? formatUpdatedAt(item.updatedAt) : '',
})))
const duplicateCwdSessions = computed(() => {
  const target = normalizeComparablePath(form.cwd)
  if (!target) {
    return []
  }

  return props.sessions.filter((session) => {
    if (session.id === activeSession.value?.id) {
      return false
    }
    return normalizeComparablePath(session.cwd) === target
  })
})
const duplicateCwdMessage = computed(() => {
  if (!duplicateCwdSessions.value.length) {
    return ''
  }

  const labels = duplicateCwdSessions.value
    .slice(0, 3)
    .map((session) => {
      const title = session.title || t('projectManager.untitledProject')
      return locale.value === 'en-US' ? `"${title}"` : `「${title}」`
    })
    .join(locale.value === 'en-US' ? ', ' : '、')
  return t('projectManager.duplicateDirectory', {
    labels,
    count: duplicateCwdSessions.value.length,
  })
})
const cwdReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || canEditCwd.value) {
    return ''
  }

  return t('projectManager.cwdReadonly')
})
const engineReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || !activeSession.value || canEditEngine.value) {
    return ''
  }

  return t('projectManager.engineReadonly')
})
const sessionIdReadonlyMessage = computed(() => {
  if (mode.value !== 'edit' || !activeSession.value || canEditSessionId.value) {
    return ''
  }

  return t('projectManager.sessionIdReadonly')
})
const desktopSubmitLabel = computed(() => (mode.value === 'create'
  ? (creating.value ? t('projectManager.creatingProject') : t('projectManager.createProject'))
  : (saving.value ? t('projectManager.savingChanges') : t('projectManager.saveChanges'))))
const mobileTitle = computed(() => (mode.value === 'create' ? t('projectManager.newProject') : activeSession.value?.title || t('projectManager.untitledProject')))
function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

function isSessionRunning(sessionId) {
  return Boolean(props.sessions.find((session) => session.id === sessionId)?.running)
}

function isCurrentSession(sessionId) {
  return Boolean(sessionId) && sessionId === props.selectedSessionId
}

function sortSessions(items = []) {
  return [...items].sort((left, right) => {
    const runningDiff = Number(isSessionRunning(right.id)) - Number(isSessionRunning(left.id))
    if (runningDiff) {
      return runningDiff
    }

    const currentDiff = Number(isCurrentSession(right.id)) - Number(isCurrentSession(left.id))
    if (currentDiff) {
      return currentDiff
    }

    const updatedDiff = getDateOrderValue(right.updatedAt) - getDateOrderValue(left.updatedAt)
    if (updatedDiff) {
      return updatedDiff
    }

    return compareByLocale(String(left.title || left.cwd || left.id), String(right.title || right.cwd || right.id))
  })
}

function getRuntimeStatusLabel(sessionId) {
  return isSessionRunning(sessionId) ? t('projectManager.running') : t('projectManager.idle')
}

function getRuntimeStatusClass(sessionId) {
  return isSessionRunning(sessionId) ? 'theme-status-warning' : 'theme-status-success'
}

function getThreadStatusLabel(session) {
  return session?.started ? t('projectManager.threadBound') : t('projectManager.notStarted')
}

function getThreadStatusClass(session) {
  return session?.started ? 'theme-status-success' : 'theme-status-neutral'
}

function formatUpdatedAt(value = '') {
  if (!value) {
    return t('projectManager.unknown')
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }

  return formatDateTime(date.toISOString(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function syncFormFromSession(session) {
  form.title = String(session?.title || '')
  form.engine = normalizeAgentEngine(session?.engine)
  form.agentEngines = (Array.isArray(session?.agentBindings) ? session.agentBindings : [])
    .map((item) => normalizeAgentEngine(item?.engine))
    .filter((engine) => engine && engine !== form.engine)
  form.cwd = String(session?.cwd || '')
  form.sessionId = String(
    session?.sessionId
    || session?.engineSessionId
    || session?.engineThreadId
    || session?.codexThreadId
    || ''
  ).trim()
}

function openCreateMode() {
  mode.value = 'create'
  editingSessionId.value = ''
  error.value = ''
  form.title = ''
  form.engine = 'codex'
  form.agentEngines = []
  form.cwd = ''
  form.sessionId = ''
}

function openEditMode(sessionId) {
  const session = props.sessions.find((item) => item.id === sessionId)
  if (!session) {
    return
  }

  mode.value = 'edit'
  editingSessionId.value = session.id
  error.value = ''
  syncFormFromSession(session)
}

function getPreferredSessionId() {
  if (props.selectedSessionId && props.sessions.some((session) => session.id === props.selectedSessionId)) {
    return props.selectedSessionId
  }

  return sortedSessions.value[0]?.id || ''
}

function enterMobileDetail(tab = 'basic') {
  mobileView.value = 'detail'
  mobileDetailTab.value = tab
}

function returnToMobileList() {
  mobileView.value = 'list'
  mobileDetailTab.value = 'basic'
}

function handleCreateIntent() {
  openCreateMode()
  if (isMobileLayout.value) {
    enterMobileDetail('basic')
  }
}

function handleSessionCardClick(sessionId) {
  if (busy.value) {
    return
  }

  openEditMode(sessionId)
  if (isMobileLayout.value) {
    enterMobileDetail('basic')
  }
}

function handleDirectoryPicked(pathValue) {
  form.cwd = String(pathValue || '').trim()
}

async function requestOpenSourceBrowser() {
  const preferredSessionId = activeSession.value?.id || getPreferredSessionId()
  if (!preferredSessionId) {
    return false
  }

  if (!activeSession.value || activeSession.value.id !== preferredSessionId) {
    openEditMode(preferredSessionId)
    await nextTick()
  }

  if (!activeSession.value?.cwd) {
    return false
  }

  if (isMobileLayout.value) {
    enterMobileDetail('basic')
  }

  emit('open-source-browser', activeSession.value)
  emit('close')
  return true
}

function closeTopDialog() {
  if (showDeleteDialog.value) {
    showDeleteDialog.value = false
    return true
  }

  if (showResetDialog.value) {
    showResetDialog.value = false
    return true
  }

  if (showDirectoryPicker.value) {
    showDirectoryPicker.value = false
    return true
  }

  if (props.open) {
    emit('close')
    return true
  }

  return false
}

function updateFormTitle(value) {
  form.title = String(value || '')
}

function updateFormEngine(value) {
  form.engine = normalizeAgentEngine(value)
  form.agentEngines = form.agentEngines.filter((item) => item !== form.engine)
}

function updateFormAgentEngines(value) {
  form.agentEngines = [...new Set(
    (Array.isArray(value) ? value : [])
      .map((item) => normalizeAgentEngine(item))
      .filter((item) => item && item !== form.engine)
  )]
}

function updateFormCwd(value) {
  form.cwd = String(value || '')
}

function updateFormSessionId(value) {
  form.sessionId = String(value || '')
}

function selectSessionCandidate(candidate) {
  form.sessionId = String(candidate?.id || '').trim()
}

function initializeDialog() {
  error.value = ''
  showDeleteDialog.value = false
  showResetDialog.value = false
  threadIdCopied.value = false
  mobileDetailTab.value = 'basic'
  mobileView.value = isMobileLayout.value ? 'list' : 'detail'

  const preferredSessionId = getPreferredSessionId()
  if (preferredSessionId) {
    openEditMode(preferredSessionId)
    return
  }

  openCreateMode()
}

async function handleRefresh() {
  if (busy.value || typeof props.onRefresh !== 'function') {
    return
  }

  error.value = ''

  try {
    await Promise.all([
      props.onRefresh(),
      loadEngineOptions(),
    ])
  } catch (err) {
    error.value = err.message
  }
}

async function loadEngineOptions() {
  try {
    loadedEngineOptions.value = await fetchEnabledAgentEngineOptions()
  } catch {
    loadedEngineOptions.value = getEnabledAgentEngineOptions()
  }
}

function clearSessionCandidateTimer() {
  if (sessionCandidateTimer) {
    clearTimeout(sessionCandidateTimer)
    sessionCandidateTimer = null
  }
}

function abortSessionCandidateRequest() {
  if (sessionCandidateController) {
    sessionCandidateController.abort()
    sessionCandidateController = null
  }
}

async function loadSessionCandidates() {
  const cwd = String(form.cwd || '').trim()
  if (!props.open || !canEditSessionId.value || !cwd) {
    sessionCandidates.value = []
    sessionCandidatesLoading.value = false
    abortSessionCandidateRequest()
    return
  }

  const requestSeq = ++sessionCandidateRequestSeq
  abortSessionCandidateRequest()
  const cacheKey = getSessionCandidateCacheKey(form.engine, cwd)
  const cachedItems = readSessionCandidateCache(cacheKey)
  if (cachedItems) {
    sessionCandidates.value = cachedItems
    sessionCandidatesLoading.value = false
    return
  }

  sessionCandidateController = new AbortController()
  sessionCandidatesLoading.value = true

  try {
    const payload = await listAgentSessionCandidates({
      engine: form.engine,
      cwd,
      limit: 50,
      signal: sessionCandidateController.signal,
    })

    if (requestSeq !== sessionCandidateRequestSeq) {
      return
    }

    const items = Array.isArray(payload?.items) ? payload.items : []
    sessionCandidates.value = items
    writeSessionCandidateCache(cacheKey, items)
  } catch (err) {
    if (err?.name === 'AbortError') {
      return
    }
    if (requestSeq === sessionCandidateRequestSeq) {
      sessionCandidates.value = []
    }
  } finally {
    if (requestSeq === sessionCandidateRequestSeq) {
      sessionCandidatesLoading.value = false
      sessionCandidateController = null
    }
  }
}

function scheduleSessionCandidatesLoad(delay = 250) {
  clearSessionCandidateTimer()
  if (!props.open || !canEditSessionId.value || !String(form.cwd || '').trim()) {
    sessionCandidates.value = []
    sessionCandidatesLoading.value = false
    abortSessionCandidateRequest()
    return
  }

  sessionCandidateTimer = setTimeout(() => {
    sessionCandidateTimer = null
    loadSessionCandidates().catch(() => {})
  }, delay)
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

async function handleCopyThreadId() {
  const value = activeFormSessionId.value
  if (!value) {
    return
  }

  try {
    await copyText(value)
    threadIdCopied.value = true
    if (threadIdCopyTimer) {
      clearTimeout(threadIdCopyTimer)
    }
    threadIdCopyTimer = setTimeout(() => {
      threadIdCopied.value = false
      threadIdCopyTimer = null
    }, 1800)
  } catch (err) {
    error.value = err?.message || t('projectManager.copySessionIdFailed')
  }
}

async function handleSubmit() {
  if (busy.value) {
    return
  }

  error.value = ''

  try {
    const submitAction = createSubmitAction()
    if (!submitAction) {
      return
    }

    await submitSession(submitAction)
  } catch (err) {
    error.value = err.message
  }
}

function createSubmitAction() {
  if (mode.value === 'create') {
    const cwd = String(form.cwd || '').trim()
    if (!cwd) {
      error.value = t('projectManager.directoryRequired')
      return null
    }

    return {
      type: 'create',
      cwd,
      payload: {
        title: form.title,
        engine: form.engine,
        agentEngines: [form.engine, ...form.agentEngines],
        cwd,
        sessionId: String(form.sessionId || '').trim(),
      },
    }
  }

  if (!activeSession.value) {
    error.value = t('projectManager.projectMissing')
    return null
  }

  const payload = {
    title: form.title,
    engine: form.engine,
    agentEngines: [form.engine, ...form.agentEngines],
  }

  if (canEditCwd.value) {
    payload.cwd = form.cwd
  }
  if (canEditSessionId.value) {
    payload.sessionId = String(form.sessionId || '').trim()
  }

  return {
    type: 'update',
    sessionId: activeSession.value.id,
    payload,
  }
}

async function submitSession(submitAction) {
  if (submitAction.type === 'create') {
    creating.value = true
    try {
      const session = await props.onCreate?.(submitAction.payload)
      if (session?.id) {
        openEditMode(session.id)
        emit('select-session', session.id)
        await nextTick()
        emit('project-created', session)
        emit('close')
      }
      return
    } finally {
      creating.value = false
    }
  }

  saving.value = true
  try {
    const session = await props.onUpdate?.(submitAction.sessionId, submitAction.payload)
    if (session?.id) {
      openEditMode(session.id)
    }
  } finally {
    saving.value = false
  }
}

async function handleDelete() {
  if (!activeSession.value || deleting.value) {
    return
  }

  const deletingSessionId = activeSession.value.id
  error.value = ''
  deleting.value = true

  try {
    const result = await props.onDelete?.(deletingSessionId)
    showDeleteDialog.value = false

    const remainingSessions = props.sessions.filter((session) => session.id !== deletingSessionId)
    const nextSessionId = result?.selectedSessionId || sortSessions(remainingSessions)[0]?.id || ''

    emit('select-session', nextSessionId)

    if (nextSessionId) {
      openEditMode(nextSessionId)
      if (isMobileLayout.value) {
        returnToMobileList()
      }
    } else {
      openCreateMode()
      if (isMobileLayout.value) {
        returnToMobileList()
      }
    }
  } catch (err) {
    error.value = err.message
  } finally {
    deleting.value = false
  }
}

async function handleReset() {
  if (!activeSession.value || resetting.value) {
    return
  }

  const resettingSessionId = activeSession.value.id
  error.value = ''
  resetting.value = true

  try {
    const result = await props.onReset?.(resettingSessionId)
    showResetDialog.value = false

    const nextSession = result?.session || props.sessions.find((session) => session.id === resettingSessionId) || null
    if (nextSession?.id) {
      openEditMode(nextSession.id)
    }
  } catch (err) {
    error.value = err.message
  } finally {
    resetting.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      initializeDialog()
      if (typeof props.onRefresh === 'function') {
        handleRefresh().catch(() => {})
      } else {
        loadEngineOptions().catch(() => {})
      }
      return
    }

    showDirectoryPicker.value = false
    showDeleteDialog.value = false
    showResetDialog.value = false
    threadIdCopied.value = false
    error.value = ''
    clearSessionCandidateTimer()
    abortSessionCandidateRequest()
    sessionCandidates.value = []
    sessionCandidatesLoading.value = false
  },
  { immediate: true }
)

watch(
  isMobileLayout,
  (matches) => {
    if (!matches) {
      mobileView.value = 'detail'
    }
  },
  { immediate: true }
)

watch(
  () => props.sessions,
  () => {
    if (!props.open) {
      return
    }

    if (mode.value === 'create') {
      const hasDraft = Boolean(String(form.title || '').trim() || String(form.cwd || '').trim())
        || Boolean(String(form.sessionId || '').trim())
      if (hasDraft) {
        return
      }

      const preferredSessionId = getPreferredSessionId()
      if (preferredSessionId) {
        openEditMode(preferredSessionId)
      }
      return
    }

    if (activeSession.value) {
      syncFormFromSession(activeSession.value)
      return
    }

    const preferredSessionId = getPreferredSessionId()
    if (preferredSessionId) {
      openEditMode(preferredSessionId)
      return
    }

    openCreateMode()
  }
)

watch(
  () => [
    props.open,
    mode.value,
    form.engine,
    form.cwd,
    canEditSessionId.value,
  ].join('\n'),
  () => {
    scheduleSessionCandidatesLoad(250)
  },
  { immediate: true }
)

watch(
  () => activeSession.value?.id || '',
  () => {
    scheduleSessionCandidatesLoad(0)
  }
)

onBeforeUnmount(() => {
  if (threadIdCopyTimer) {
    clearTimeout(threadIdCopyTimer)
    threadIdCopyTimer = null
  }
  clearSessionCandidateTimer()
  abortSessionCandidateRequest()
})

defineExpose({
  closeTopDialog,
})

</script>

<template>
  <ConfirmDialog
    :open="showResetDialog"
    :title="t('projectManager.confirmResetTitle')"
    :description="activeSession
      ? t('projectManager.confirmResetDescription', { title: activeSession.title || t('projectManager.untitledProject') })
      : ''"
    :confirm-text="t('projectManager.confirmReset')"
    :cancel-text="t('projectManager.keep')"
    :loading="resetting"
    @cancel="showResetDialog = false"
    @confirm="handleReset"
  />
  <ConfirmDialog
    :open="showDeleteDialog"
    :title="t('projectManager.confirmDeleteTitle')"
    :description="activeSession
      ? t('projectManager.confirmDeleteDescription', { title: activeSession.title || t('projectManager.untitledProject') })
      : ''"
    :confirm-text="t('projectManager.confirmDelete')"
    :cancel-text="t('projectManager.keep')"
    :loading="deleting"
    danger
    @cancel="showDeleteDialog = false"
    @confirm="handleDelete"
  />
  <CodexDirectoryPickerDialog
    :open="showDirectoryPicker"
    :initial-path="form.cwd"
    :suggestions="workspaceSuggestions"
    @close="showDirectoryPicker = false"
    @select="handleDirectoryPicked"
  />
  <DialogShell
    :open="open"
    panel-class="settings-dialog-panel h-[calc(100dvh-1rem)] max-w-5xl sm:h-[96vh] sm:max-h-[96vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body flex min-h-0 flex-1 overflow-hidden"
    :close-disabled="busy"
    :close-on-backdrop="!busy"
    :close-on-escape="!busy"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <Bot class="h-4 w-4" />
        <span>{{ t('projectManager.managingTitle') }}</span>
      </div>
    </template>

    <div v-if="!isMobileLayout" class="grid min-h-0 flex-1 gap-0 lg:grid-cols-[minmax(0,300px)_minmax(0,1fr)]">
          <aside class="theme-divider theme-muted-panel border-b px-3 py-3 sm:px-4 sm:py-4 lg:border-b-0 lg:border-r">
            <CodexSessionManagerList
              :busy="busy"
              :editing-session-id="editingSessionId"
              :format-updated-at="formatUpdatedAt"
              :get-runtime-status-class="getRuntimeStatusClass"
              :get-runtime-status-label="getRuntimeStatusLabel"
              :get-thread-status-class="getThreadStatusClass"
              :get-thread-status-label="getThreadStatusLabel"
              :has-sessions="hasSessions"
              :is-current-session="isCurrentSession"
              :is-session-running="isSessionRunning"
              :mode="mode"
              :sessions="sortedSessions"
              @create="handleCreateIntent"
              @select="handleSessionCardClick"
            />
          </aside>

          <div class="min-h-0 overflow-y-auto px-4 py-4 sm:px-5">
            <div class="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
                  <PencilLine class="h-4 w-4" />
                  <span>{{ mode === 'create' ? t('projectManager.createTitle') : t('projectManager.editTitle') }}</span>
                </div>
              </div>

            </div>

            <div class="mt-5">
              <CodexSessionManagerForm
                :busy="busy"
                :can-edit-engine="mode !== 'edit' || canEditEngine"
                :can-edit-cwd="mode !== 'edit' || canEditCwd"
                :can-edit-session-id="mode !== 'edit' || canEditSessionId"
                :cwd="form.cwd"
                :cwd-readonly-message="cwdReadonlyMessage"
                :duplicate-cwd-message="duplicateCwdMessage"
                :engine="form.engine"
                :agent-engines="form.agentEngines"
                :engine-options="engineOptions"
                :engine-readonly-message="engineReadonlyMessage"
                :session-candidates="decoratedSessionCandidates"
                :session-candidates-loading="sessionCandidatesLoading"
                :session-id="form.sessionId"
                :session-id-copied="threadIdCopied"
                :session-id-readonly-message="sessionIdReadonlyMessage"
                :title="form.title"
                :workspace-suggestions="workspaceSuggestions"
                @copy-session-id="handleCopyThreadId"
                @open-directory-picker="showDirectoryPicker = true"
                @select-session-candidate="selectSessionCandidate"
                @update:cwd="updateFormCwd"
                @update:engine="updateFormEngine"
                @update:agent-engines="updateFormAgentEngines"
                @update:session-id="updateFormSessionId"
                @update:title="updateFormTitle"
              />
            </div>

            <p v-if="error" class="theme-danger-text mt-4 inline-flex items-center gap-2 text-sm">
              <CircleAlert class="h-4 w-4" />
              <span>{{ error }}</span>
            </p>

            <div class="theme-divider mt-6 flex flex-col gap-3 border-t border-dashed pt-4 sm:flex-row sm:items-center sm:justify-between">
              <div class="flex flex-wrap items-center gap-2">
                <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                  :disabled="busy || !activeSession?.cwd"
                  @click="requestOpenSourceBrowser"
                >
                  <Eye class="h-4 w-4" />
                  <span>{{ t('projectManager.viewSource') }}</span>
                </button>
                <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                  :disabled="busy || activeSessionRunning"
                  @click="showResetDialog = true"
                >
                  <RotateCcw class="h-4 w-4" />
                  <span>{{ resetting ? t('projectManager.resettingSession') : t('projectManager.newSession') }}</span>
                </button>
                <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button tool-button-danger-subtle inline-flex items-center gap-2 px-3 py-2 text-xs"
                  :disabled="busy || activeSessionRunning"
                  @click="showDeleteDialog = true"
                >
                  <Trash2 class="h-4 w-4" />
                  <span>{{ deleting ? t('projectManager.deletingProject') : t('projectManager.deleteProject') }}</span>
                </button>
              </div>

              <div class="flex flex-col-reverse gap-2 sm:flex-row sm:flex-wrap sm:items-center">
                <button
                  type="button"
                  class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="emit('close')"
                >
                  {{ t('projectManager.close') }}
                </button>
                <button
                  v-if="mode === 'create' && hasSessions"
                  type="button"
                  class="tool-button w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="initializeDialog"
                >
                  {{ t('projectManager.backToList') }}
                </button>
                <button
                  type="button"
                  class="tool-button tool-button-primary w-full px-3 py-2 text-xs sm:w-auto"
                  :disabled="busy"
                  @click="handleSubmit"
                >
                  {{ desktopSubmitLabel }}
                </button>
              </div>
            </div>
          </div>
    </div>

    <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div v-if="mobileView === 'list'" class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div class="min-h-0 flex-1 overflow-hidden px-3 py-3">
              <CodexSessionManagerList
                mobile
                :busy="busy"
                :editing-session-id="editingSessionId"
                :format-updated-at="formatUpdatedAt"
                :get-runtime-status-class="getRuntimeStatusClass"
                :get-runtime-status-label="getRuntimeStatusLabel"
                :get-thread-status-class="getThreadStatusClass"
                :get-thread-status-label="getThreadStatusLabel"
                :has-sessions="hasSessions"
                :is-current-session="isCurrentSession"
                :is-session-running="isSessionRunning"
                :mode="mode"
                :sessions="sortedSessions"
                @create="handleCreateIntent"
                @select="handleSessionCardClick"
              />
            </div>
          </div>

          <div v-else class="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div class="theme-divider flex items-center gap-3 border-b px-4 py-3">
              <button
                type="button"
                class="tool-button inline-flex items-center gap-1.5 px-3 py-2 text-xs"
                :disabled="busy"
                @click="returnToMobileList"
              >
                <ArrowLeft class="h-4 w-4" />
                <span>{{ t('projectManager.projectList') }}</span>
              </button>
              <div class="min-w-0 flex-1">
                <div class="theme-heading truncate text-sm font-medium">
                  {{ mobileTitle }}
                </div>
                <p v-if="mode === 'edit' && activeSession?.cwd" class="theme-muted-text mt-1 truncate text-xs">
                  {{ activeSession.cwd }}
                </p>
              </div>
            </div>

            <div class="theme-divider border-b px-4 py-3">
              <div class="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  class="tool-button px-3 py-2 text-sm"
                  :class="mobileDetailTab === 'basic' ? 'tool-button-accent-subtle' : ''"
                  @click="mobileDetailTab = 'basic'"
                >
                  {{ t('projectManager.basicInfo') }}
                </button>
                <button
                  type="button"
                  class="tool-button px-3 py-2 text-sm"
                  :class="mobileDetailTab === 'status' ? 'tool-button-accent-subtle' : ''"
                  :disabled="mode === 'create'"
                  @click="mobileDetailTab = 'status'"
                >
                  {{ t('projectManager.status') }}
                </button>
              </div>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
              <div v-if="mobileDetailTab === 'basic'">
                <CodexSessionManagerForm
                  mobile
                  :busy="busy"
                  :can-edit-engine="mode !== 'edit' || canEditEngine"
                  :can-edit-cwd="mode !== 'edit' || canEditCwd"
                  :can-edit-session-id="mode !== 'edit' || canEditSessionId"
                  :cwd="form.cwd"
                  :cwd-readonly-message="cwdReadonlyMessage"
                  :duplicate-cwd-message="duplicateCwdMessage"
                  :engine="form.engine"
                  :agent-engines="form.agentEngines"
                  :engine-options="engineOptions"
                  :engine-readonly-message="engineReadonlyMessage"
                  :session-candidates="decoratedSessionCandidates"
                  :session-candidates-loading="sessionCandidatesLoading"
                  :session-id="form.sessionId"
                  :session-id-copied="threadIdCopied"
                  :session-id-readonly-message="sessionIdReadonlyMessage"
                  :title="form.title"
                  :workspace-suggestions="workspaceSuggestions"
                  @copy-session-id="handleCopyThreadId"
                  @open-directory-picker="showDirectoryPicker = true"
                  @select-session-candidate="selectSessionCandidate"
                  @update:cwd="updateFormCwd"
                  @update:engine="updateFormEngine"
                  @update:agent-engines="updateFormAgentEngines"
                  @update:session-id="updateFormSessionId"
                  @update:title="updateFormTitle"
                />

                <p v-if="error" class="theme-danger-text mt-4 inline-flex items-center gap-2 text-sm">
                  <CircleAlert class="h-4 w-4" />
                  <span>{{ error }}</span>
                </p>

                <div class="theme-divider mt-6 flex flex-col gap-3 border-t border-dashed pt-4">
                  <button
                    type="button"
                    class="tool-button tool-button-primary w-full px-3 py-2 text-sm"
                    :disabled="busy"
                    @click="handleSubmit"
                  >
                    {{ desktopSubmitLabel }}
                  </button>
                  <button
                  v-if="mode === 'edit' && activeSession"
                  type="button"
                  class="tool-button w-full px-3 py-2 text-sm"
                  :disabled="busy || !activeSession?.cwd"
                    @click="requestOpenSourceBrowser"
                  >
                    {{ t('projectManager.viewSource') }}
                  </button>
                  <button
                    v-if="mode === 'edit' && activeSession"
                    type="button"
                    class="tool-button w-full px-3 py-2 text-sm"
                    :disabled="busy || activeSessionRunning"
                    @click="showResetDialog = true"
                  >
                    {{ resetting ? t('projectManager.resettingSession') : t('projectManager.newSession') }}
                  </button>
                  <button
                    v-if="mode === 'edit' && activeSession"
                    type="button"
                    class="tool-button tool-button-danger-subtle w-full px-3 py-2 text-sm"
                    :disabled="busy || activeSessionRunning"
                    @click="showDeleteDialog = true"
                  >
                    {{ deleting ? t('projectManager.deletingProject') : t('projectManager.deleteProject') }}
                  </button>
                </div>
              </div>

              <CodexSessionManagerStatus
                v-else
                :active-session="activeSession"
                :format-updated-at="formatUpdatedAt"
                :get-runtime-status-class="getRuntimeStatusClass"
                :get-runtime-status-label="getRuntimeStatusLabel"
                :get-thread-status-class="getThreadStatusClass"
                :get-thread-status-label="getThreadStatusLabel"
                :is-current-session="isCurrentSession"
                :is-session-running="isSessionRunning"
              />
            </div>
          </div>
    </div>
  </DialogShell>
</template>
