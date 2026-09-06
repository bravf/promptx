<script setup>
import { computed } from 'vue'
import { TriangleAlert } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import PxButton from './PxButton.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: '',
  },
  description: {
    type: String,
    default: '',
  },
  confirmText: {
    type: String,
    default: '',
  },
  cancelText: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  danger: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['cancel', 'confirm'])

const resolvedTitle = computed(() => props.title || '确认操作')
const resolvedConfirmText = computed(() => props.confirmText || '确认')
const resolvedCancelText = computed(() => props.cancelText || '取消')

</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="4"
    panel-class="max-w-md"
    header-class="px-5 py-4"
    body-class="flex flex-col"
    :close-disabled="loading"
    :close-on-backdrop="!loading"
    :close-on-escape="!loading"
    @close="emit('cancel')"
  >
    <template #title>
      <div class="flex items-start gap-3">
        <span
          class="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-sm border border-dashed"
          :class="danger ? 'theme-status-danger' : 'theme-status-neutral'"
        >
          <TriangleAlert class="h-4 w-4" />
        </span>
        <div>
          <h2 class="theme-heading text-base font-semibold">{{ resolvedTitle }}</h2>
          <p v-if="description" class="theme-muted-text mt-1 text-sm leading-6">{{ description }}</p>
        </div>
      </div>
    </template>

    <div class="flex justify-end gap-2 px-5 py-4">
      <PxButton size="sm" :disabled="loading" @click="emit('cancel')">
        {{ resolvedCancelText }}
      </PxButton>
      <PxButton
        type="button"
        :variant="danger ? 'danger' : 'primary'"
        size="sm"
        :loading="loading"
        :disabled="loading"
        @click="emit('confirm')"
      >
        {{ resolvedConfirmText }}
      </PxButton>
    </div>
  </DialogShell>
</template>
