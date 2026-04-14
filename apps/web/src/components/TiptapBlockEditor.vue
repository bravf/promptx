<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { EditorContent, VueNodeViewRenderer, useEditor } from '@tiptap/vue-3'
import { Node } from '@tiptap/core'
import { TextSelection } from '@tiptap/pm/state'
import StarterKit from '@tiptap/starter-kit'
import Paragraph from '@tiptap/extension-paragraph'
import { BLOCK_TYPES } from '@promptx/shared'
import { useI18n } from '../composables/useI18n.js'
import { shouldSendOnWorkbenchKeydown } from '../lib/workbenchPreferences.js'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'
import PathMentionPicker from './PathMentionPicker.vue'
import TiptapTextBlockView from './TiptapTextBlockView.vue'
import TiptapImportedTextBlockView from './TiptapImportedTextBlockView.vue'
import TiptapImageBlockView from './TiptapImageBlockView.vue'
import {
  TIPTAP_NODE_TYPES,
  blocksToComparableSnapshot,
  blocksToTiptapDoc,
  blocksToTiptapNodes,
  createTextBlock,
  normalizeBlocksWithAnchors,
  tiptapDocToBlocks,
} from './tiptapBlockEditorModel.js'

const props = defineProps({
  modelValue: {
    type: Array,
    required: true,
  },
  codexSessionId: {
    type: String,
    default: '',
  },
  sendBehavior: {
    type: String,
    default: 'shift_enter',
  },
  uploading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'update:modelValue',
  'upload-files',
  'import-text-files',
  'import-pdf-files',
  'clear-request',
  'file-feedback',
  'send-request',
])

const { t } = useI18n()

const TEXT_IMPORT_EXTENSIONS = new Set([
  '.md',
  '.markdown',
  '.txt',
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.mts',
  '.cts',
  '.jsx',
  '.tsx',
  '.vue',
  '.json',
  '.css',
  '.scss',
  '.sass',
  '.less',
  '.html',
  '.htm',
  '.xml',
  '.svg',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.conf',
  '.env',
  '.py',
  '.java',
  '.go',
  '.rs',
  '.rb',
  '.php',
  '.sh',
  '.bash',
  '.zsh',
  '.sql',
  '.c',
  '.cc',
  '.cpp',
  '.h',
  '.hpp',
  '.cs',
  '.kt',
  '.swift',
  '.log',
  '.csv',
])
const TEXT_IMPORT_MIME_TYPES = new Set([
  'application/json',
  'application/ld+json',
  'application/xml',
  'application/javascript',
  'application/x-javascript',
  'application/typescript',
  'application/x-typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
])
const MAX_IMAGE_FILE_SIZE = 10 * 1024 * 1024
const MAX_TEXT_FILE_SIZE = 2 * 1024 * 1024
const MAX_PDF_FILE_SIZE = 8 * 1024 * 1024
const FILE_INPUT_ACCEPT = [
  'image/*',
  '.md,.markdown,.txt,.js,.mjs,.cjs,.ts,.mts,.cts,.jsx,.tsx,.vue,.json,.css,.scss,.sass,.less,.html,.htm,.xml,.svg,.yml,.yaml,.toml,.ini,.conf,.env,.py,.java,.go,.rs,.rb,.php,.sh,.bash,.zsh,.sql,.c,.cc,.cpp,.h,.hpp,.cs,.kt,.swift,.log,.csv',
  '.pdf',
  'text/plain',
  'text/markdown',
  'text/*',
  'application/json',
  'application/xml',
  'application/javascript',
  'application/typescript',
  'application/yaml',
  'application/x-yaml',
  'application/toml',
  'application/x-toml',
  'application/x-sh',
  'application/x-shellscript',
  'application/sql',
  'application/pdf',
].join(',')

const fileInputRef = ref(null)
const mentionPickerRef = ref(null)
const previewImageUrl = ref('')
const mentionState = ref(createMentionState())
const mentionAnchorRect = ref(null)
const mentionDismissedState = ref(null)
const editorFocused = ref(false)
const lastInputAt = ref(0)

const EDITING_GRACE_PERIOD_MS = 1500

const blocks = computed(() => normalizeBlocksWithAnchors(props.modelValue))
const previewImages = computed(() => (
  blocks.value
    .filter((block) => block?.type === BLOCK_TYPES.IMAGE && String(block.content || '').trim())
    .map((block) => String(block.content || '').trim())
))

let lastCommittedSnapshot = blocksToComparableSnapshot(blocks.value)

function syncEditorBlocksToModel(currentEditor = editor.value) {
  if (!currentEditor) {
    return false
  }

  const nextBlocks = tiptapDocToBlocks(currentEditor.getJSON())
  const nextSnapshot = blocksToComparableSnapshot(nextBlocks)
  if (nextSnapshot === lastCommittedSnapshot) {
    return false
  }

  lastCommittedSnapshot = nextSnapshot
  emit('update:modelValue', nextBlocks)
  return true
}

const PromptxTextParagraph = Paragraph.extend({
  name: TIPTAP_NODE_TYPES.TEXT_BLOCK,
  group: 'block',
  content: 'inline*',
  addAttributes() {
    return {
      clientId: {
        default: '',
      },
    }
  },
  addNodeView() {
    return VueNodeViewRenderer(TiptapTextBlockView)
  },
})

const PromptxImportedTextBlock = Node.create({
  name: TIPTAP_NODE_TYPES.IMPORTED_TEXT_BLOCK,
  group: 'block',
  content: 'inline*',
  defining: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      clientId: { default: '' },
      fileName: { default: '' },
      collapsed: { default: false },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="promptx-imported-text-block"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-type': 'promptx-imported-text-block' }]
  },
  addNodeView() {
    return VueNodeViewRenderer(TiptapImportedTextBlockView)
  },
})

const PromptxImageBlock = Node.create({
  name: TIPTAP_NODE_TYPES.IMAGE_BLOCK,
  group: 'block',
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return {
      clientId: { default: '' },
      src: { default: '' },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-type="promptx-image-block"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { ...HTMLAttributes, 'data-type': 'promptx-image-block' }]
  },
  addNodeView() {
    return VueNodeViewRenderer(TiptapImageBlockView)
  },
})

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      paragraph: false,
      heading: false,
      blockquote: false,
      bulletList: false,
      orderedList: false,
      codeBlock: false,
      horizontalRule: false,
      listItem: false,
      bold: false,
      italic: false,
      strike: false,
      code: false,
      dropcursor: true,
      gapcursor: true,
    }),
    PromptxTextParagraph,
    PromptxImportedTextBlock,
    PromptxImageBlock,
  ],
  autofocus: false,
  editorProps: {
    attributes: {
      class: 'tiptap-editor min-h-full outline-none',
    },
    handleKeyDown(view, event) {
      if (shouldSendOnWorkbenchKeydown(event, {
        sendBehavior: props.sendBehavior,
        isEditing: true,
        isComposing: isComposing(),
      })) {
        event.preventDefault()
        event.stopPropagation()
        emit('send-request')
        return true
      }

      if (
        !event.shiftKey
        && !event.altKey
        && (event.metaKey || event.ctrlKey)
        && String(event.key || '').toLowerCase() === 'k'
      ) {
        return openShortcutMentionPicker()
      }

      return handleMentionPickerKeydown(event)
    },
  },
  content: blocksToTiptapDoc(blocks.value),
  onCreate({ editor: currentEditor }) {
    syncMentionState(currentEditor)
  },
  onFocus({ editor: currentEditor }) {
    editorFocused.value = true
    syncMentionState(currentEditor)
  },
  onBlur() {
    editorFocused.value = false
  },
  onSelectionUpdate({ editor: currentEditor }) {
    syncMentionState(currentEditor)
  },
  onUpdate({ editor: currentEditor }) {
    lastInputAt.value = Date.now()
    syncEditorBlocksToModel(currentEditor)
    syncMentionState(currentEditor)
  },
})

watch(
  editor,
  (currentEditor) => {
    if (!currentEditor) {
      return
    }

    const normalizedBlocks = normalizeBlocksWithAnchors(props.modelValue)
    const incomingSnapshot = blocksToComparableSnapshot(normalizedBlocks)
    lastCommittedSnapshot = incomingSnapshot
    currentEditor.commands.setContent(blocksToTiptapDoc(normalizedBlocks), false)
  },
  { immediate: true }
)

watch(
  () => props.modelValue,
  (value) => {
    const currentEditor = editor.value
    if (!currentEditor) {
      lastCommittedSnapshot = blocksToComparableSnapshot(normalizeBlocksWithAnchors(value))
      return
    }

    const normalizedBlocks = normalizeBlocksWithAnchors(value)
    const incomingSnapshot = blocksToComparableSnapshot(normalizedBlocks)
    if (incomingSnapshot === lastCommittedSnapshot) {
      return
    }

    lastCommittedSnapshot = incomingSnapshot
    currentEditor.commands.setContent(blocksToTiptapDoc(normalizedBlocks), false)
  },
  { deep: true }
)

function emitFileFeedback(message) {
  const text = String(message || '').trim()
  if (!text) {
    return
  }

  emit('file-feedback', text)
}

function getFileExtension(file) {
  const name = String(file?.name || '').trim().toLowerCase()
  if (!name.includes('.')) {
    return ''
  }

  return `.${name.split('.').pop()}`
}

function getDisplayFileName(file, fallbackLabel) {
  return String(file?.name || '').trim() || t(fallbackLabel)
}

function formatFileSize(bytes) {
  const normalized = Math.max(0, Number(bytes) || 0)
  if (normalized >= 1024 * 1024) {
    return `${(normalized / (1024 * 1024)).toFixed(normalized >= 10 * 1024 * 1024 ? 0 : 1)} MB`
  }
  if (normalized >= 1024) {
    return `${Math.round(normalized / 1024)} KB`
  }
  return `${normalized} B`
}

function isTextImportFile(file) {
  if (!file) {
    return false
  }
  const type = String(file.type || '').toLowerCase()
  const extension = getFileExtension(file)
  return type.startsWith('text/') || TEXT_IMPORT_EXTENSIONS.has(extension) || TEXT_IMPORT_MIME_TYPES.has(type)
}

function isPdfImportFile(file) {
  if (!file) {
    return false
  }
  const name = String(file.name || '').toLowerCase()
  const type = String(file.type || '').toLowerCase()
  return name.endsWith('.pdf') || type === 'application/pdf'
}

function splitIncomingFiles(fileList) {
  const files = Array.from(fileList || []).filter(Boolean)
  const accepted = {
    imageFiles: [],
    textFiles: [],
    pdfFiles: [],
  }
  const unsupportedFiles = []
  const oversizedFiles = []

  files.forEach((file) => {
    if (file.type.startsWith('image/')) {
      if (file.size > MAX_IMAGE_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedImage'),
          limit: formatFileSize(MAX_IMAGE_FILE_SIZE),
        })
        return
      }
      accepted.imageFiles.push(file)
      return
    }

    if (isPdfImportFile(file)) {
      if (file.size > MAX_PDF_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedPdf'),
          limit: formatFileSize(MAX_PDF_FILE_SIZE),
        })
        return
      }
      accepted.pdfFiles.push(file)
      return
    }

    if (isTextImportFile(file)) {
      if (file.size > MAX_TEXT_FILE_SIZE) {
        oversizedFiles.push({
          name: getDisplayFileName(file, 'blockEditor.unnamedFile'),
          limit: formatFileSize(MAX_TEXT_FILE_SIZE),
        })
        return
      }
      accepted.textFiles.push(file)
      return
    }

    unsupportedFiles.push(getDisplayFileName(file, 'blockEditor.unnamedFile'))
  })

  return {
    ...accepted,
    unsupportedFiles,
    oversizedFiles,
  }
}

function notifyRejectedFiles({ unsupportedFiles = [], oversizedFiles = [] } = {}) {
  if (unsupportedFiles.length) {
    emitFileFeedback(t('blockEditor.unsupportedFiles', {
      names: unsupportedFiles.slice(0, 3).join('、'),
      extra: Math.max(0, unsupportedFiles.length - 3),
    }))
  }

  if (oversizedFiles.length) {
    emitFileFeedback(t('blockEditor.oversizedFiles', {
      names: oversizedFiles.slice(0, 2).map((item) => item.name).join('、'),
      extra: Math.max(0, oversizedFiles.length - 2),
      limit: oversizedFiles[0]?.limit || '',
    }))
  }
}

function dispatchIncomingFiles(fileList) {
  const {
    imageFiles,
    textFiles,
    pdfFiles,
    unsupportedFiles,
    oversizedFiles,
  } = splitIncomingFiles(fileList)

  notifyRejectedFiles({ unsupportedFiles, oversizedFiles })

  if (textFiles.length) {
    emit('import-text-files', textFiles)
  }
  if (pdfFiles.length) {
    emit('import-pdf-files', pdfFiles)
  }
  if (imageFiles.length) {
    emit('upload-files', imageFiles)
  }

  return imageFiles.length + textFiles.length + pdfFiles.length > 0
}

function handleSurfacePaste(event) {
  const files = [...event.clipboardData.items]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter(Boolean)

  if (!files.length) {
    return
  }

  event.preventDefault()
  dispatchIncomingFiles(files)
}

function handleSurfaceDrop(event) {
  event.preventDefault()
  dispatchIncomingFiles(event.dataTransfer.files)
}

function handleSurfaceMouseDown(event) {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }

  const target = event.target instanceof Element ? event.target : null
  const currentTarget = event.currentTarget instanceof Element ? event.currentTarget : null
  const editorRoot = currentEditor.view.dom instanceof Element ? currentEditor.view.dom : null
  if (!target || !currentTarget || !editorRoot) {
    return
  }

  if (target.closest('button, input, textarea, select, a, [contenteditable="false"]')) {
    return
  }

  if (!currentTarget.contains(target)) {
    return
  }

  const clickedBlock = Boolean(target.closest('[data-promptx-node]'))
  if (clickedBlock) {
    return
  }

  const clickedEditorSurface = target === currentTarget || target === editorRoot || currentTarget.contains(target)
  if (!clickedEditorSurface) {
    return
  }

  event.preventDefault()
  focusEditor()
}

function handleFileInput(event) {
  dispatchIncomingFiles(event.target.files)
  event.target.value = ''
}

function openFilePicker() {
  fileInputRef.value?.click()
}

function focusEditor() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }
  currentEditor.chain().focus('end').run()
}

function flushPendingInput() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return false
  }

  currentEditor.view.domObserver?.flush?.()
  const changed = syncEditorBlocksToModel(currentEditor)
  if (changed) {
    lastInputAt.value = Date.now()
  }
  syncMentionState(currentEditor)
  return changed
}

function insertNodes(nodes = []) {
  const currentEditor = editor.value
  if (!currentEditor || !nodes.length) {
    return
  }

  currentEditor.chain().focus().insertContent(nodes).run()
}

function insertBlocks(blocksToInsert = []) {
  insertNodes(blocksToTiptapNodes(blocksToInsert))
}

function insertImportedBlocks(importedBlocks = []) {
  insertBlocks(importedBlocks)
}

function insertUploadedBlocks(uploadedBlocks = []) {
  insertBlocks(uploadedBlocks)
}

function clearContent() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return
  }

  currentEditor.commands.setContent(blocksToTiptapDoc([createTextBlock('')]), true)
}

function isComposing() {
  return Boolean(editor.value?.view?.composing)
}

function isEditing() {
  if (isComposing()) {
    return true
  }

  if (editorFocused.value || Boolean(editor.value?.isFocused)) {
    return true
  }

  return Date.now() - lastInputAt.value < EDITING_GRACE_PERIOD_MS
}

function isImportedBlockActive() {
  const currentEditor = editor.value
  if (!currentEditor) {
    return false
  }

  const selection = currentEditor.state.selection
  const selectedNode = selection.$from.nodeAfter || selection.$from.parent
  return selectedNode?.type?.name === TIPTAP_NODE_TYPES.IMPORTED_TEXT_BLOCK
}

function handleImagePreviewEvent(event) {
  const src = String(event?.detail?.src || '').trim()
  if (!src) {
    return
  }
  previewImageUrl.value = src
}

function createMentionState() {
  return {
    open: false,
    start: -1,
    end: -1,
    query: '',
    trigger: 'mention',
    blockType: '',
    clientId: '',
  }
}

function isDismissedMentionMatch(left = null, right = null) {
  if (!left || !right) {
    return false
  }

  return left.start === right.start
    && left.end === right.end
    && left.query === right.query
    && left.clientId === right.clientId
}

function clearMentionAnchor() {
  mentionAnchorRect.value = null
}

function closeMentionPicker(options = {}) {
  const { suppressCurrent = false } = options
  const currentState = mentionState.value

  if (suppressCurrent && currentState.open) {
    mentionDismissedState.value = {
      start: currentState.start,
      end: currentState.end,
      query: currentState.query,
      clientId: currentState.clientId,
    }
  }

  mentionState.value = createMentionState()
  clearMentionAnchor()
}

function dismissMentionPicker() {
  closeMentionPicker({ suppressCurrent: true })
}

function getCurrentTextLikeContext(currentEditor = editor.value) {
  if (!currentEditor) {
    return null
  }

  const selection = currentEditor.state.selection
  if (!selection.empty) {
    return null
  }

  const { $from, from } = selection
  const nodeTypeName = $from.parent?.type?.name || ''
  if (![TIPTAP_NODE_TYPES.TEXT_BLOCK, TIPTAP_NODE_TYPES.IMPORTED_TEXT_BLOCK].includes(nodeTypeName)) {
    return null
  }

  const textBefore = $from.parent.textBetween(0, $from.parentOffset, '\n', '\0')

  return {
    from,
    node: $from.parent,
    nodeTypeName,
    nodeStart: $from.start(),
    parentOffset: $from.parentOffset,
    clientId: String($from.parent.attrs?.clientId || ''),
    textBefore,
  }
}

function updateMentionAnchor(position = mentionState.value.end) {
  const currentEditor = editor.value
  if (typeof position === 'object' && position !== null) {
    position = mentionState.value.end
  }
  if (!currentEditor || !mentionState.value.open || position < 0) {
    clearMentionAnchor()
    return
  }

  try {
    const coords = currentEditor.view.coordsAtPos(position)
    mentionAnchorRect.value = {
      left: coords.left,
      right: coords.left,
      top: coords.bottom,
      bottom: coords.bottom,
      width: 0,
      height: 0,
    }
  } catch {
    clearMentionAnchor()
  }
}

function syncMentionState(currentEditor = editor.value) {
  const context = getCurrentTextLikeContext(currentEditor)
  const existingState = mentionState.value

  if (existingState.open && existingState.trigger === 'shortcut') {
    if (!context || context.clientId !== existingState.clientId || context.from < existingState.start) {
      closeMentionPicker()
      return
    }

    const mentionQuery = currentEditor.state.doc.textBetween(existingState.start, context.from, '\n', '\0')
    if (/\s/.test(mentionQuery)) {
      closeMentionPicker()
      return
    }

    mentionDismissedState.value = null
    mentionState.value = {
      ...existingState,
      end: context.from,
      query: mentionQuery,
    }
    updateMentionAnchor(context.from)
    return
  }

  if (!context) {
    closeMentionPicker()
    return
  }

  const mentionStart = context.textBefore.lastIndexOf('@')
  if (mentionStart < 0) {
    closeMentionPicker()
    return
  }

  const mentionQuery = context.textBefore.slice(mentionStart + 1)
  if (/\s/.test(mentionQuery)) {
    closeMentionPicker()
    return
  }

  const start = context.nodeStart + mentionStart
  const end = context.from
  if (isDismissedMentionMatch(mentionDismissedState.value, {
    start,
    end,
    query: mentionQuery,
    clientId: context.clientId,
  })) {
    return
  }

  mentionDismissedState.value = null
  mentionState.value = {
    open: true,
    start,
    end,
    query: mentionQuery,
    trigger: 'mention',
    blockType: context.nodeTypeName,
    clientId: context.clientId,
  }
  updateMentionAnchor(end)
}

function openShortcutMentionPicker() {
  const currentEditor = editor.value
  const context = getCurrentTextLikeContext(currentEditor)
  if (!currentEditor || !context) {
    return false
  }

  mentionDismissedState.value = null
  mentionState.value = {
    open: true,
    start: context.from,
    end: context.from,
    query: '',
    trigger: 'shortcut',
    blockType: context.nodeTypeName,
    clientId: context.clientId,
  }
  updateMentionAnchor(context.from)
  return true
}

function applyMentionSelection(item) {
  const currentEditor = editor.value
  const pathValue = String(item?.path || '').trim()
  const state = mentionState.value

  if (!currentEditor || !pathValue || state.start < 0 || state.end < state.start) {
    closeMentionPicker()
    return false
  }

  const insertedValue = state.trigger === 'shortcut' ? `${pathValue} ` : `@${pathValue} `
  const selectionTo = state.start + insertedValue.length

  currentEditor.chain().focus().command(({ tr, dispatch }) => {
    tr.insertText(insertedValue, state.start, state.end)
    tr.setSelection(TextSelection.create(tr.doc, selectionTo))
    dispatch?.(tr)
    return true
  }).run()

  lastInputAt.value = Date.now()
  mentionDismissedState.value = null
  closeMentionPicker()
  return true
}

function handleMentionPickerKeydown(event) {
  if (!mentionState.value.open) {
    return false
  }

  if (event.key === 'Escape') {
    dismissMentionPicker()
    return true
  }

  if (event.key === 'ArrowDown') {
    return Boolean(mentionPickerRef.value?.moveActive?.(1))
  }

  if (event.key === 'ArrowUp') {
    return Boolean(mentionPickerRef.value?.moveActive?.(-1))
  }

  if (mentionState.value.query && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    return false
  }

  if (event.key === 'ArrowRight') {
    const result = mentionPickerRef.value?.expandActiveDirectory?.()
    if (result && typeof result.then === 'function') {
      result.catch(() => {})
      return true
    }
    return Boolean(result)
  }

  if (event.key === 'ArrowLeft') {
    return Boolean(mentionPickerRef.value?.collapseActiveDirectory?.())
  }

  if (!event.shiftKey && !event.altKey && !event.metaKey && !event.ctrlKey && event.key === 'Enter') {
    return Boolean(mentionPickerRef.value?.confirmActive?.())
  }

  return false
}

onMounted(() => {
  window.addEventListener('promptx:tiptap-image-preview', handleImagePreviewEvent)
  window.addEventListener('resize', updateMentionAnchor)
  window.addEventListener('scroll', updateMentionAnchor)
})

onBeforeUnmount(() => {
  window.removeEventListener('promptx:tiptap-image-preview', handleImagePreviewEvent)
  window.removeEventListener('resize', updateMentionAnchor)
  window.removeEventListener('scroll', updateMentionAnchor)
})

watch(
  () => props.codexSessionId,
  () => {
    closeMentionPicker()
  }
)

defineExpose({
  clearContent,
  flushPendingInput,
  focusEditor,
  insertBlocks,
  insertImportedBlocks,
  insertUploadedBlocks,
  isComposing,
  isEditing,
  isImportedBlockActive,
  openFilePicker,
})
</script>

<template>
  <section
    class="workbench-input-shell panel relative flex h-full min-h-0 flex-col overflow-hidden"
    data-promptx-editor="tiptap"
    @drop="handleSurfaceDrop"
    @dragover.prevent
    @paste="handleSurfacePaste"
  >
    <div class="theme-divider theme-secondary-text border-b px-5 py-3 text-sm">
      <div class="flex justify-end">
        <div class="w-full">
          <slot name="header-actions" />
        </div>
      </div>
      <input
        ref="fileInputRef"
        class="hidden"
        type="file"
        :accept="FILE_INPUT_ACCEPT"
        multiple
        @change="handleFileInput"
      />
    </div>

    <div
      class="flex-1 overflow-y-auto px-5 py-5"
      data-promptx-editor-scroll="tiptap"
      @mousedown="handleSurfaceMouseDown"
    >
      <div class="flex min-h-full flex-col">
        <div v-if="$slots['content-top']" class="mb-4 shrink-0">
          <slot name="content-top" />
        </div>
        <EditorContent
          v-if="editor"
          :editor="editor"
          class="min-h-[8rem] flex-1"
          data-promptx-editor-content="tiptap"
        />
      </div>
    </div>

    <ImagePreviewOverlay
      v-model="previewImageUrl"
      :images="previewImages"
    />

    <PathMentionPicker
      ref="mentionPickerRef"
      :open="mentionState.open && !!mentionAnchorRect"
      :session-id="codexSessionId"
      :query="mentionState.query"
      :anchor-rect="mentionAnchorRect"
      @close="dismissMentionPicker"
      @select="applyMentionSelection"
    />
  </section>
</template>
