<script setup>
import { LoaderCircle } from 'lucide-vue-next'

const props = defineProps({
  variant: { type: String, default: 'quiet' },
  size: { type: String, default: 'md' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
  label: { type: String, default: '' },
})
</script>

<template>
  <button
    :type="props.type"
    class="px-icon-button inline-flex items-center justify-center transition"
    :class="[`px-icon-button-${props.variant}`, `px-icon-button-${props.size}`]"
    :disabled="props.disabled || props.loading"
    :aria-label="props.label || undefined"
    :title="props.label || undefined"
  >
    <LoaderCircle v-if="props.loading" class="h-4 w-4 animate-spin" aria-hidden="true" />
    <slot v-else />
  </button>
</template>
