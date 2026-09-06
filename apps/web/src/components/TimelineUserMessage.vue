<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { FileText, ImageOff, LoaderCircle, RotateCw, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'
import PxButton from './PxButton.vue'
import PxIconButton from './PxIconButton.vue'

const props = defineProps({
  content: { type: Array, default: () => [] },
})

const preview = ref(null)
const previewLoading = ref(false)
const previewError = ref(false)
const assetUrls = ref({})
const assetStates = ref({})
let assetLoadVersion = 0
let assetLoadController = null
const text = computed(() => props.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
const attachments = computed(() => props.content.filter((block) => block.type !== 'text'))

function formatBytes(value) {
  const size = Number(value || 0)
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

function revokeAssetUrls() {
  Object.values(assetUrls.value).forEach((url) => URL.revokeObjectURL(url))
  assetUrls.value = {}
}

function setAssetState(assetId, state) {
  assetStates.value = { ...assetStates.value, [assetId]: state }
}

function removeAssetUrl(assetId) {
  const currentUrl = assetUrls.value[assetId]
  if (currentUrl) URL.revokeObjectURL(currentUrl)
  const nextUrls = { ...assetUrls.value }
  delete nextUrls[assetId]
  assetUrls.value = nextUrls
}

async function loadAsset(block, version = assetLoadVersion) {
  const assetId = String(block?.assetId || '')
  if (!assetId || assetStates.value[assetId] === 'loading') return
  removeAssetUrl(assetId)
  setAssetState(assetId, 'loading')
  try {
    const url = await v2Api.assetObjectUrl(assetId, { signal: assetLoadController?.signal })
    if (version !== assetLoadVersion) {
      URL.revokeObjectURL(url)
      return
    }
    assetUrls.value = { ...assetUrls.value, [assetId]: url }
    setAssetState(assetId, block.type === 'image' ? 'decoding' : 'ready')
  } catch (cause) {
    if (version === assetLoadVersion && cause?.name !== 'AbortError') setAssetState(assetId, 'error')
  }
}

function markImageReady(assetId) {
  if (assetStates.value[assetId] === 'decoding') setAssetState(assetId, 'ready')
}

function markImageError(assetId) {
  removeAssetUrl(assetId)
  setAssetState(assetId, 'error')
}

function handleImageClick(block) {
  const state = assetStates.value[block.assetId]
  if (state === 'error') {
    loadAsset(block)
    return
  }
  if (state !== 'ready') return
  preview.value = block
  previewLoading.value = true
  previewError.value = false
}

function closePreview() {
  preview.value = null
  previewLoading.value = false
  previewError.value = false
}

watch(attachments, (blocks) => {
  const version = ++assetLoadVersion
  assetLoadController?.abort()
  assetLoadController = new AbortController()
  closePreview()
  revokeAssetUrls()
  assetStates.value = {}
  const uniqueBlocks = [...new Map(blocks.filter((block) => block.assetId).map((block) => [block.assetId, block])).values()]
  uniqueBlocks.forEach((block) => loadAsset(block, version))
}, { immediate: true })

onBeforeUnmount(() => {
  assetLoadVersion += 1
  assetLoadController?.abort()
  revokeAssetUrls()
})
</script>

<template>
  <div class="user-message max-w-[85%] rounded-sm px-3 py-2 text-sm">
    <div v-if="text" class="whitespace-pre-wrap">{{ text }}</div>
    <div v-if="attachments.length" class="flex flex-wrap gap-2" :class="text ? 'mt-2' : ''">
      <PxButton
        v-for="block in attachments.filter((item) => item.type === 'image')"
        :key="block.assetId"
        variant="ghost"
        size="md"
        class="message-image relative min-h-0 overflow-hidden rounded-sm border-0 p-0"
        :data-state="assetStates[block.assetId] || 'loading'"
        :disabled="!['ready', 'error'].includes(assetStates[block.assetId])"
        :aria-busy="['loading', 'decoding'].includes(assetStates[block.assetId])"
        :title="assetStates[block.assetId] === 'error' ? `${block.name}，加载失败，点击重试` : block.name"
        @click="handleImageClick(block)"
      >
        <img
          v-if="assetUrls[block.assetId]"
          :src="assetUrls[block.assetId]"
          :alt="block.name"
          class="h-full w-full object-cover transition-opacity duration-200"
          :class="assetStates[block.assetId] === 'ready' ? 'opacity-100' : 'opacity-0'"
          @load="markImageReady(block.assetId)"
          @error="markImageError(block.assetId)"
        />
        <span v-if="['loading', 'decoding'].includes(assetStates[block.assetId])" class="message-image-status absolute inset-0 flex items-center justify-center">
          <LoaderCircle class="h-4 w-4 animate-spin" />
          <span class="sr-only">正在加载图片</span>
        </span>
        <span v-else-if="assetStates[block.assetId] === 'error'" class="message-image-status absolute inset-0 flex flex-col items-center justify-center gap-1">
          <ImageOff class="h-4 w-4" />
          <span class="flex items-center gap-1 text-[10px]"><RotateCw class="h-3 w-3" />重试</span>
        </span>
      </PxButton>
      <a v-for="block in attachments.filter((item) => item.type === 'file')" :key="block.assetId" class="message-file flex min-w-0 max-w-64 items-center gap-2 rounded-sm px-2 py-1.5" :href="assetUrls[block.assetId] || undefined" :download="block.name">
        <FileText class="h-4 w-4 shrink-0" />
        <span class="min-w-0"><span class="block truncate text-xs font-medium">{{ block.name }}</span><span class="theme-muted-text block text-[10px]">{{ formatBytes(block.size) }}</span></span>
      </a>
    </div>
  </div>

  <div v-if="preview" class="modal-backdrop fixed inset-0 z-[60] flex items-center justify-center p-6" @click.self="closePreview">
    <PxIconButton variant="secondary" class="image-preview-overlay__button absolute right-4 top-4 h-9 w-9" label="关闭预览" @click="closePreview"><X class="h-4 w-4" /></PxIconButton>
    <div v-if="previewLoading" class="theme-muted-text absolute inset-0 flex items-center justify-center gap-2 text-xs">
      <LoaderCircle class="h-4 w-4 animate-spin" />
      <span>正在加载大图</span>
    </div>
    <div v-if="previewError" class="theme-muted-text flex flex-col items-center gap-2 text-xs">
      <ImageOff class="h-6 w-6" />
      <span>图片加载失败</span>
    </div>
    <img
      v-show="!previewError"
      :src="assetUrls[preview.assetId]"
      :alt="preview.name"
      class="max-h-full max-w-full object-contain transition-opacity duration-200"
      :class="previewLoading ? 'opacity-0' : 'opacity-100'"
      @load="previewLoading = false"
      @error="previewLoading = false; previewError = true"
    />
  </div>
</template>

<style scoped>
.user-message {
  min-width: 0;
  max-width: 85%;
  overflow-wrap: anywhere;
  word-break: break-word;
  background: var(--theme-promptBg);
  color: var(--theme-promptText);
}
.message-image { width: 112px; height: 84px; background: var(--theme-appPanelInset); transition: background-color 160ms ease, opacity 160ms ease; }
.message-image:disabled { cursor: wait; }
.message-image[data-state='ready'] { cursor: zoom-in; }
.message-image[data-state='error'] { cursor: pointer; }
.message-image-status { color: var(--theme-textMuted); }
.message-file { background: var(--theme-appPanelInset); color: var(--theme-promptText); }
.modal-backdrop { background: var(--theme-modalBackdrop); }
</style>
