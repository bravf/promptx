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
</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="3"
    panel-class="settings-dialog-panel h-full max-w-3xl sm:h-auto sm:max-h-[80vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex-1 overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <MessageSquareText class="h-4 w-4" />
        <span>{{ titleText }}</span>
      </div>
    </template>

    <div class="min-h-0 overflow-y-auto px-4 py-4">
      <div v-if="comments.length" class="space-y-3">
        <div
          v-for="comment in comments"
          :key="comment.id"
          class="settings-form-card space-y-3 px-4 py-4"
        >
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <div class="text-sm font-medium text-[var(--theme-textPrimary)] break-all">{{ comment.filePath }}</div>
              <div class="theme-muted-text mt-1 text-xs break-all">{{ comment.content }}</div>
            </div>

            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-2.5 py-1.5 text-xs"
              @click="emit('remove', comment.id)"
            >
              <Trash2 class="h-3.5 w-3.5" />
              <span>{{ t('reviewComments.remove') }}</span>
            </button>
          </div>

          <p class="text-sm leading-6 text-[var(--theme-textPrimary)] whitespace-pre-wrap break-words">
            {{ comment.comment }}
          </p>

          <pre class="theme-empty-state overflow-x-auto rounded-sm px-3 py-3 font-mono text-[11px] leading-5">{{ comment.snippet }}</pre>
        </div>
      </div>

      <div v-else class="theme-empty-state px-4 py-6 text-sm">
        {{ t('reviewComments.empty') }}
      </div>
    </div>
  </DialogShell>
</template>
