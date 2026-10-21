<script setup>
import { PhWarningCircle, PhCheckCircle, PhInfo, PhWarning, PhX } from '@phosphor-icons/vue'
import { computed } from 'vue'
import PxIconButton from './PxIconButton.vue'

const props = defineProps({
  variant: { type: String, default: 'error' },
  title: { type: String, default: '' },
  dismissible: { type: Boolean, default: false },
})
const emit = defineEmits(['dismiss'])
const icon = computed(() => ({ error: PhWarningCircle, warning: PhWarning, info: PhInfo, success: PhCheckCircle }[props.variant] || PhWarningCircle))
</script>

<template>
  <div class="px-alert flex items-start gap-2.5 rounded-sm border px-3 py-2.5 text-xs" :class="`px-alert-${props.variant}`" role="alert">
    <component :is="icon" class="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
    <div class="min-w-0 flex-1">
      <div v-if="props.title" class="font-medium">{{ props.title }}</div>
      <div :class="props.title ? 'mt-0.5' : ''"><slot /></div>
    </div>
    <PxIconButton v-if="props.dismissible" class="px-alert-dismiss h-6 w-6" label="关闭提示" @click="emit('dismiss')"><PhX class="h-3.5 w-3.5" /></PxIconButton>
  </div>
</template>
