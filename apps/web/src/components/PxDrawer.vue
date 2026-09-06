<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  side: { type: String, default: 'right' },
  width: { type: String, default: 'min(42rem, calc(100vw - 15rem))' },
  closeOnBackdrop: { type: Boolean, default: true },
  closeOnEscape: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])
const panel = ref(null)
let previouslyFocused = null

const style = computed(() => ({ '--px-drawer-width': props.width }))

function close() { emit('close') }
function onKeydown(event) {
  if (!props.open) return
  if (event.key === 'Escape' && props.closeOnEscape) close()
}
watch(() => props.open, (open) => {
  if (open) {
    previouslyFocused = document.activeElement
    window.addEventListener('keydown', onKeydown)
    nextTick(() => panel.value?.focus())
    document.body.classList.add('overflow-hidden')
  } else {
    window.removeEventListener('keydown', onKeydown)
    document.body.classList.remove('overflow-hidden')
    if (previouslyFocused?.isConnected) previouslyFocused.focus()
    previouslyFocused = null
  }
}, { immediate: true })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  document.body.classList.remove('overflow-hidden')
})
</script>

<template>
  <Teleport to="body">
    <Transition name="px-drawer">
      <div v-if="props.open" class="px-drawer-backdrop fixed inset-0 z-40" @click.self="props.closeOnBackdrop && close()">
        <aside ref="panel" tabindex="-1" class="px-drawer-panel absolute inset-y-0 right-0 flex min-h-0 flex-col" :class="`px-drawer-${props.side}`" :style="style" aria-modal="true" role="dialog" :aria-label="props.title || undefined">
          <slot />
        </aside>
      </div>
    </Transition>
  </Teleport>
</template>
