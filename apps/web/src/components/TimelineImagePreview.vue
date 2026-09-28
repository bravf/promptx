<script setup>
import { inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import MediaPreviewPlaceholder from './MediaPreviewPlaceholder.vue'
import PxIconButton from './PxIconButton.vue'
import { useImageZoom } from '../composables/useImageZoom.js'

const props = defineProps({ src: { type: String, default: '' }, alt: { type: String, default: '' } })
const emit = defineEmits(['close'])
const timelineVisible = inject('timelineVisible', ref(true))
const previewElement = ref(null)
const previewLoading = ref(false)
const previewError = ref(false)
const { zoom, offset, resetTransform, handleWheel, startPointer, movePointer, endPointer } = useImageZoom(previewElement, previewLoading, previewError)
let previousFocus = null
function closePreview() { emit('close') }
function handleKey(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  closePreview()
}
function restoreFocus() {
  if (timelineVisible.value && previousFocus?.isConnected) previousFocus.focus()
  previousFocus = null
}
watch(() => props.src, async src => {
  resetTransform()
  previewLoading.value = Boolean(src)
  previewError.value = false
  if (src) {
    previousFocus ||= document.activeElement
    window.addEventListener('keydown', handleKey, true)
    await nextTick()
    previewElement.value?.focus()
  } else {
    window.removeEventListener('keydown', handleKey, true)
    restoreFocus()
  }
}, { immediate: true })
watch(timelineVisible, visible => { if (!visible) closePreview() })
onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleKey, true)
  restoreFocus()
})
</script>

<template>
  <Teleport to="body">
  <div v-if="src" ref="previewElement" role="dialog" aria-modal="true" aria-label="图片预览" tabindex="-1" class="modal-backdrop fixed inset-0 z-[60] flex items-center justify-center overflow-hidden p-6" @wheel.prevent="handleWheel" @click.self="closePreview">
    <PxIconButton variant="secondary" class="image-preview-overlay__button absolute right-4 top-4 z-10 h-9 w-9" label="关闭预览" @click="closePreview"><X class="h-4 w-4" /></PxIconButton>
    <MediaPreviewPlaceholder v-if="previewLoading || previewError" :error="previewError ? '图片加载失败，请关闭后重试' : ''" />
    <img
      v-if="src"
      :key="src"
      v-show="!previewError"
      :src="src"
      :alt="alt"
      class="max-h-full max-w-full touch-none select-none object-contain transition-opacity duration-200"
      :style="{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`, cursor: zoom > 1 ? 'grab' : 'zoom-in' }"
      draggable="false"
      @pointerdown.prevent="startPointer"
      @pointermove.prevent="movePointer"
      @pointerup="endPointer"
      @pointercancel="endPointer"
      @lostpointercapture="endPointer"
      @dblclick.prevent="resetTransform"
      :class="previewLoading ? 'opacity-0' : 'opacity-100'"
      @load="previewLoading = false"
      @error="previewLoading = false; previewError = true"
    />
  </div>
  </Teleport>
</template>

<style scoped>
.modal-backdrop { background: var(--theme-modalBackdrop); }
</style>
