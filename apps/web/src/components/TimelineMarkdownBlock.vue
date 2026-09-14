<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { renderCodexMarkdown, renderPlainCodexMarkdown } from '../lib/codexMarkdown.js'
import { workspaceLinkForHref } from '../lib/timelineWorkspaceLinks.js'
import { writeClipboardText } from '../lib/clipboard.js'
import { v2Api } from '../lib/v2Api.js'

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
  taskId: {
    type: String,
    default: '',
  },
})
const emit = defineEmits(['rendered', 'open-workspace-path'])

const html = ref('')
const contentElement = ref(null)
let renderTimer = null
let renderVersion = 0
let imageLoadController = null
const imageObjectUrls = new Set()

function releaseWorkspaceImages() {
  imageLoadController?.abort()
  imageLoadController = null
  imageObjectUrls.forEach((url) => URL.revokeObjectURL(url))
  imageObjectUrls.clear()
}

async function hydrateWorkspaceImages(version) {
  await nextTick()
  if (version !== renderVersion || !props.taskId || !props.workspaceCwd) return

  const images = [...(contentElement.value?.querySelectorAll('img[src]') || [])]
    .map((image) => ({ image, target: workspaceLinkForHref(image.getAttribute('src'), props.workspaceCwd) }))
    .filter((entry) => entry.target)
  if (!images.length) return

  const controller = new AbortController()
  imageLoadController = controller
  await Promise.allSettled(images.map(async ({ image, target }) => {
    try {
      const objectUrl = await v2Api.taskFileObjectUrl(props.taskId, target.path, { signal: controller.signal })
      if (controller.signal.aborted || version !== renderVersion || !image.isConnected) {
        URL.revokeObjectURL(objectUrl)
        return
      }
      imageObjectUrls.add(objectUrl)
      image.addEventListener('load', () => emit('rendered'), { once: true })
      image.src = objectUrl
    } catch (cause) {
      if (cause?.name !== 'AbortError' && version === renderVersion) image.dataset.workspaceImageError = 'true'
    }
  }))
  if (imageLoadController === controller) imageLoadController = null
}

function applyHtml(nextHtml, version, { hydrateImages = true } = {}) {
  if (version !== renderVersion) return
  releaseWorkspaceImages()
  html.value = nextHtml
  if (hydrateImages) void hydrateWorkspaceImages(version)
}

function scheduleRender() {
  const version = ++renderVersion
  if (renderTimer) clearTimeout(renderTimer)
  applyHtml(renderPlainCodexMarkdown(props.text), version, { hydrateImages: false })
  renderTimer = setTimeout(async () => {
    renderTimer = null
    try {
      const rendered = await renderCodexMarkdown(props.text, {
        isDark: props.isDark,
        copyLabel: '复制',
        copyAriaLabel: '复制代码',
      })
      if (version === renderVersion) {
        applyHtml(rendered, version)
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

watch(() => [props.text, props.isDark, props.streaming, props.workspaceCwd, props.taskId], scheduleRender, { immediate: true })

onBeforeUnmount(() => {
  renderVersion += 1
  if (renderTimer) clearTimeout(renderTimer)
  releaseWorkspaceImages()
})
</script>

<template>
  <div ref="contentElement" class="prose-like codex-markdown" @click="handleContentClick" v-html="html" />
</template>
