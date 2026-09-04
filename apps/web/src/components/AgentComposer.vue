<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { Brain, ChevronDown, CircleStop, FileText, LoaderCircle, Paperclip, RotateCcw, Send, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'

const MAX_FILE_SIZE = 50 * 1024 * 1024
const MAX_ATTACHMENTS = 10
const IMAGE_MIME_TYPES = new Set(['image/gif', 'image/jpeg', 'image/png', 'image/webp'])

const props = defineProps({
  workspaceId: { type: String, required: true },
  running: { type: Boolean, default: false },
  sending: { type: Boolean, default: false },
  control: { type: Object, default: null },
  settingsLoading: { type: Boolean, default: false },
  onSubmit: { type: Function, required: true },
  onSettingsChange: { type: Function, required: true },
  draftContent: { type: Array, default: () => [] },
})

const emit = defineEmits(['cancel', 'draft-change'])
const textarea = ref(null)
const fileInput = ref(null)
const text = ref('')
const attachments = ref([])
const submitting = ref(false)
const dragging = ref(false)
const preview = ref(null)

const uploading = computed(() => attachments.value.some((item) => item.status === 'uploading'))
const sendDisabled = computed(() => {
  const hasContent = Boolean(text.value.trim()) || attachments.value.some((item) => item.status === 'ready')
  return !hasContent || uploading.value || submitting.value || props.sending || props.running
})
const contextUsage = computed(() => props.control?.contextUsage || null)
const contextPercentage = computed(() => Math.max(0, Math.min(100, Number(contextUsage.value?.percentage || 0))))
const contextCircumference = 2 * Math.PI * 6
const contextProgressStyle = computed(() => ({
  strokeDasharray: contextCircumference,
  strokeDashoffset: contextCircumference * (1 - contextPercentage.value / 100),
}))
const contextUsageTone = computed(() => {
  if (contextPercentage.value > 90) return 'context-progress-danger'
  if (contextPercentage.value >= 70) return 'context-progress-warning'
  return 'context-progress-normal'
})
const contextUsageTitle = computed(() => contextUsage.value
  ? `上下文：已使用 ${Math.round(contextPercentage.value)}%（${contextUsage.value.usedTokens.toLocaleString()} / ${contextUsage.value.maxTokens.toLocaleString()} tokens）`
  : '发送消息后显示上下文用量')

function formatBytes(value) {
  const size = Number(value || 0)
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

async function changeSetting(event, key) {
  const element = event.currentTarget
  await props.onSettingsChange({ [key]: element.value })
  await nextTick()
  element.value = props.control?.[key === 'modelId' ? 'currentModelId' : 'currentReasoningEffort'] || ''
}

function resizeTextarea() {
  const element = textarea.value
  if (!element) return
  element.style.height = 'auto'
  const maxHeight = Math.max(160, window.innerHeight * 0.5)
  element.style.height = `${Math.min(element.scrollHeight, maxHeight)}px`
  element.style.overflowY = element.scrollHeight > maxHeight ? 'auto' : 'hidden'
}

function releaseAttachment(item) {
  item.controller?.abort()
  if (item.objectUrl) URL.revokeObjectURL(item.objectUrl)
}

function draftSnapshot() {
  const content = []
  if (text.value) content.push({ type: 'text', text: text.value })
  for (const item of attachments.value) {
    if (item.status !== 'ready' || !item.asset) continue
    content.push({
      type: IMAGE_MIME_TYPES.has(item.asset.mimeType) ? 'image' : 'file',
      assetId: item.asset.id,
      mimeType: item.asset.mimeType,
      name: item.asset.name,
      size: item.asset.size,
    })
  }
  return content
}

function emitDraftChange() {
  emit('draft-change', draftSnapshot())
}

function restoreDraft(content = []) {
  if (!Array.isArray(content)) return
  const textBlock = content.find((item) => item.type === 'text')
  text.value = textBlock?.text || ''
  attachments.value = content
    .filter((item) => ['image', 'file'].includes(item.type) && item.assetId)
    .map((item) => ({
      localId: `draft:${item.assetId}`,
      file: { name: item.name, size: item.size, type: item.mimeType },
      objectUrl: '',
      status: 'ready',
      error: '',
      asset: item,
      controller: null,
    }))
  nextTick(resizeTextarea)
}

function removeAttachment(item) {
  releaseAttachment(item)
  attachments.value = attachments.value.filter((entry) => entry.localId !== item.localId)
  emitDraftChange()
}

async function uploadAttachment(item) {
  item.controller?.abort()
  const controller = new AbortController()
  item.controller = controller
  item.status = 'uploading'
  item.error = ''
  try {
    const result = await v2Api.uploadAsset(props.workspaceId, item.file, { signal: controller.signal })
    if (item.controller !== controller) return
    item.asset = result.asset
    item.status = 'ready'
    emitDraftChange()
  } catch (cause) {
    if (cause.name === 'AbortError' || item.controller !== controller) return
    item.status = 'error'
    item.error = cause.message
    emitDraftChange()
  } finally {
    if (item.controller === controller) item.controller = null
  }
}

function addFiles(fileList) {
  const files = [...(fileList || [])]
  const room = Math.max(0, MAX_ATTACHMENTS - attachments.value.length)
  for (const file of files.slice(0, room)) {
    const item = reactive({
      localId: crypto.randomUUID(),
      file,
      objectUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : '',
      status: file.size > MAX_FILE_SIZE ? 'error' : 'uploading',
      error: file.size > MAX_FILE_SIZE ? '附件不能超过 50 MB。' : '',
      asset: null,
      controller: null,
    })
    attachments.value.push(item)
    if (item.status === 'uploading') uploadAttachment(item)
  }
}

function chooseFiles() {
  fileInput.value?.click()
}

function handleFileInput(event) {
  addFiles(event.target.files)
  event.target.value = ''
}

function handlePaste(event) {
  const files = [...(event.clipboardData?.files || [])]
  if (!files.length) return
  event.preventDefault()
  addFiles(files)
}

function handleDrop(event) {
  dragging.value = false
  const files = [...(event.dataTransfer?.files || [])]
  if (files.length) addFiles(files)
}

function handleKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    submit()
  }
}

async function submit() {
  if (sendDisabled.value) return
  const submittedText = text.value.trim()
  const submittedAttachments = [...attachments.value]
  const content = [
    ...(submittedText ? [{ type: 'text', text: submittedText }] : []),
    ...submittedAttachments.filter((item) => item.status === 'ready').map((item) => ({
      type: IMAGE_MIME_TYPES.has(item.asset.mimeType) ? 'image' : 'file',
      assetId: item.asset.id,
      mimeType: item.asset.mimeType,
      name: item.asset.name,
      size: item.asset.size,
    })),
  ]

  submitting.value = true
  text.value = ''
  attachments.value = []
  await nextTick()
  resizeTextarea()
  try {
    await props.onSubmit(content)
    submittedAttachments.forEach(releaseAttachment)
  } catch {
    if (!text.value && !attachments.value.length) {
      text.value = submittedText
      attachments.value = submittedAttachments
      await nextTick()
      resizeTextarea()
    } else {
      submittedAttachments.forEach(releaseAttachment)
    }
  } finally {
    submitting.value = false
  }
}

function clearDraft() {
  attachments.value.forEach(releaseAttachment)
  attachments.value = []
  text.value = ''
  preview.value = null
  nextTick(resizeTextarea)
}

watch(text, () => {
  nextTick(resizeTextarea)
  emitDraftChange()
})
watch(() => props.draftContent, (content) => {
  if (!text.value && !attachments.value.length && content?.length) restoreDraft(content)
}, { deep: true, immediate: true })
watch(() => props.workspaceId, clearDraft)

onMounted(() => {
  resizeTextarea()
  window.addEventListener('resize', resizeTextarea)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', resizeTextarea)
  attachments.value.forEach(releaseAttachment)
})
</script>

<template>
  <div
    class="composer mx-auto max-w-3xl rounded-sm"
    :class="dragging ? 'composer-dragging' : ''"
    @dragenter.prevent="dragging = true"
    @dragover.prevent="dragging = true"
    @dragleave.self="dragging = false"
    @drop.prevent="handleDrop"
  >
    <div v-if="attachments.length" class="attachment-list flex gap-2 overflow-x-auto p-2">
      <div v-for="item in attachments" :key="item.localId" class="attachment-pill relative flex h-14 min-w-0 max-w-56 shrink-0 items-center gap-2 rounded-sm p-1.5 pr-8">
        <button v-if="item.objectUrl" type="button" class="attachment-preview h-10 w-10 shrink-0 overflow-hidden rounded-sm" title="预览图片" @click="preview = item">
          <img :src="item.objectUrl" :alt="item.file.name" class="h-full w-full object-cover" />
        </button>
        <div v-else class="attachment-file flex h-10 w-10 shrink-0 items-center justify-center rounded-sm"><FileText class="h-4 w-4" /></div>
        <div class="min-w-0">
          <div class="truncate text-xs font-medium">{{ item.file.name }}</div>
          <div v-if="item.status === 'error'" class="attachment-error truncate text-[10px]" :title="item.error">{{ item.error }}</div>
          <div v-else class="theme-muted-text flex items-center gap-1 text-[10px]">
            <LoaderCircle v-if="item.status === 'uploading'" class="h-3 w-3 animate-spin" />
            <span>{{ item.status === 'uploading' ? '上传中' : formatBytes(item.asset?.size || item.file.size) }}</span>
          </div>
        </div>
        <button v-if="item.status === 'error' && item.file.size <= MAX_FILE_SIZE" type="button" class="attachment-action round-icon-button absolute right-1 top-1 h-6 w-6" title="重试" @click="uploadAttachment(item)"><RotateCcw class="h-3 w-3" /></button>
        <button type="button" class="attachment-action round-icon-button absolute bottom-1 right-1 h-6 w-6" title="移除附件" @click="removeAttachment(item)"><X class="h-3 w-3" /></button>
      </div>
    </div>

    <textarea
      ref="textarea"
      v-model="text"
      class="composer-input block w-full resize-none bg-transparent px-3 pb-1 pt-3 text-sm leading-6 outline-none"
      rows="1"
      placeholder="向 Agent 发送消息"
      @keydown="handleKeydown"
      @paste="handlePaste"
    />

    <div class="composer-toolbar flex min-h-11 flex-wrap items-center justify-between gap-2 px-2 pb-2 pt-1">
      <div class="composer-controls flex min-w-0 flex-1 items-center gap-1">
        <input ref="fileInput" class="hidden" type="file" multiple @change="handleFileInput" />
        <button type="button" class="composer-control-button h-7 w-7" title="添加图片或文件" :disabled="running || attachments.length >= MAX_ATTACHMENTS" @click="chooseFiles"><Paperclip class="h-4 w-4" /></button>
        <span v-if="dragging" class="theme-muted-text text-[10px]">松开以添加附件</span>
        <div v-if="control?.models?.length" class="composer-select-wrap model-select relative min-w-0 max-w-48 rounded-full">
          <select
            class="composer-select h-7 w-full appearance-none rounded-full py-0 pl-2 pr-6 text-xs outline-none"
            :value="control.currentModelId"
            title="模型"
            aria-label="模型"
            :disabled="running || settingsLoading"
            @change="changeSetting($event, 'modelId')"
          >
            <option v-for="model in control.models" :key="model.id" :value="model.id">{{ model.label }}</option>
          </select>
          <ChevronDown class="theme-muted-text pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2" />
        </div>
        <div v-if="control?.reasoningEfforts?.length" class="effort-control relative min-w-0 rounded-full">
          <Brain class="theme-muted-text pointer-events-none absolute left-1.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <select
            class="composer-select h-7 max-w-28 appearance-none rounded-full py-0 pl-6 pr-6 text-xs outline-none"
            :value="control.currentReasoningEffort"
            title="思考强度"
            aria-label="思考强度"
            :disabled="running || settingsLoading"
            @change="changeSetting($event, 'reasoningEffort')"
          >
            <option v-for="effort in control.reasoningEfforts" :key="effort.id" :value="effort.id">{{ effort.label }}</option>
          </select>
          <ChevronDown class="theme-muted-text pointer-events-none absolute right-1.5 top-1/2 h-3 w-3 -translate-y-1/2" />
        </div>
        <LoaderCircle v-if="settingsLoading" class="theme-muted-text h-3.5 w-3.5 shrink-0 animate-spin" />
      </div>
      <div class="composer-actions flex shrink-0 items-center gap-2">
        <div
          v-if="control"
          class="context-usage flex h-7 w-7 items-center justify-center rounded-full"
          :title="contextUsageTitle"
          :aria-label="contextUsage ? `上下文窗口已使用 ${Math.round(contextPercentage)}%` : '暂无上下文窗口使用量'"
          role="img"
        >
          <svg class="context-ring h-4 w-4" viewBox="0 0 16 16" aria-hidden="true">
            <circle class="context-ring-track" cx="8" cy="8" r="6" fill="none" stroke-width="2" />
            <circle v-if="contextUsage" class="context-ring-progress" :class="contextUsageTone" cx="8" cy="8" r="6" fill="none" stroke-width="2" stroke-linecap="round" :style="contextProgressStyle" />
          </svg>
        </div>
        <button v-if="running" type="button" class="quiet-icon-button h-8 w-8" title="停止" @click="emit('cancel')"><CircleStop class="h-4 w-4" /></button>
        <button v-else type="button" class="tool-button tool-button-primary round-icon-button h-8 w-8" title="发送" :disabled="sendDisabled" @click="submit">
          <LoaderCircle v-if="submitting || sending" class="h-4 w-4 animate-spin" />
          <Send v-else class="h-4 w-4" />
        </button>
      </div>
    </div>
  </div>

  <div v-if="preview" class="modal-backdrop fixed inset-0 z-[60] flex items-center justify-center p-6" @click.self="preview = null">
    <button type="button" class="image-preview-overlay__button tool-button round-icon-button absolute right-4 top-4 h-9 w-9" title="关闭预览" @click="preview = null"><X class="h-4 w-4" /></button>
    <img :src="preview.objectUrl" :alt="preview.file.name" class="max-h-full max-w-full object-contain" />
  </div>
</template>

<style scoped>
.composer { background: var(--theme-appPanelStrong); box-shadow: 0 1px 4px color-mix(in srgb, var(--theme-textPrimary) 10%, transparent); }
.composer-dragging { background: var(--theme-primaryBg); box-shadow: 0 0 0 2px var(--theme-primaryBorder); }
.attachment-pill { background: var(--theme-appPanelInset); }
.attachment-preview, .attachment-file { background: var(--theme-appPanelMuted); color: var(--theme-textMuted); }
.attachment-action { display: flex; align-items: center; justify-content: center; color: var(--theme-textMuted); }
.attachment-action:hover { color: var(--theme-dangerText); }
.attachment-error { color: var(--theme-dangerText); }
.composer-input { min-height: 46px; }
.composer-input::placeholder { color: var(--theme-textMuted); }
.composer-control-button { display: inline-flex; flex: 0 0 auto; align-items: center; justify-content: center; border-radius: 9999px; color: var(--theme-textMuted); transition: background-color 120ms ease, color 120ms ease; }
.composer-control-button:hover:not(:disabled), .composer-select-wrap:hover, .effort-control:hover { background: var(--theme-appPanelMuted); }
.composer-control-button:disabled { cursor: not-allowed; opacity: 0.5; }
.composer-select { width: auto; max-width: 100%; border: 0; background: transparent; color: var(--theme-textMuted); cursor: pointer; field-sizing: content; }
.composer-select:focus { background: var(--theme-appPanelMuted); color: var(--theme-textPrimary); }
.composer-select:disabled { cursor: not-allowed; opacity: 0.5; }
.context-usage { color: var(--theme-textMuted); }
.context-ring { transform: rotate(-90deg); }
.context-ring-track { stroke: var(--theme-appPanelMuted); }
.context-ring-progress { transition: stroke-dashoffset 180ms ease; }
.context-progress-normal { stroke: var(--theme-textMuted); }
.context-progress-warning { stroke: var(--theme-warning); }
.context-progress-danger { stroke: var(--theme-danger); }
.modal-backdrop { background: var(--theme-modalBackdrop); }
@media (max-width: 640px) {
  .composer-input { min-height: 38px; padding-top: 0.5rem; }
  .composer-toolbar { flex-wrap: nowrap; }
  .composer-controls { flex-basis: auto; }
  .model-select { width: auto; max-width: min(7.5rem, 34vw); flex: 0 1 auto; }
  .effort-control { flex: 0 0 auto; }
  .composer-actions { gap: 0.25rem; margin-left: auto; }
}
</style>
