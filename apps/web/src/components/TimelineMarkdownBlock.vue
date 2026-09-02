<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { renderCodexMarkdown, renderPlainCodexMarkdown } from '../lib/codexMarkdown.js'

const props = defineProps({
  text: {
    type: String,
    default: '',
  },
  isDark: {
    type: Boolean,
    default: false,
  },
  streaming: {
    type: Boolean,
    default: false,
  },
})
const emit = defineEmits(['rendered'])

const html = ref('')
let renderTimer = null
let renderVersion = 0

function scheduleRender() {
  const version = ++renderVersion
  if (renderTimer) clearTimeout(renderTimer)
  html.value = renderPlainCodexMarkdown(props.text)
  renderTimer = setTimeout(async () => {
    renderTimer = null
    try {
      const rendered = await renderCodexMarkdown(props.text, {
        isDark: props.isDark,
        copyLabel: '复制',
        copyAriaLabel: '复制代码',
      })
      if (version === renderVersion) {
        html.value = rendered
        emit('rendered')
      }
    } catch {
      // 同步 Markdown 已经作为安全回退结果展示。
    }
  }, props.streaming ? 180 : 0)
}

async function writeClipboardText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', '')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  document.body.appendChild(textarea)
  textarea.select()
  const copied = document.execCommand('copy')
  textarea.remove()
  if (!copied) throw new Error('copy_failed')
}

async function copyCode(event) {
  const button = event.target?.closest?.('[data-copy-code="1"]')
  if (!button) return
  const code = button.closest('.codex-code-block')?.querySelector('pre code')?.textContent?.replace(/\u200b/g, '')
  if (!code) return

  event.preventDefault()
  event.stopPropagation()
  try {
    await writeClipboardText(code)
    button.textContent = '已复制'
    setTimeout(() => {
      if (button.isConnected) button.textContent = '复制'
    }, 1200)
  } catch {
    button.textContent = '复制失败'
  }
}

watch(() => [props.text, props.isDark, props.streaming], scheduleRender, { immediate: true })

onBeforeUnmount(() => {
  renderVersion += 1
  if (renderTimer) clearTimeout(renderTimer)
})
</script>

<template>
  <div class="prose-like codex-markdown" @click="copyCode" v-html="html" />
</template>
