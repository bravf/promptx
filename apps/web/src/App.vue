<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'

const globalError = ref('')

function handleGlobalError(event) {
  globalError.value = String(event.detail?.message || '页面发生未知错误。')
}

function clearGlobalError() {
  globalError.value = ''
}

onMounted(() => {
  window.addEventListener('promptx:global-error', handleGlobalError)
  if (window.__PROMPTX_GLOBAL_ERROR__) {
    globalError.value = window.__PROMPTX_GLOBAL_ERROR__
    delete window.__PROMPTX_GLOBAL_ERROR__
  }
  document.getElementById('app-loading-skeleton')?.remove()
})

onBeforeUnmount(() => window.removeEventListener('promptx:global-error', handleGlobalError))
</script>

<template>
  <div class="app-shell">
    <div v-if="globalError" class="global-error theme-modal-backdrop fixed inset-x-3 top-3 z-[100] mx-auto flex max-w-2xl items-start gap-3 rounded-sm border px-3 py-2 text-xs" role="alert">
      <span class="min-w-0 flex-1">{{ globalError }}</span>
      <button type="button" class="quiet-icon-button h-5 w-5 shrink-0" title="关闭错误提示" aria-label="关闭错误提示" @click="clearGlobalError">×</button>
    </div>
    <main class="app-main flex min-h-0 flex-1 overflow-hidden px-3 py-3 sm:px-4 sm:py-4 lg:px-4 lg:py-4">
      <div class="app-stage h-full min-h-0 w-full overflow-hidden">
        <RouterView />
      </div>
    </main>
  </div>
</template>

<style scoped>
.global-error { border-color: var(--theme-danger); background: var(--theme-dangerSoft); color: var(--theme-dangerText); box-shadow: var(--theme-shadowPopover); }
@media (max-width: 720px) {
  .app-main { padding: 0; }
}
</style>
