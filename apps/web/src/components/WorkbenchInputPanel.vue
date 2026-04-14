<script setup>
import { computed, ref } from 'vue'
import { MessageSquareText } from 'lucide-vue-next'
import TiptapBlockEditor from './TiptapBlockEditor.vue'
import WorkbenchEditorActions from './WorkbenchEditorActions.vue'
import ReviewCommentsDialog from './ReviewCommentsDialog.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  canAddTodo: {
    type: Boolean,
    default: false,
  },
  codexSessionId: {
    type: String,
    default: '',
  },
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
  sendState: {
    type: String,
    default: 'idle',
  },
  sendBehavior: {
    type: String,
    default: 'shift_enter',
  },
  modelValue: {
    type: Array,
    default: () => [],
  },
  reviewComments: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  todoCount: {
    type: Number,
    default: 0,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'add-todo',
  'update:modelValue',
  'upload-files',
  'import-text-files',
  'import-pdf-files',
  'file-feedback',
  'clear-request',
  'copy-request',
  'manage-todo',
  'remove-review-comment',
  'send-request',
])

const blockEditorRef = ref(null)
const showReviewCommentsDialog = ref(false)
const { t } = useI18n()

const blocks = computed({
  get: () => props.modelValue,
  set: (value) => emit('update:modelValue', value),
})

function openFilePicker() {
  blockEditorRef.value?.openFilePicker?.()
}

function focusEditor() {
  blockEditorRef.value?.focusEditor?.()
}

function flushPendingInput() {
  return blockEditorRef.value?.flushPendingInput?.() || false
}

function insertBlocks(blocksToInsert) {
  blockEditorRef.value?.insertBlocks?.(blocksToInsert)
}

function insertImportedBlocks(importedBlocks) {
  blockEditorRef.value?.insertImportedBlocks?.(importedBlocks)
}

function insertUploadedBlocks(uploadedBlocks) {
  blockEditorRef.value?.insertUploadedBlocks?.(uploadedBlocks)
}

function isImportedBlockActive() {
  return blockEditorRef.value?.isImportedBlockActive?.() || false
}

function isComposing() {
  return blockEditorRef.value?.isComposing?.() || false
}

function isEditing() {
  return blockEditorRef.value?.isEditing?.() || false
}

defineExpose({
  focusEditor,
  flushPendingInput,
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
  <ReviewCommentsDialog
    :open="showReviewCommentsDialog"
    :comments="reviewComments"
    @close="showReviewCommentsDialog = false"
    @remove="emit('remove-review-comment', $event)"
  />

  <section
    v-if="loading && !modelValue.length"
    class="panel theme-muted-text flex h-full items-center px-5 py-4 text-sm"
  >
    {{ t('workbench.loadingTaskContent') }}
  </section>
  <TiptapBlockEditor
    v-if="!loading || modelValue.length"
    ref="blockEditorRef"
    v-model="blocks"
    :codex-session-id="codexSessionId"
    :send-behavior="sendBehavior"
    :uploading="uploading"
    @upload-files="emit('upload-files', $event)"
    @import-text-files="emit('import-text-files', $event)"
    @import-pdf-files="emit('import-pdf-files', $event)"
    @file-feedback="emit('file-feedback', $event)"
    @clear-request="emit('clear-request')"
    @send-request="emit('send-request')"
  >
    <template v-if="reviewComments.length" #content-top>
      <button
        type="button"
        class="tool-button inline-flex max-w-full items-center gap-2 px-3 py-2 text-xs"
        @mousedown.prevent
        @click="showReviewCommentsDialog = true"
      >
        <MessageSquareText class="h-3.5 w-3.5 shrink-0" />
        <span class="truncate">{{ t('reviewComments.chipLabel', { count: reviewComments.length }) }}</span>
      </button>
    </template>

    <template #header-actions>
      <WorkbenchEditorActions
        :can-add-todo="canAddTodo"
        :is-current-task-sending="isCurrentTaskSending"
        :send-state="sendState"
        :todo-count="todoCount"
        :uploading="uploading"
        @add-todo="emit('add-todo')"
        @open-file-picker="openFilePicker"
        @clear-request="emit('clear-request')"
        @copy-request="emit('copy-request')"
        @manage-todo="emit('manage-todo')"
        @send-request="emit('send-request')"
      />
    </template>
  </TiptapBlockEditor>
</template>
