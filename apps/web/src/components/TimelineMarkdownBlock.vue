<script setup>
import { inject, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { renderCodexMarkdown, renderPlainCodexMarkdown } from '../lib/codexMarkdown.js'
import { workspaceLinkForHref } from '../lib/timelineWorkspaceLinks.js'
import { writeClipboardText } from '../lib/clipboard.js'
import TimelineImagePreview from './TimelineImagePreview.vue'
import { v2Api } from '../lib/v2Api.js'

defineOptions({ inheritAttrs: false })

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

const preview = ref(null)
const openVideoPreview = inject('openVideoPreview', () => {})
const html = ref('')
const contentElement = ref(null)
let renderTimer = null
let renderVersion = 0
let imageLoadController = null
const imageObjectUrls = new Set()

function releaseWorkspaceImages() {
  preview.value = null
  imageLoadController?.abort()
  imageLoadController = null
  imageObjectUrls.forEach((url) => URL.revokeObjectURL(url))
  imageObjectUrls.clear()
}

async function hydrateWorkspaceImages(version) {
  await nextTick()
  if (version !== renderVersion || !props.taskId) return

  const previews = [...(contentElement.value?.querySelectorAll('[data-workspace-image-path]') || [])]
    .filter((preview) => preview.dataset.workspaceImageState !== 'ready')
  if (!previews.length) return

  const controller = new AbortController()
  imageLoadController = controller
  await Promise.allSettled(previews.map(async (preview) => {
    const image = preview.querySelector('img')
    const status = preview.querySelector('.workspace-image-status')
    if (!image) return
    preview.dataset.workspaceImageState = 'loading'
    preview.setAttribute('role', 'status')
    preview.removeAttribute('tabindex')
    if (status) status.textContent = '图片加载中'
    try {
      const objectUrl = await (preview.dataset.localImage === '1' ? v2Api.taskLocalImageObjectUrl : v2Api.taskFileObjectUrl)(props.taskId, preview.dataset.workspaceImagePath, { signal: controller.signal })
      if (controller.signal.aborted || version !== renderVersion || !preview.isConnected) {
        URL.revokeObjectURL(objectUrl)
        return
      }
      imageObjectUrls.add(objectUrl)
      image.addEventListener('load', () => {
        if (version !== renderVersion || !preview.isConnected) return
        preview.dataset.workspaceImageState = 'ready'
        preview.removeAttribute('role')
        preview.removeAttribute('tabindex')
        emit('rendered')
      }, { once: true })
      image.addEventListener('error', () => {
        if (version !== renderVersion || !preview.isConnected) return
        imageObjectUrls.delete(objectUrl)
        URL.revokeObjectURL(objectUrl)
        preview.dataset.workspaceImageState = 'error'
        preview.setAttribute('role', 'button')
        preview.setAttribute('tabindex', '0')
        if (status) status.textContent = '图片加载失败，点击重试'
      }, { once: true })
      image.src = objectUrl
    } catch (cause) {
      if (cause?.name !== 'AbortError' && version === renderVersion && preview.isConnected) {
        preview.dataset.workspaceImageState = 'error'
        preview.setAttribute('role', 'button')
        preview.setAttribute('tabindex', '0')
        if (status) status.textContent = '图片加载失败，点击重试'
      }
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
  applyHtml(renderPlainCodexMarkdown(props.text, { workspaceCwd: props.workspaceCwd }), version, { hydrateImages: false })
  renderTimer = setTimeout(async () => {
    renderTimer = null
    try {
      const rendered = await renderCodexMarkdown(props.text, {
        isDark: props.isDark,
        copyLabel: '复制',
        copyAriaLabel: '复制代码',
        workspaceCwd: props.workspaceCwd,
      })
      if (version === renderVersion) {
        applyHtml(rendered, version)
        emit('rendered')
      }
    } catch {
      // 同步 Markdown 已经作为安全回退结果展示。
      if (version === renderVersion) void hydrateWorkspaceImages(version)
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

function openImage(target) {
  const image = target?.closest?.('img')
  if (!image || !contentElement.value?.contains(image)) return false
  const wrapper = image.closest('[data-workspace-image-state]')
  if (wrapper && wrapper.dataset.workspaceImageState !== 'ready') return false
  if (!image.complete || !image.naturalWidth) return false
  image.focus()
  preview.value = { src: image.currentSrc || image.src, alt: image.alt }
  return true
}

function handleContentClick(event) {
  if (openImage(event.target)) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  const failedImage = event.target?.closest?.('[data-workspace-image-state="error"]')
  if (failedImage) {
    event.preventDefault()
    event.stopPropagation()
    void hydrateWorkspaceImages(renderVersion)
    return
  }
  const anchor = event.target?.closest?.('a[href]')
  const videoPath = anchor?.dataset?.workspaceVideoPath
  if (anchor && videoPath) {
    event.preventDefault()
    event.stopPropagation()
    anchor.focus()
    openVideoPreview({ taskId: props.taskId, path: videoPath, label: anchor.textContent?.trim() || '视频预览' })
    return
  }
  const target = anchor && workspaceLinkForHref(anchor.getAttribute('href'), props.workspaceCwd)
  if (target) {
    event.preventDefault()
    event.stopPropagation()
    emit('open-workspace-path', target)
    return
  }
  copyCode(event)
}


function handleContentKeydown(event) {
  if (['Enter', ' '].includes(event.key) && openImage(event.target)) {
    event.preventDefault()
    return
  }
  if (!['Enter', ' '].includes(event.key) || !event.target?.matches?.('[data-workspace-image-state="error"]')) return
  event.preventDefault()
  void hydrateWorkspaceImages(renderVersion)
}

watch(() => [props.text, props.isDark, props.streaming, props.workspaceCwd, props.taskId], scheduleRender, { immediate: true })

onBeforeUnmount(() => {
  renderVersion += 1
  if (renderTimer) clearTimeout(renderTimer)
  releaseWorkspaceImages()
})
</script>

<template>
  <div v-bind="$attrs" ref="contentElement" class="prose-like codex-markdown" @click="handleContentClick" @keydown="handleContentKeydown" v-html="html" />
  <TimelineImagePreview :src="preview?.src || ''" :alt="preview?.alt || ''" @close="preview = null" />
</template>
