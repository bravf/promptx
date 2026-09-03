<script setup>
import { computed, ref } from 'vue'
import { FileText, X } from 'lucide-vue-next'
import { v2Api } from '../lib/v2Api.js'

const props = defineProps({
  content: { type: Array, default: () => [] },
})

const preview = ref(null)
const text = computed(() => props.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
const attachments = computed(() => props.content.filter((block) => block.type !== 'text'))

function formatBytes(value) {
  const size = Number(value || 0)
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`
  return `${(size / 1024 / 1024).toFixed(size >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}
</script>

<template>
  <div class="user-message max-w-[85%] rounded-sm px-3 py-2 text-sm">
    <div v-if="text" class="whitespace-pre-wrap">{{ text }}</div>
    <div v-if="attachments.length" class="flex flex-wrap gap-2" :class="text ? 'mt-2' : ''">
      <button v-for="block in attachments.filter((item) => item.type === 'image')" :key="block.assetId" type="button" class="message-image overflow-hidden rounded-sm" :title="block.name" @click="preview = block">
        <img :src="v2Api.assetContentUrl(block.assetId)" :alt="block.name" class="h-full w-full object-cover" />
      </button>
      <a v-for="block in attachments.filter((item) => item.type === 'file')" :key="block.assetId" class="message-file flex min-w-0 max-w-64 items-center gap-2 rounded-sm px-2 py-1.5" :href="v2Api.assetContentUrl(block.assetId)" target="_blank" rel="noopener">
        <FileText class="h-4 w-4 shrink-0" />
        <span class="min-w-0"><span class="block truncate text-xs font-medium">{{ block.name }}</span><span class="theme-muted-text block text-[10px]">{{ formatBytes(block.size) }}</span></span>
      </a>
    </div>
  </div>

  <div v-if="preview" class="modal-backdrop fixed inset-0 z-[60] flex items-center justify-center p-6" @click.self="preview = null">
    <button type="button" class="tool-button absolute right-4 top-4 h-9 w-9" title="关闭预览" @click="preview = null"><X class="h-4 w-4" /></button>
    <img :src="v2Api.assetContentUrl(preview.assetId)" :alt="preview.name" class="max-h-full max-w-full object-contain" />
  </div>
</template>

<style scoped>
.user-message { background: var(--theme-promptBg); color: var(--theme-promptText); }
.message-image { width: 112px; height: 84px; background: var(--theme-appPanelInset); }
.message-file { background: var(--theme-appPanelInset); color: var(--theme-promptText); }
.modal-backdrop { background: var(--theme-modalBackdrop); }
</style>
