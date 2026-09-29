<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Music, X } from 'lucide-vue-next'
import MediaPreviewPlaceholder from './MediaPreviewPlaceholder.vue'
import PxIconButton from './PxIconButton.vue'
import { v2Api } from '../lib/v2Api.js'

const props = defineProps({ taskId: String, path: String, label: String, kind: { type: String, default: 'video' } })
const mediaLabel = computed(() => props.kind === 'audio' ? '音频' : '视频')
const emit = defineEmits(['close'])
const dialog = ref(null)
const video = ref(null)
const src = ref('')
const loading = ref(true)
const error = ref('')
const previousFocus = document.activeElement
let controller = null
let source = null

function release() {
  controller?.abort()
  if (video.value) {
    video.value.pause()
    video.value.removeAttribute('src')
    video.value.load()
  }
  source?.release()
  source = null
  src.value = ''
}
function close() {
  release()
  emit('close')
}
function handleKey(event) {
  if (event.key !== 'Escape') return
  if (document.fullscreenElement || video.value?.webkitDisplayingFullscreen) return
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
    const result = await v2Api.taskVideoSource(props.taskId, props.path, {
      signal: request.signal,
      onError: cause => {
        if (request.signal.aborted) return
        loading.value = false
        error.value = `${mediaLabel.value}加载失败：${cause.message}`
      },
    })
    if (request.signal.aborted) { result.release(); return }
    source = result
    src.value = result.url
    await nextTick()
    void video.value?.play().catch(() => {})
  } catch (cause) {
    if (!request.signal.aborted) {
      loading.value = false
      error.value = cause.message ? `${mediaLabel.value}加载失败：${cause.message}` : `${mediaLabel.value}加载失败，请重试`
    }
  }
}
watch(() => [props.taskId, props.path, props.kind], load, { immediate: true })
onMounted(() => {
  dialog.value?.focus()
  window.addEventListener('keydown', handleKey, true)
})
onBeforeUnmount(() => {
  release()
  window.removeEventListener('keydown', handleKey, true)
  if (previousFocus?.isConnected && previousFocus.getClientRects().length && !previousFocus.closest('[inert]')) previousFocus.focus()
})
</script>

<template>
  <Teleport to="body">
    <div ref="dialog" role="dialog" aria-modal="true" :aria-label="`${mediaLabel}预览`" tabindex="-1" class="video-preview-backdrop fixed inset-0 z-[60] flex items-center justify-center overflow-hidden p-4 sm:p-6" @click.self="close">
      <PxIconButton variant="secondary" class="image-preview-overlay__button absolute right-4 top-4 z-10 h-9 w-9" label="关闭预览" @click="close"><X class="h-4 w-4" /></PxIconButton>
      <MediaPreviewPlaceholder v-if="loading || error" :kind="kind" :error="error">
        <button v-if="error" class="tool-button rounded-sm px-3 py-2" @click="load">重试</button>
      </MediaPreviewPlaceholder>
      <div v-if="kind === 'audio' && src && !error" class="audio-preview-panel flex w-full max-w-lg flex-col items-center gap-5 rounded-lg border p-6">
        <Music class="h-10 w-10" />
        <p class="w-full break-all text-center text-sm">{{ label }}</p>
        <audio ref="video" crossorigin="anonymous" :src="src" :aria-label="label" controls preload="metadata" class="w-full" @loadedmetadata="loading = false" @error="loading = false; error ||= '音频无法播放，浏览器可能不支持此编码'" />
      </div>
      <video v-else-if="kind === 'video' && src" v-show="!error" ref="video" crossorigin="anonymous" :src="src" :aria-label="label" controls playsinline preload="metadata" class="max-w-full object-contain" :class="{ 'opacity-0': loading }" style="max-height: calc(100dvh - 112px)" @loadeddata="loading = false" @error="loading = false; error ||= '视频无法播放，请重试'" />
    </div>
  </Teleport>
</template>

<style scoped>
.audio-preview-panel { background: var(--theme-appPanel); color: var(--theme-textPrimary); border-color: var(--theme-borderDefault); }
.video-preview-backdrop { background: var(--theme-modalBackdrop); }
</style>
