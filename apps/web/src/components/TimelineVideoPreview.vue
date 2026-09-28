<script setup>
import { inject, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import MediaPreviewPlaceholder from './MediaPreviewPlaceholder.vue'
import PxIconButton from './PxIconButton.vue'
import { v2Api } from '../lib/v2Api.js'

const props = defineProps({ taskId: String, path: String, label: String })
const emit = defineEmits(['close'])
const timelineVisible = inject('timelineVisible', ref(true))
const dialog = ref(null)
const video = ref(null)
const src = ref('')
const loading = ref(true)
const error = ref('')
const previousFocus = document.activeElement
let controller = null

function release() {
  controller?.abort()
  if (video.value) {
    video.value.pause()
    video.value.removeAttribute('src')
    video.value.load()
  }
  if (src.value) URL.revokeObjectURL(src.value)
  src.value = ''
}
function close() {
  release()
  emit('close')
}
function handleKey(event) {
  if (event.key !== 'Escape') return
  event.preventDefault()
  event.stopImmediatePropagation()
  close()
}
async function load() {
  release()
  loading.value = true
  error.value = ''
  const request = new AbortController()
  controller = request
  try {
    const url = await v2Api.taskFileObjectUrl(props.taskId, props.path, { signal: request.signal })
    if (request.signal.aborted) { URL.revokeObjectURL(url); return }
    src.value = url
    await nextTick()
    void video.value?.play().catch(() => {})
  } catch (cause) {
    if (!request.signal.aborted) {
      loading.value = false
      error.value = '视频加载失败，请重试'
    }
  }
}
watch(() => [props.taskId, props.path], load, { immediate: true })
watch(timelineVisible, visible => { if (!visible) close() })
onMounted(() => {
  dialog.value?.focus()
  window.addEventListener('keydown', handleKey, true)
})
onBeforeUnmount(() => {
  release()
  window.removeEventListener('keydown', handleKey, true)
  if (timelineVisible.value && previousFocus?.isConnected) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div ref="dialog" role="dialog" aria-modal="true" aria-label="视频预览" tabindex="-1" class="video-preview-backdrop fixed inset-0 z-[60] flex items-center justify-center overflow-hidden p-4 sm:p-6" @click.self="close">
      <PxIconButton variant="secondary" class="image-preview-overlay__button absolute right-4 top-4 z-10 h-9 w-9" label="关闭预览" @click="close"><X class="h-4 w-4" /></PxIconButton>
      <MediaPreviewPlaceholder v-if="loading || error" kind="video" :error="error">
        <button v-if="error" class="tool-button rounded-sm px-3 py-2" @click="load">重试</button>
      </MediaPreviewPlaceholder>
      <video v-if="src" v-show="!error" ref="video" :src="src" :aria-label="label" controls playsinline preload="metadata" class="max-w-full object-contain" :class="{ 'opacity-0': loading }" style="max-height: calc(100dvh - 112px)" @loadeddata="loading = false" @error="loading = false; error = '视频无法播放，请重试'" />
    </div>
  </Teleport>
</template>

<style scoped>
.video-preview-backdrop { background: var(--theme-modalBackdrop); }
</style>
