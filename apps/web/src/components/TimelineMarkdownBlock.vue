<script setup>
import { onBeforeUnmount, ref, watch } from 'vue'
import { renderCodexMarkdown, renderPlainCodexMarkdown } from '../lib/codexMarkdown.js'
import { workspaceLinkForHref } from '../lib/timelineWorkspaceLinks.js'
import { writeClipboardText } from '../lib/clipboard.js'

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
  workspaceCwd: {
    type: String,
    default: '',
  },
})
const emit = defineEmits(['rendered', 'open-workspace-path'])

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

function handleContentClick(event) {
  const anchor = event.target?.closest?.('a[href]')
  const target = anchor && workspaceLinkForHref(anchor.getAttribute('href'), props.workspaceCwd)
  if (target) {
    event.preventDefault()
    event.stopPropagation()
    emit('open-workspace-path', target)
    return
  }
  copyCode(event)
}

watch(() => [props.text, props.isDark, props.streaming], scheduleRender, { immediate: true })

onBeforeUnmount(() => {
  renderVersion += 1
  if (renderTimer) clearTimeout(renderTimer)
})
</script>

<template>
  <div class="prose-like codex-markdown" @click="handleContentClick" v-html="html" />
</template>
