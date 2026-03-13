<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  ArrowLeft,
  CircleAlert,
  Copy,
  SendHorizontal,
  Square,
  SquarePen,
  WandSparkles,
  Upload,
} from 'lucide-vue-next'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import { deriveTitleFromBlocks } from '@promptx/shared'
import BlockEditor from '../components/BlockEditor.vue'
import CodexSessionPanel from '../components/CodexSessionPanel.vue'
import ConfirmDialog from '../components/ConfirmDialog.vue'
import TopToast from '../components/TopToast.vue'
import { useToast } from '../composables/useToast.js'
import {
  deleteDocument,
  getApiBase,
  getDocument,
  importPdf,
  resolveAssetUrl,
  updateDocument,
  uploadImage,
} from '../lib/api.js'
import { buildCodexPrompt } from '../lib/codex.js'

const route = useRoute()
const router = useRouter()
const slug = computed(() => route.params.slug)
const draft = ref({
  title: '',
  blocks: [],
})
const loading = ref(true)
const removing = ref(false)
const saving = ref(false)
const uploading = ref(false)
const error = ref('')
const hasUnsavedChanges = ref(false)
const showClearDialog = ref(false)
const showDeleteDialog = ref(false)
const showLeaveDialog = ref(false)
const lastSavedSnapshot = ref('')
const editorRef = ref(null)
const codexPanelRef = ref(null)
const codexSending = ref(false)
const { toastMessage, flashToast, clearToast } = useToast()
let autoSaveTimer = null
let loadRequestId = 0
let pendingLeaveResolver = null
let bypassLeaveConfirm = false

const apiBase = getApiBase()
const rawUrl = computed(() => `${apiBase}/p/${slug.value}/raw`)
const displayTitle = computed(() => draft.value.title || deriveTitleFromBlocks(draft.value.blocks) || '未命名文档')
const shouldPromptOnLeave = computed(() => {
  if (bypassLeaveConfirm || loading.value) {
    return false
  }
  return true
})
const leaveDescription = computed(() => {
  if (uploading.value) {
    return '文件仍在处理中，现在离开可能中断这次上传或导入。'
  }
  if (saving.value) {
    return '内容正在保存中，现在离开可能来不及把最新修改同步到服务器。'
  }
  if (hasUnsavedChanges.value) {
    return '现在离开将丢失尚未同步的修改。'
  }
  if (codexSending.value) {
    return 'Codex 仍在处理当前内容，现在离开后这轮进度将不会继续显示。'
  }
  return '确认离开当前编辑页？你之后仍可以从首页最近文档重新进入。'
})

function normalizeImageContent(content = '') {
  if (!content || !content.startsWith(apiBase)) {
    return content
  }
  return content.slice(apiBase.length)
}

function normalizeBlocksForSave(blocks) {
  return blocks.map((block) => ({
    ...block,
    content: block.type === 'image' ? normalizeImageContent(block.content) : block.content,
  }))
}

function createSnapshot() {
  return JSON.stringify({
    title: draft.value.title,
    blocks: normalizeBlocksForSave(draft.value.blocks),
  })
}

function clearAutoSaveTimer() {
  if (autoSaveTimer) {
    window.clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
}

function scheduleAutoSave() {
  clearAutoSaveTimer()
  if (loading.value) {
    return
  }
  autoSaveTimer = window.setTimeout(() => {
    saveDocument({ auto: true })
  }, 1500)
}

async function loadDocument() {
  const requestId = ++loadRequestId
  loading.value = true
  error.value = ''
  clearToast()

  try {
    const document = await getDocument(slug.value)
    if (requestId !== loadRequestId) {
      return
    }
    draft.value = {
      title: document.title,
      blocks: document.blocks.map((block) => ({
        ...block,
        content: block.type === 'image' ? resolveAssetUrl(block.content) : block.content,
      })),
    }
    lastSavedSnapshot.value = createSnapshot()
    hasUnsavedChanges.value = false
  } catch (err) {
    if (requestId !== loadRequestId) {
      return
    }
    error.value = err.message
  } finally {
    if (requestId === loadRequestId) {
      loading.value = false
    }
  }
}

async function saveDocument(options = { auto: false }) {
  const snapshot = createSnapshot()
  if (snapshot === lastSavedSnapshot.value) {
    return true
  }

  clearAutoSaveTimer()
  saving.value = true
  error.value = ''

  try {
    await updateDocument(slug.value, {
      title: draft.value.title,
      expiry: '24h',
      visibility: 'listed',
      blocks: normalizeBlocksForSave(draft.value.blocks),
    })
    lastSavedSnapshot.value = snapshot
    hasUnsavedChanges.value = false
    if (!options.auto) {
      flashToast('已保存')
    }
    return true
  } catch (err) {
    error.value = err.message
    return false
  } finally {
    saving.value = false
    if (createSnapshot() !== lastSavedSnapshot.value) {
      hasUnsavedChanges.value = true
      scheduleAutoSave()
    }
  }
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
    flashToast(insertedAfterImported
      ? `已把 ${uploadedBlocks.length} 张图片插入到当前导入块后方，稍后会自动保存`
      : `已插入 ${uploadedBlocks.length} 张图片，稍后会自动保存`)
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
          fileName: file.name || '未命名文件',
          collapsed: true,
        },
      })
    }

    if (!importedBlocks.length) {
      flashToast('没有读取到可插入的文本内容')
      return
    }

    editorRef.value?.insertImportedBlocks(importedBlocks)
    flashToast(insertedAfterImported
      ? `已把 ${importedBlocks.length} 个文件块插入到当前导入块后方，稍后会自动保存`
      : `已插入 ${importedBlocks.length} 个文件块，稍后会自动保存`)
  } catch (err) {
    error.value = '文件读取失败，请确认使用 UTF-8 编码的 .md 或 .txt 文件。'
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
      flashToast('没有从 PDF 中解析出可插入内容')
      return
    }

    flashToast(`已插入 ${insertedBlockCount} 个图文块${insertedPageCount ? `，共 ${insertedPageCount} 页` : ''}，稍后会自动保存`)
  } catch (err) {
    error.value = err.message || 'PDF 解析失败，请确认文件不是扫描件，并且内容为单栏图文。'
  } finally {
    uploading.value = false
  }
}

async function copyCodexPrompt() {
  await navigator.clipboard.writeText(buildCurrentCodexPrompt())
  flashToast('已复制给 Codex')
}

function buildCurrentCodexPrompt() {
  return buildCodexPrompt({
    title: draft.value.title,
    blocks: normalizeBlocksForSave(draft.value.blocks),
  }, rawUrl.value)
}

async function ensureCodexPromptReady() {
  if (uploading.value) {
    error.value = '文件仍在处理中，请稍后再发送给 Codex。'
    return false
  }
  if (saving.value) {
    error.value = '文档正在保存中，请稍后再发送给 Codex。'
    return false
  }
  if (!hasUnsavedChanges.value) {
    return true
  }
  return saveDocument({ auto: false })
}

async function prepareCodexPrompt() {
  const ready = await ensureCodexPromptReady()
  if (!ready) {
    return ''
  }
  return buildCurrentCodexPrompt()
}

async function sendToCodex() {
  const started = await codexPanelRef.value?.send?.()
  if (started) {
    editorRef.value?.clearDocument()
  }
}

function stopCodex() {
  codexPanelRef.value?.stop?.()
}

function openDeleteDialog() {
  showDeleteDialog.value = true
}

function closeDeleteDialog() {
  if (removing.value) {
    return
  }
  showDeleteDialog.value = false
}

async function removeDocument() {
  removing.value = true
  try {
    await deleteDocument(slug.value)
    showDeleteDialog.value = false
    bypassLeaveConfirm = true
    router.push('/')
  } catch (err) {
    error.value = err.message
  } finally {
    removing.value = false
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
  if (!editorRef.value) {
    return
  }
  editorRef.value?.clearDocument()
  flashToast('已清空正文内容，稍后会自动保存')
}

function requestLeaveConfirmation() {
  if (bypassLeaveConfirm) {
    bypassLeaveConfirm = false
    return true
  }

  if (!shouldPromptOnLeave.value) {
    return true
  }

  if (pendingLeaveResolver) {
    return false
  }

  showLeaveDialog.value = true
  return new Promise((resolve) => {
    pendingLeaveResolver = resolve
  })
}

function resolveLeaveConfirmation(confirmed) {
  showLeaveDialog.value = false
  if (!pendingLeaveResolver) {
    return
  }
  const resolve = pendingLeaveResolver
  pendingLeaveResolver = null
  if (confirmed) {
    bypassLeaveConfirm = true
  }
  resolve(confirmed)
}

watch(
  draft,
  () => {
    if (loading.value) {
      return
    }
    hasUnsavedChanges.value = createSnapshot() !== lastSavedSnapshot.value
    if (hasUnsavedChanges.value && !saving.value) {
      scheduleAutoSave()
    }
  },
  { deep: true }
)

function handleBeforeUnload(event) {
  if (!shouldPromptOnLeave.value) {
    return
  }
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
    saveDocument()
    return
  }

  if (event.shiftKey && event.key === 'Backspace') {
    event.preventDefault()
    openClearDialog()
  }
}

onBeforeRouteLeave(() => requestLeaveConfirmation())

onBeforeRouteUpdate(() => requestLeaveConfirmation())

onMounted(() => {
  loadDocument()
  window.addEventListener('beforeunload', handleBeforeUnload)
  window.addEventListener('keydown', handleWindowKeydown)
})

watch(slug, () => {
  clearAutoSaveTimer()
  loadDocument()
})

onBeforeUnmount(() => {
  if (pendingLeaveResolver) {
    pendingLeaveResolver(false)
    pendingLeaveResolver = null
  }
  clearAutoSaveTimer()
  window.removeEventListener('beforeunload', handleBeforeUnload)
  window.removeEventListener('keydown', handleWindowKeydown)
})
</script>

<template>
  <div class="flex h-full min-h-0 flex-col gap-4 overflow-hidden">
    <TopToast :message="toastMessage" />
    <ConfirmDialog
      :open="showClearDialog"
      title="确认清空正文？"
      description="将清空正文内容，但会保留标题。"
      confirm-text="确认清空"
      cancel-text="先保留"
      @cancel="closeClearDialog"
      @confirm="clearAllContent"
    />
    <ConfirmDialog
      :open="showDeleteDialog"
      title="确认删除文档？"
      :description="`将删除「${displayTitle}」，删除后无法恢复。`"
      confirm-text="确认删除"
      cancel-text="先保留"
      :loading="removing"
      danger
      @cancel="closeDeleteDialog"
      @confirm="removeDocument"
    />
    <ConfirmDialog
      :open="showLeaveDialog"
      title="确认离开编辑页？"
      :description="leaveDescription"
      confirm-text="确认离开"
      cancel-text="继续编辑"
      :danger="hasUnsavedChanges || saving || uploading"
      @cancel="resolveLeaveConfirmation(false)"
      @confirm="resolveLeaveConfirmation(true)"
    />

    <section v-if="loading" class="panel p-5 text-sm text-stone-600 dark:text-stone-400">正在加载文档...</section>

    <template v-else>
      <section class="panel p-2.5">
        <div class="flex flex-wrap items-center gap-2.5">
          <RouterLink to="/" class="inline-flex shrink-0 items-center gap-2 text-sm text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100">
            <ArrowLeft class="h-4 w-4" />
            <span>返回首页</span>
          </RouterLink>

          <div class="flex min-w-0 flex-1 items-center gap-2">
            <span class="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm border border-dashed border-stone-300 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200">
              <SquarePen class="h-3.5 w-3.5" />
            </span>
            <input
              v-model="draft.title"
              class="min-w-0 flex-1 border-0 bg-transparent p-0 text-lg font-semibold text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-600 sm:text-xl"
              :placeholder="displayTitle"
            />
          </div>

          <div v-if="error" class="inline-flex min-w-0 items-center gap-2 text-sm text-red-700 dark:text-red-300">
            <CircleAlert class="h-4 w-4 shrink-0" />
            <span class="truncate">{{ error }}</span>
          </div>
        </div>
      </section>

      <div class="grid min-h-0 flex-1 grid-rows-2 gap-4 overflow-hidden lg:grid-cols-2 lg:grid-rows-1">
        <div class="min-h-0 min-w-0 overflow-hidden">
          <CodexSessionPanel
            ref="codexPanelRef"
            :build-prompt="prepareCodexPrompt"
            storage-key="promptx:codex-session-id"
            @sending-change="codexSending = $event"
          />
        </div>

        <div class="min-h-0 min-w-0">
          <BlockEditor
            ref="editorRef"
            v-model="draft.blocks"
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
                v-if="!codexSending"
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
    </template>
  </div>
</template>
