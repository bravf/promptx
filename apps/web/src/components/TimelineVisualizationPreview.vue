<script setup>
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'
import PxIconButton from './PxIconButton.vue'
import TimelineVisualizationContent from './TimelineVisualizationContent.vue'

const props = defineProps({ preview: { type: Object, default: null } })
const emit = defineEmits(['close'])
const dialog = ref(null)
const mode = ref('preview')
let previousFocus = null
function handleKey(event) {
  if (!props.preview) return
  if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); emit('close'); return }
  if (event.key !== 'Tab') return
  const elements = [...(dialog.value?.querySelectorAll('button:not(:disabled), iframe, pre[tabindex]') || [])].filter(el => el.getClientRects().length)
  const index = elements.indexOf(document.activeElement)
  if ((event.shiftKey && index <= 0) || (!event.shiftKey && index === elements.length - 1)) {
    event.preventDefault(); elements[event.shiftKey ? elements.length - 1 : 0]?.focus()
  }
}
watch(() => props.preview, async (preview, previous) => {
  if (preview) {
    if (!previous) previousFocus = document.activeElement
    mode.value = preview.mode || 'preview'
    window.addEventListener('keydown', handleKey, true)
    await nextTick(); dialog.value?.focus({ preventScroll: true })
  } else window.removeEventListener('keydown', handleKey, true)
})
function restoreFocus() {
  if (props.preview) return
  if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
onBeforeUnmount(() => window.removeEventListener('keydown', handleKey, true))
</script>

<template>
  <Teleport to="body">
    <Transition name="visualization-drawer" @after-leave="restoreFocus">
      <section v-if="preview" ref="dialog" class="panel visualization-dialog fixed inset-0 z-[60] flex min-h-0 min-w-0 flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="图表预览" tabindex="-1">
        <header class="flex h-14 shrink-0 items-center gap-2 border-b px-3">
          <h2 class="theme-heading min-w-0 flex-1 truncate text-sm font-medium">{{ preview.title }}</h2>
          <PxIconButton label="关闭图表预览" @click="emit('close')"><X class="h-4 w-4" /></PxIconButton>
        </header>
        <TimelineVisualizationContent :key="JSON.stringify([preview.taskId, preview.path])" :task-id="preview.taskId" :path="preview.path" :title="preview.title" v-model:mode="mode" @escape="emit('close')" />
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.visualization-dialog { background: var(--theme-appPanel); color: var(--theme-textPrimary); height: 100dvh; border-radius: 0; }
.visualization-drawer-enter-active { transition: transform 240ms cubic-bezier(0.22, 1, 0.36, 1), opacity 180ms ease; }
.visualization-drawer-leave-active { transition: transform 180ms ease-in, opacity 150ms ease; pointer-events: none; }
.visualization-drawer-enter-from, .visualization-drawer-leave-to { transform: translateX(100%); opacity: 0.35; }
@media (prefers-reduced-motion: reduce) {
  .visualization-drawer-enter-active, .visualization-drawer-leave-active { transition: none; }
}
</style>
