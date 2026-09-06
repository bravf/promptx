<script setup>
const props = defineProps({
  label: { type: String, default: '' },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
  required: { type: Boolean, default: false },
  forId: { type: String, default: '' },
})
</script>

<template>
  <label class="px-field block" :for="props.forId || undefined">
    <span v-if="props.label" class="px-field-label mb-1.5 block text-xs">
      {{ props.label }}<span v-if="props.required" class="px-field-required ml-0.5" aria-hidden="true">*</span>
    </span>
    <slot />
    <span v-if="props.error" class="px-field-error mt-1.5 block text-xs" role="alert">{{ props.error }}</span>
    <span v-else-if="props.hint" class="px-field-hint mt-1.5 block text-xs">{{ props.hint }}</span>
  </label>
</template>
