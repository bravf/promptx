<script setup>
import { LoaderCircle } from 'lucide-vue-next'

const props = defineProps({
  variant: { type: String, default: 'secondary' },
  size: { type: String, default: 'md' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  type: { type: String, default: 'button' },
})
</script>

<template>
  <button
    :type="props.type"
    class="px-button inline-flex items-center justify-center gap-2 font-medium transition"
    :class="[`px-button-${props.variant}`, `px-button-${props.size}`]"
    :disabled="props.disabled || props.loading"
  >
    <LoaderCircle v-if="props.loading" class="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
    <slot />
  </button>
</template>
