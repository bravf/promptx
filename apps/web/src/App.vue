<script setup>
import { CircleAlert, X } from 'lucide-vue-next'
import { onBeforeUnmount, onMounted, ref } from 'vue'
import PxIconButton from './components/PxIconButton.vue'

const globalError = ref('')
let viewportFrame = 0

function syncViewport() {
  cancelAnimationFrame(viewportFrame)
  viewportFrame = requestAnimationFrame(() => {
    const viewport = window.visualViewport
    // 双指缩放时保持布局尺寸，让浏览器正常平移和缩放。
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
    const mobile = window.matchMedia('(max-width: 720px)').matches
    const root = document.documentElement
    if (mobile && viewport) {
      root.style.setProperty('--app-viewport-height', `${viewport.height}px`)
      root.style.setProperty('--app-viewport-top', `${viewport.offsetTop}px`)
    } else {
      root.style.removeProperty('--app-viewport-height')
      root.style.removeProperty('--app-viewport-top')
    }
  })
}

function handleGlobalError(event) {
  globalError.value = String(event.detail?.message || '页面发生未知错误。')
}

function clearGlobalError() {
  globalError.value = ''
}

onMounted(() => {
  syncViewport()
  window.addEventListener('resize', syncViewport)
  window.addEventListener('pageshow', syncViewport)
  window.visualViewport?.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('scroll', syncViewport)
  window.addEventListener('promptx:global-error', handleGlobalError)
  if (window.__PROMPTX_GLOBAL_ERROR__) {
    globalError.value = window.__PROMPTX_GLOBAL_ERROR__
    delete window.__PROMPTX_GLOBAL_ERROR__
  }
  document.getElementById('app-loading-skeleton')?.remove()
})

onBeforeUnmount(() => {
  window.removeEventListener('promptx:global-error', handleGlobalError)
  window.removeEventListener('resize', syncViewport)
  window.removeEventListener('pageshow', syncViewport)
  window.visualViewport?.removeEventListener('resize', syncViewport)
  window.visualViewport?.removeEventListener('scroll', syncViewport)
  cancelAnimationFrame(viewportFrame)
  document.documentElement.style.removeProperty('--app-viewport-height')
  document.documentElement.style.removeProperty('--app-viewport-top')
})
</script>

<template>
  <div class="app-shell">
    <div v-if="globalError" class="status-float status-float-panel status-float-error fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-2xl items-start gap-2.5" role="alert">
      <CircleAlert class="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
      <span class="min-w-0 flex-1">{{ globalError }}</span>
      <PxIconButton class="h-6 w-6 shrink-0" size="sm" label="关闭错误提示" @click="clearGlobalError"><X class="h-3.5 w-3.5" /></PxIconButton>
    </div>
    <main class="app-main flex min-h-0 flex-1 overflow-hidden p-2">
      <div class="app-stage h-full min-h-0 w-full overflow-hidden">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<style scoped>
@media (max-width: 720px) {
  .app-shell {
    position: fixed;
    top: var(--app-viewport-top, 0px);
    left: 0;
    width: 100%;
    height: var(--app-viewport-height, 100dvh);
    overflow: hidden;
  }
  .app-main { padding: 0; }
}
</style>
