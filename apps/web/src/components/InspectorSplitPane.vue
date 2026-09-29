<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({ label: { type: String, default: '调整文件列表宽度' } })
const pane = ref(null)
const ratio = ref(null)
const dragging = ref(false)
const availableWidth = ref(0)
const mobile = ref(false)
let observer
const defaultWidth = computed(() => Math.min(240, availableWidth.value * (mobile.value ? 0.38 : 0.3)))
const currentRatio = computed(() => ratio.value ?? (availableWidth.value ? defaultWidth.value / availableWidth.value * 100 : 30))
const columns = computed(() => ratio.value === null ? undefined : `minmax(0, ${ratio.value}fr) 5px minmax(0, ${100 - ratio.value}fr)`)
onMounted(() => {
  observer = new ResizeObserver(() => {
    availableWidth.value = Math.max(0, pane.value.clientWidth - 5)
    mobile.value = window.matchMedia('(max-width: 720px)').matches
  })
  observer.observe(pane.value)
})
onBeforeUnmount(() => observer?.disconnect())

function resize(event) {
  if (!dragging.value) return
  const rect = pane.value.getBoundingClientRect()
  if (rect.width <= 5) return
  ratio.value = Math.max(15, Math.min(75, (event.clientX - rect.left) / (rect.width - 5) * 100))
}
function start(event) {
  if (event.button !== 0) return
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  dragging.value = true
}
function stop(event) {
  dragging.value = false
  if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
}
function resizeKey(event) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  ratio.value = event.key === 'Home' ? 15 : event.key === 'End' ? 75
    : Math.max(15, Math.min(75, currentRatio.value + (event.key === 'ArrowRight' ? 2 : -2)))
}
</script>

<template>
  <div ref="pane" class="inspector-split min-h-0 min-w-0 flex-1" :class="{ 'is-dragging': dragging }" :style="{ gridTemplateColumns: columns }">
    <slot name="list" />
    <div class="inspector-divider" role="separator" aria-orientation="vertical" :aria-label="props.label" :aria-valuenow="Math.round(currentRatio)" aria-valuemin="15" aria-valuemax="75" tabindex="0" title="拖动调整宽度，双击恢复默认" @pointerdown="start" @pointermove="resize" @pointerup="stop" @pointercancel="stop" @lostpointercapture="dragging = false" @keydown="resizeKey" @dblclick="ratio = null" />
    <slot />
  </div>
</template>

<style scoped>
.inspector-split { display: grid; grid-template-columns: min(240px, 30%) 5px minmax(0, 1fr); }
.inspector-split.is-dragging { user-select: none; }
.inspector-divider { position: relative; cursor: col-resize; touch-action: none; background: transparent; outline: none; }
.inspector-divider::after { content: ''; position: absolute; inset: 0 2px; background: var(--theme-borderDefault); }
.inspector-divider:hover::after, .inspector-divider:focus-visible::after, .is-dragging .inspector-divider::after { inset-inline: 0; background: var(--theme-accent); }
@media (max-width: 720px) { .inspector-split { grid-template-columns: min(240px, 38%) 5px minmax(0, 1fr); } }
</style>
