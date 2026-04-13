<script setup>
import { computed, ref, watch } from 'vue'
import { MessageSquarePlus } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  context: {
    type: Object,
    default: null,
  },
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close', 'confirm'])
const { t } = useI18n()
const commentText = ref('')

const filePath = computed(() => String(props.context?.filePath || '').trim())
const snippet = computed(() => String(props.context?.snippet || '').trim())

watch(
  () => props.open,
  (open) => {
    if (open) {
      commentText.value = ''
    }
  }
)

function handleConfirm() {
  const text = String(commentText.value || '').trim()
  if (!text) {
    return
  }

  emit('confirm', text)
}
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
        <MessageSquarePlus class="h-4 w-4" />
        <span>{{ t('reviewComments.createTitle') }}</span>
      </div>
    </template>

    <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden px-4 py-4">
      <div class="settings-form-card space-y-3 px-4 py-4">
        <div class="text-sm font-medium break-all text-[var(--theme-textPrimary)]">{{ filePath }}</div>
        <pre class="theme-empty-state overflow-x-auto rounded-sm px-3 py-3 font-mono text-[11px] leading-5">{{ snippet }}</pre>
      </div>

      <label class="space-y-1.5">
        <span class="theme-muted-text text-xs">{{ t('reviewComments.inputLabel') }}</span>
        <textarea
          v-model="commentText"
          class="tool-input min-h-[8rem] resize-y"
          :placeholder="t('reviewComments.inputPlaceholder')"
        />
      </label>

      <div class="settings-form-footer flex flex-wrap items-center justify-end gap-2">
        <button type="button" class="tool-button px-3 py-2 text-xs" @click="emit('close')">
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="tool-button tool-button-primary px-3 py-2 text-xs"
          :disabled="!commentText.trim()"
          @click="handleConfirm"
        >
          {{ t('reviewComments.confirm') }}
        </button>
      </div>
    </div>
  </DialogShell>
</template>
