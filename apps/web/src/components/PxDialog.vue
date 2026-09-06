<script setup>
import DialogShell from './DialogShell.vue'

defineProps({
  open: { type: Boolean, default: false },
  panelClass: { type: String, default: '' },
  headerClass: { type: String, default: undefined },
  bodyClass: { type: String, default: undefined },
  stackLevel: { type: Number, default: 0 },
  showClose: { type: Boolean, default: true },
  closeDisabled: { type: Boolean, default: false },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEscape: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])
</script>

<template>
  <DialogShell
    :open="open"
    :panel-class="panelClass"
    :header-class="headerClass"
    :body-class="bodyClass"
    :stack-level="stackLevel"
    :show-close="showClose"
    :close-disabled="closeDisabled"
    :close-on-backdrop="closeOnBackdrop"
    :close-on-escape="closeOnEscape"
    @close="emit('close')"
  >
    <template #title><slot name="title" /></template>
    <template #header><slot name="header" /></template>
    <template #header-actions><slot name="header-actions" /></template>
    <slot />
  </DialogShell>
</template>
