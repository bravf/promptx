<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  ChevronDown,
  FileText,
  Image as ImageIcon,
  LoaderCircle,
  ScanText,
  Trash2,
  Upload,
} from 'lucide-vue-next'
import { BLOCK_TYPES } from '@promptx/shared'

const props = defineProps({
  modelValue: {
    type: Array,
    required: true,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue', 'upload-files', 'import-text-files', 'import-pdf-files', 'clear-request'])

const blocks = computed(() => props.modelValue)
const activeIndex = ref(0)
const textareas = ref([])
const surfaceRef = ref(null)
const contentRef = ref(null)
const selectionMap = ref({})

function isCursorTextBlock(block) {
  return block?.type === BLOCK_TYPES.TEXT
}

function isTextLikeBlock(block) {
  return block?.type === BLOCK_TYPES.TEXT || block?.type === BLOCK_TYPES.IMPORTED_TEXT
}

function isNonTextBlock(block) {
  return block && block.type !== BLOCK_TYPES.TEXT
}

function createTextBlock(content = '') {
  return { type: BLOCK_TYPES.TEXT, content, meta: {} }
}

function normalizeBlocksWithAnchors(inputBlocks = []) {
  const source = Array.isArray(inputBlocks) ? inputBlocks.filter(Boolean) : []
  if (!source.length) {
    return [createTextBlock('')]
  }

  const normalized = []

  source.forEach((block, index) => {
    const previous = normalized[normalized.length - 1]
    if (!previous && isNonTextBlock(block)) {
      normalized.push(createTextBlock(''))
    }
    if (previous && isNonTextBlock(previous) && isNonTextBlock(block)) {
      normalized.push(createTextBlock(''))
    }
    normalized.push(block)

    if (index === source.length - 1 && isNonTextBlock(block)) {
      normalized.push(createTextBlock(''))
    }
  })

  return normalized
}

function areBlocksEquivalent(left = [], right = []) {
  if (left === right) {
    return true
  }
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return false
  }

  return left.every((block, index) => {
    const other = right[index]
    if (!other || block?.type !== other.type || block?.content !== other.content) {
      return false
    }

    return (block?.meta?.fileName || '') === (other.meta?.fileName || '')
      && Boolean(block?.meta?.collapsed) === Boolean(other.meta?.collapsed)
  })
}

function setBlocks(nextBlocks) {
  emit('update:modelValue', normalizeBlocksWithAnchors(nextBlocks))
}

function setTextRef(element, index) {
  if (element) {
    if (textareas.value[index] === element) {
      return
    }
    textareas.value[index] = element
    resizeTextarea(element)
    return
  }
  textareas.value[index] = null
}

function resizeTextarea(element) {
  if (!element) {
    return
  }

  const scrollX = window.scrollX
  const scrollY = window.scrollY
  const selectionStart = element.selectionStart
  const selectionEnd = element.selectionEnd
  const isActive = document.activeElement === element

  element.style.height = 'auto'
  element.style.height = `${Math.max(element.scrollHeight, 40)}px`

  if (isActive && selectionStart !== null && selectionEnd !== null) {
    element.setSelectionRange(selectionStart, selectionEnd)
  }
  if (window.scrollX !== scrollX || window.scrollY !== scrollY) {
    window.scrollTo(scrollX, scrollY)
  }
}

function scrollContentToBottom() {
  nextTick(() => {
    if (!contentRef.value) {
      return
    }
    contentRef.value.scrollTop = contentRef.value.scrollHeight
  })
}

function placeCursor(index, position = null) {
  const target = textareas.value[index]
  if (!target) {
    return
  }
  const nextPosition = position ?? target.value.length
  target.focus()
  target.setSelectionRange(nextPosition, nextPosition)
  selectionMap.value[index] = {
    start: nextPosition,
    end: nextPosition,
  }
}

function updateText(index, content) {
  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index ? { ...block, content } : block
  )
  setBlocks(nextBlocks)
}

function toggleImportedCollapse(index) {
  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index
      ? {
          ...block,
          meta: {
            ...block.meta,
            collapsed: !block.meta?.collapsed,
          },
        }
      : block
  )
  setBlocks(nextBlocks)
}

function convertImportedToText(index) {
  const current = blocks.value[index]
  if (!current || current.type !== BLOCK_TYPES.IMPORTED_TEXT) {
    return
  }

  const nextBlocks = blocks.value.map((block, itemIndex) =>
    itemIndex === index
      ? {
          type: BLOCK_TYPES.TEXT,
          content: block.content,
          meta: {},
        }
      : block
  )
  setBlocks(nextBlocks)
  activeIndex.value = index
  nextTick(() => placeCursor(index, 0))
}

function removeBlock(index) {
  const current = blocks.value[index]
  if (current?.type === BLOCK_TYPES.TEXT && blocks.value.length === 1) {
    setBlocks([{ ...current, content: '' }])
    nextTick(() => placeCursor(0, 0))
    return
  }

  const nextBlocks = blocks.value.filter((_, itemIndex) => itemIndex !== index)
  setBlocks(nextBlocks)
  nextTick(() => {
    const nextIndex = Math.max(0, Math.min(index, nextBlocks.length - 1))
    if (blocks.value[nextIndex]?.type === BLOCK_TYPES.TEXT) {
      placeCursor(nextIndex, 0)
    }
  })
}

function clearDocument() {
  setBlocks([createTextBlock('')])
  activeIndex.value = 0
  selectionMap.value = {
    0: { start: 0, end: 0 },
  }
  nextTick(() => placeCursor(0, 0))
}

function getImportedPreview(content = '', max = 180) {
  const compact = String(content).replace(/\s+/g, ' ').trim()
  return compact.slice(0, max)
}

function getImportedStats(content = '') {
  const text = String(content)
  const lines = text ? text.split('\n').length : 0
  const chars = text.length
  return `${lines} 行 · ${chars} 字`
}

function recordSelection(index, event) {
  selectionMap.value[index] = {
    start: event.target.selectionStart ?? 0,
    end: event.target.selectionEnd ?? 0,
  }
}

function splitTextBlockForInsertion(currentIndex, incomingBlocks, options = {}) {
  const { focusAfterInserted = false } = options
  const nextBlocks = [...blocks.value]
  const currentBlock = nextBlocks[currentIndex]
  const selection = selectionMap.value[currentIndex] || {
    start: currentBlock.content.length,
    end: currentBlock.content.length,
  }
  const start = Math.max(0, selection.start ?? 0)
  const end = Math.max(start, selection.end ?? start)
  const before = currentBlock.content.slice(0, start)
  const after = currentBlock.content.slice(end)

  const replacement = []
  if (before) {
    replacement.push({ ...currentBlock, content: before })
  }
  replacement.push(...incomingBlocks)
  if (after) {
    replacement.push(createTextBlock(after))
  }

  nextBlocks.splice(currentIndex, 1, ...replacement)
  setBlocks(nextBlocks)

  nextTick(() => {
    const textSearchStart = focusAfterInserted
      ? currentIndex + replacement.length - (after ? 1 : 0)
      : currentIndex
    const nextTextIndex = blocks.value.findIndex(
      (block, index) => index >= textSearchStart && block.type === BLOCK_TYPES.TEXT
    )
    if (nextTextIndex >= 0) {
      activeIndex.value = nextTextIndex
      placeCursor(nextTextIndex, 0)
    }
  })
}

function insertBlocksAtSelection(incomingBlocks, options = {}) {
  const { focusAfterInserted = false } = options
  if (!incomingBlocks.length) {
    return
  }

  const currentIndex = Math.min(activeIndex.value ?? 0, Math.max(blocks.value.length - 1, 0))
  const currentBlock = blocks.value[currentIndex]

  if (!currentBlock || currentBlock.type === BLOCK_TYPES.IMPORTED_TEXT) {
    const nextBlocks = [...blocks.value]
    const insertionIndex = currentIndex + 1
    nextBlocks.splice(insertionIndex, 0, ...incomingBlocks)
    setBlocks(nextBlocks)
    if (focusAfterInserted) {
      nextTick(() => {
        const nextTextIndex = blocks.value.findIndex(
          (block, index) => index >= insertionIndex + incomingBlocks.length && block.type === BLOCK_TYPES.TEXT
        )
        if (nextTextIndex >= 0) {
          activeIndex.value = nextTextIndex
          placeCursor(nextTextIndex, 0)
        }
      })
    }
    return
  }

  if (!isCursorTextBlock(currentBlock)) {
    const nextBlocks = [...blocks.value]
    const insertionIndex = nextBlocks.length ? currentIndex + 1 : 0
    nextBlocks.splice(insertionIndex, 0, ...incomingBlocks)
    setBlocks(nextBlocks)
    if (focusAfterInserted) {
      nextTick(() => {
        const nextTextIndex = blocks.value.findIndex(
          (block, index) => index >= insertionIndex + incomingBlocks.length && block.type === BLOCK_TYPES.TEXT
        )
        if (nextTextIndex >= 0) {
          activeIndex.value = nextTextIndex
          placeCursor(nextTextIndex, 0)
        }
      })
    }
    return
  }

  splitTextBlockForInsertion(currentIndex, incomingBlocks, { focusAfterInserted })
}

function insertTextAtSelection(text) {
  const content = String(text || '')
  if (!content) {
    return
  }

  const currentIndex = Math.min(activeIndex.value ?? 0, Math.max(blocks.value.length - 1, 0))
  const currentBlock = blocks.value[currentIndex]
  if (!currentBlock || !isTextLikeBlock(currentBlock)) {
    insertBlocksAtSelection([createTextBlock(content)])
    return
  }

  const selection = selectionMap.value[currentIndex] || {
    start: currentBlock.content.length,
    end: currentBlock.content.length,
  }
  const start = Math.max(0, selection.start ?? 0)
  const end = Math.max(start, selection.end ?? start)
  const nextContent = `${currentBlock.content.slice(0, start)}${content}${currentBlock.content.slice(end)}`
  const nextBlocks = [...blocks.value]
  nextBlocks.splice(currentIndex, 1, { ...currentBlock, content: nextContent })
  setBlocks(nextBlocks)
  nextTick(() => placeCursor(currentIndex, start + content.length))
}

function insertUploadedBlocks(imageBlocks) {
  insertBlocksAtSelection(imageBlocks, { focusAfterInserted: true })
}

function insertBlocks(blocksToInsert) {
  insertBlocksAtSelection(blocksToInsert, { focusAfterInserted: true })
}

function insertImportedBlocks(importedBlocks) {
  insertBlocksAtSelection(importedBlocks, { focusAfterInserted: true })
}

function mergeTextBlocks(currentIndex, targetIndex) {
  const currentBlock = blocks.value[currentIndex]
  const targetBlock = blocks.value[targetIndex]
  if (!isTextLikeBlock(currentBlock) || !isTextLikeBlock(targetBlock)) {
    return
  }

  const mergedContent =
    targetIndex < currentIndex
      ? `${targetBlock.content}${currentBlock.content}`
      : `${currentBlock.content}${targetBlock.content}`

  const nextBlocks = [...blocks.value]
  const keepIndex = Math.min(currentIndex, targetIndex)
  const removeIndex = Math.max(currentIndex, targetIndex)
  nextBlocks.splice(keepIndex, 1, {
    ...nextBlocks[keepIndex],
    content: mergedContent,
  })
  nextBlocks.splice(removeIndex, 1)
  setBlocks(nextBlocks)

  const cursorPosition = targetIndex < currentIndex ? targetBlock.content.length : currentBlock.content.length
  activeIndex.value = keepIndex
  nextTick(() => placeCursor(keepIndex, cursorPosition))
}

function removeNonTextNeighbor(textIndex, blockIndex, cursorPosition = 0) {
  const nextBlocks = blocks.value.filter((_, itemIndex) => itemIndex !== blockIndex)
  setBlocks(nextBlocks)
  const nextIndex = blockIndex < textIndex ? textIndex - 1 : textIndex
  activeIndex.value = nextIndex
  nextTick(() => placeCursor(nextIndex, cursorPosition))
}

function focusAfterImage(index) {
  const nextTextIndex = blocks.value.findIndex(
    (block, itemIndex) => itemIndex > index && block.type === BLOCK_TYPES.TEXT
  )
  if (nextTextIndex >= 0) {
    activeIndex.value = nextTextIndex
    nextTick(() => placeCursor(nextTextIndex, 0))
  }
}

function insertImages(files) {
  const imageFiles = [...files].filter((file) => file && file.type.startsWith('image/'))
  if (imageFiles.length) {
    emit('upload-files', imageFiles)
  }
}

function isTextImportFile(file) {
  if (!file) {
    return false
  }
  const name = String(file.name || '').toLowerCase()
  const type = String(file.type || '').toLowerCase()
  return name.endsWith('.md') || name.endsWith('.markdown') || name.endsWith('.txt') || type.startsWith('text/')
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
  const files = [...fileList].filter(Boolean)
  return {
    imageFiles: files.filter((file) => file.type.startsWith('image/')),
    textFiles: files.filter((file) => isTextImportFile(file)),
    pdfFiles: files.filter((file) => isPdfImportFile(file)),
  }
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
  insertImages(files)
}

function handleSurfaceDrop(event) {
  event.preventDefault()
  const { imageFiles, textFiles, pdfFiles } = splitIncomingFiles(event.dataTransfer.files)
  if (textFiles.length) {
    emit('import-text-files', textFiles)
  }
  if (pdfFiles.length) {
    emit('import-pdf-files', pdfFiles)
  }
  if (imageFiles.length) {
    insertImages(imageFiles)
  }
}

function handleFileInput(event) {
  const { imageFiles, textFiles, pdfFiles } = splitIncomingFiles(event.target.files)
  if (textFiles.length) {
    emit('import-text-files', textFiles)
  }
  if (pdfFiles.length) {
    emit('import-pdf-files', pdfFiles)
  }
  if (imageFiles.length) {
    insertImages(imageFiles)
  }
  event.target.value = ''
}

function handleSurfaceClick(event) {
  if (event.target !== surfaceRef.value) {
    return
  }

  const lastTextIndex = [...blocks.value]
    .map((block, index) => ({ block, index }))
    .filter((item) => item.block.type === BLOCK_TYPES.TEXT)
    .at(-1)?.index

  if (typeof lastTextIndex === 'number') {
    activeIndex.value = lastTextIndex
    nextTick(() => placeCursor(lastTextIndex, textareas.value[lastTextIndex]?.value.length || 0))
  }
}

function handleTextFocus(index) {
  activeIndex.value = index
  const target = textareas.value[index]
  selectionMap.value[index] = {
    start: target?.selectionStart ?? 0,
    end: target?.selectionEnd ?? 0,
  }
}

function handleTextInput(event) {
  resizeTextarea(event.target)
  scrollContentToBottom()
}

function handleTextKeydown(index, event) {
  const current = blocks.value[index]
  const target = event.target

  if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key === 'Backspace') {
    event.preventDefault()
    emit('clear-request')
    return
  }

  if (!isTextLikeBlock(current)) {
    return
  }

  const selectionStart = target.selectionStart ?? 0
  const selectionEnd = target.selectionEnd ?? 0

  if (event.key === 'Backspace' && selectionStart === 0 && selectionEnd === 0) {
    const previousBlock = blocks.value[index - 1]
    if (!previousBlock) {
      return
    }

    event.preventDefault()
    if (isTextLikeBlock(previousBlock)) {
      mergeTextBlocks(index, index - 1)
      return
    }

    removeNonTextNeighbor(index, index - 1, 0)
    return
  }

  if (event.key === 'Delete' && selectionStart === current.content.length && selectionEnd === current.content.length) {
    const nextBlock = blocks.value[index + 1]
    if (!nextBlock) {
      return
    }

    event.preventDefault()
    if (isTextLikeBlock(nextBlock)) {
      mergeTextBlocks(index, index + 1)
      return
    }

    removeNonTextNeighbor(index, index + 1, current.content.length)
  }
}

const blockLayoutSignature = computed(() =>
  blocks.value
    .map((block, index) => `${index}:${block.type}:${block.meta?.collapsed ? '1' : '0'}`)
    .join('|')
)

watch(
  blockLayoutSignature,
  () => {
    nextTick(() => {
      textareas.value.forEach((element) => resizeTextarea(element))
      scrollContentToBottom()
    })
  },
  { immediate: true }
)

watch(
  () => props.modelValue,
  (value) => {
    const normalized = normalizeBlocksWithAnchors(value)
    if (!areBlocksEquivalent(normalized, value)) {
      emit('update:modelValue', normalized)
    }
  },
  { immediate: true, deep: true }
)

defineExpose({
  clearDocument,
  insertBlocks,
  insertImportedBlocks,
  insertTextAtSelection,
  insertUploadedBlocks,
  isImportedBlockActive: () => blocks.value[activeIndex.value]?.type === BLOCK_TYPES.IMPORTED_TEXT,
})
</script>

<template>
  <section
    ref="surfaceRef"
    class="panel flex h-full min-h-0 flex-col overflow-hidden"
    @click="handleSurfaceClick"
    @drop="handleSurfaceDrop"
    @dragover.prevent
    @paste="handleSurfacePaste"
  >
    <div class="border-b border-stone-200 px-5 py-4 text-sm text-stone-600 dark:border-stone-800 dark:text-stone-400">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <p class="inline-flex items-center gap-2 font-medium text-stone-900 dark:text-stone-100">
          <ScanText class="h-4 w-4" />
          <span>直接在这里输入文本，或粘贴截图。</span>
        </p>
        <div class="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:flex-wrap sm:items-center sm:justify-end">
          <slot name="header-actions" />
        </div>
      </div>
      <div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-2 text-xs">
        <span class="inline-flex items-center gap-1.5">
          <ImageIcon class="h-3.5 w-3.5" />
          <span>支持拖拽图片到编辑区</span>
        </span>
        <span class="text-stone-300 dark:text-stone-700">/</span>
        <span class="inline-flex items-center gap-1.5">
          <FileText class="h-3.5 w-3.5" />
          <span>支持拖入 `.md` / `.txt` / `.pdf` 文件</span>
        </span>
        <span class="text-stone-300 dark:text-stone-700">/</span>
        <label class="inline-flex cursor-pointer items-center gap-1.5 text-stone-700 underline decoration-stone-300 underline-offset-4 dark:text-stone-200 dark:decoration-stone-700">
          <Upload class="h-3.5 w-3.5" />
          <span>选择文件</span>
          <input class="hidden" type="file" accept="image/*,.md,.markdown,.txt,.pdf,text/plain,text/markdown,application/pdf" multiple @change="handleFileInput" />
        </label>
        <span v-if="uploading" class="inline-flex items-center gap-1.5 rounded-sm border border-dashed border-stone-400 px-2 py-1 dark:border-stone-700">
          <LoaderCircle class="h-3.5 w-3.5 animate-spin" />
          <span>正在处理文件...</span>
        </span>
      </div>
    </div>

    <div ref="contentRef" class="flex-1 overflow-y-auto px-5 py-5">
      <div class="flex flex-col gap-5">
      <template v-for="(block, index) in blocks" :key="`${block.type}-${index}`">
        <div v-if="block.type === BLOCK_TYPES.TEXT" class="group relative">
          <textarea
            :ref="(element) => setTextRef(element, index)"
            rows="1"
            :value="block.content"
            class="w-full resize-none border-0 bg-transparent p-0 pr-12 text-[15px] leading-8 text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-600"
            :placeholder="index === 0 ? '从这里开始写需求、背景、目标、验收标准，或直接粘贴长文档内容...' : '继续输入...'"
            @focus="handleTextFocus(index)"
            @input="updateText(index, $event.target.value); handleTextInput($event)"
            @keydown="handleTextKeydown(index, $event)"
            @click="recordSelection(index, $event)"
            @keyup="recordSelection(index, $event)"
            @select="recordSelection(index, $event)"
          />
          <button
            type="button"
            class="absolute right-0 top-1 tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs text-red-700 opacity-0 transition group-hover:opacity-100 focus:opacity-100 dark:text-red-300"
            @click="removeBlock(index)"
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span>删除</span>
          </button>
        </div>

        <div v-else-if="block.type === BLOCK_TYPES.IMPORTED_TEXT" class="group relative dashed-panel overflow-hidden">
          <div class="flex items-start justify-between gap-3 border-b border-dashed border-stone-300 px-4 py-3 text-xs text-stone-600 dark:border-stone-700 dark:text-stone-400">
            <div class="min-w-0 pr-24">
              <p class="font-medium text-stone-900 dark:text-stone-100">导入文件</p>
              <p class="mt-1 truncate font-mono">{{ block.meta?.fileName || '未命名文件' }}</p>
              <p class="mt-1">{{ getImportedStats(block.content) }}</p>
            </div>
            <div class="absolute right-3 top-3 flex flex-wrap gap-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
              <button type="button" class="tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs" @click="toggleImportedCollapse(index)">
                <ChevronDown class="h-3.5 w-3.5" :class="block.meta?.collapsed ? 'rotate-180' : ''" />
                <span>{{ block.meta?.collapsed ? '展开' : '折叠' }}</span>
              </button>
              <button type="button" class="tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs" @click="convertImportedToText(index)">
                <FileText class="h-3.5 w-3.5" />
                <span>转普通文本</span>
              </button>
              <button type="button" class="tool-button inline-flex items-center gap-1.5 px-2 py-1 text-xs text-red-700 dark:text-red-300" @click="removeBlock(index)">
                <Trash2 class="h-3.5 w-3.5" />
                <span>删除</span>
              </button>
            </div>
          </div>

          <div v-if="block.meta?.collapsed" class="px-4 py-3 text-sm leading-7 text-stone-600 dark:text-stone-300">
            {{ getImportedPreview(block.content) || '空内容' }}<span v-if="block.content.length > 180">...</span>
          </div>

          <textarea
            v-else
            :ref="(element) => setTextRef(element, index)"
            rows="1"
            :value="block.content"
            class="w-full resize-none border-0 bg-transparent px-4 py-4 text-[15px] leading-8 text-stone-900 outline-none placeholder:text-stone-400 dark:text-stone-100 dark:placeholder:text-stone-600"
            placeholder="导入内容为空"
            @focus="handleTextFocus(index)"
            @input="updateText(index, $event.target.value); handleTextInput($event)"
            @keydown="handleTextKeydown(index, $event)"
            @click="recordSelection(index, $event)"
            @keyup="recordSelection(index, $event)"
            @select="recordSelection(index, $event)"
          />
        </div>

        <figure v-else class="group relative">
          <button
            type="button"
            class="tool-button absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 px-2 py-1 text-xs text-red-700 opacity-0 transition group-hover:opacity-100 focus:opacity-100 dark:text-red-300"
            @click="removeBlock(index)"
          >
            <Trash2 class="h-3.5 w-3.5" />
            <span>删除</span>
          </button>
          <div class="overflow-hidden rounded-sm border border-stone-300 bg-stone-100 dark:border-stone-700 dark:bg-stone-950" @click="focusAfterImage(index)">
            <div class="flex items-center gap-2 border-b border-stone-200 px-4 py-3 text-xs text-stone-500 dark:border-stone-800 dark:text-stone-400">
              <ImageIcon class="h-4 w-4" />
              <span>已插入图片</span>
            </div>
            <img :src="block.content" alt="已插入图片" class="max-h-[540px] w-full object-contain" />
          </div>
        </figure>
      </template>
      </div>
    </div>
  </section>
</template>
