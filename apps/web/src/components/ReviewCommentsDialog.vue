<script setup>
import { computed } from 'vue'
import { MessageSquareText, Trash2 } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  comments: {
    type: Array,
    default: () => [],
  },
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close', 'remove'])
const { t } = useI18n()

const titleText = computed(() => t('reviewComments.dialogTitle', { count: props.comments.length }))

function getSnippetLines(comment = {}) {
  return String(comment?.snippet || '').split('\n')
}

function getSnippetHighlightIndex(comment = {}) {
  const explicitIndex = Number(comment?.snippetAnchorLine)
  if (Number.isInteger(explicitIndex) && explicitIndex >= 0) {
    return explicitIndex
  }

  const targetContent = String(comment?.content || '').trim()
  if (!targetContent) {
    return -1
  }

  return getSnippetLines(comment).findIndex((line) => String(line || '').trim() === targetContent)
}
</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="3"
    panel-class="settings-dialog-panel h-full max-w-3xl sm:h-auto sm:max-h-[80vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex flex-1 flex-col overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <MessageSquareText class="h-4 w-4" />
        <span>{{ titleText }}</span>
      </div>
    </template>

    <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
      <div v-if="comments.length" class="space-y-3">
        <div
          v-for="comment in comments"
          :key="comment.id"
          class="settings-form-card space-y-3 px-4 py-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-[var(--theme-textPrimary)] break-all">{{ comment.filePath }}</div>
              <div class="theme-muted-text mt-1 text-xs break-all whitespace-pre-wrap">{{ comment.content }}</div>
            </div>

            <button
              type="button"
              class="tool-button inline-flex shrink-0 items-center gap-2 self-start px-2.5 py-1.5 text-xs"
              @click="emit('remove', comment.id)"
            >
              <Trash2 class="h-3.5 w-3.5" />
              <span>{{ t('reviewComments.remove') }}</span>
            </button>
          </div>

          <p class="text-sm leading-6 text-[var(--theme-textPrimary)] whitespace-pre-wrap break-words">
            {{ comment.comment }}
          </p>

          <div class="theme-empty-state overflow-x-auto rounded-sm px-3 py-3 font-mono text-[11px] leading-5">
            <div
              v-for="(line, index) in getSnippetLines(comment)"
              :key="`${comment.id}-snippet-${index}`"
              class="review-comment-snippet-line whitespace-pre"
              :class="index === getSnippetHighlightIndex(comment) ? 'review-comment-snippet-line--target' : ''"
            >
              {{ line }}
            </div>
          </div>
        </div>
      </div>

      <div v-else class="theme-empty-state px-4 py-6 text-sm">
        {{ t('reviewComments.empty') }}
      </div>
    </div>
  </DialogShell>
</template>

<style scoped>
.review-comment-snippet-line {
  border-radius: 0.125rem;
  display: block;
  padding: 0 0.375rem;
}

.review-comment-snippet-line--target {
  background: color-mix(in srgb, var(--theme-warningBg) 88%, transparent);
  box-shadow: inset 3px 0 0 var(--theme-warning);
}
</style>
