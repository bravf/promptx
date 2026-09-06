<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { Check, Copy } from 'lucide-vue-next'
import { formatMessageDateTime, formatMessageTime } from '../lib/timelinePresentation.js'
import { writeClipboardText } from '../lib/clipboard.js'
import PxIconButton from './PxIconButton.vue'

const props = defineProps({
  text: { type: String, default: '' },
  timestamp: { type: String, default: '' },
  align: { type: String, default: 'left' },
})

const copied = ref(false)
let copiedTimer = null
const shortTime = computed(() => formatMessageTime(props.timestamp))
const fullTime = computed(() => formatMessageDateTime(props.timestamp))

async function copyMessage() {
  if (!props.text) return
  try {
    await writeClipboardText(props.text)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { copied.value = false }, 1200)
  } catch {
    copied.value = false
  }
}

onBeforeUnmount(() => clearTimeout(copiedTimer))
</script>

<template>
  <div class="message-meta theme-muted-text mt-1 flex h-6 items-center gap-1 text-[10px]" :class="align === 'right' ? 'justify-end' : 'justify-start'">
    <PxIconButton class="theme-icon-button h-6 w-6" :label="copied ? '已复制' : '复制消息'" @click="copyMessage">
      <Check v-if="copied" class="h-3 w-3" />
      <Copy v-else class="h-3 w-3" />
    </PxIconButton>
    <time v-if="shortTime" :datetime="timestamp" :title="fullTime">{{ shortTime }}</time>
  </div>
</template>

<style scoped>
.message-meta { opacity: 0; transition: opacity 120ms ease; }
.timeline-message:hover .message-meta,
.timeline-message:focus-within .message-meta { opacity: 1; }
@media (hover: none) { .message-meta { opacity: 1; } }
</style>
