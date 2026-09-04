<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  backdropClass: {
    type: String,
    default: '',
  },
  stackLevel: {
    type: Number,
    default: 0,
  },
  panelClass: {
    type: String,
    default: '',
  },
  headerClass: {
    type: String,
    default: 'px-4 py-4 sm:px-5',
  },
  bodyClass: {
    type: String,
    default: 'min-h-0 flex-1',
  },
  showClose: {
    type: Boolean,
    default: true,
  },
  closeDisabled: {
    type: Boolean,
    default: false,
  },
  closeOnBackdrop: {
    type: Boolean,
    default: true,
  },
  closeOnEscape: {
    type: Boolean,
    default: true,
  },
  lockBodyScroll: {
    type: Boolean,
    default: true,
  },
})

const emit = defineEmits(['close'])
const panelRef = ref(null)
let previouslyFocusedElement = null

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

const resolvedBackdropClass = computed(() => {
  if (props.backdropClass) {
    return props.backdropClass
  }

  const layoutClass = 'items-end justify-center px-0 py-0 sm:items-center sm:px-4 sm:py-6'
  const zIndexClass = props.stackLevel >= 4
    ? 'z-[90]'
    : props.stackLevel === 3
      ? 'z-[75]'
      : props.stackLevel === 2
        ? 'z-[70]'
        : props.stackLevel === 1
          ? 'z-[60]'
          : 'z-50'

  return `${zIndexClass} ${layoutClass}`
})

function requestClose() {
  if (props.closeDisabled) {
    return
  }

  emit('close')
}

function handleBackdropClick() {
  if (!props.closeOnBackdrop || props.closeDisabled) {
    return
  }

  emit('close')
}

function handleKeydown(event) {
  if (!props.open) {
    return
  }

  if (event.target && !panelRef.value?.contains(event.target)) {
    return
  }

  if (event.key === 'Escape') {
    if (!props.closeOnEscape || props.closeDisabled) return
    emit('close')
    return
  }

  if (event.key !== 'Tab') return
  const focusable = [...(panelRef.value?.querySelectorAll(FOCUSABLE_SELECTOR) || [])]
  if (!focusable.length) {
    event.preventDefault()
    panelRef.value?.focus()
    return
  }
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

watch(
  () => props.open,
  (open) => {
    if (props.lockBodyScroll) {
      document.body.classList.toggle('overflow-hidden', open)
    }

    if (open) {
      previouslyFocusedElement = document.activeElement
      window.addEventListener('keydown', handleKeydown)
      nextTick(() => {
        const target = panelRef.value?.querySelector(FOCUSABLE_SELECTOR) || panelRef.value
        target?.focus?.()
      })
      return
    }

    window.removeEventListener('keydown', handleKeydown)
    if (previouslyFocusedElement?.isConnected) previouslyFocusedElement.focus()
    previouslyFocusedElement = null
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (props.lockBodyScroll) {
    document.body.classList.remove('overflow-hidden')
  }

  window.removeEventListener('keydown', handleKeydown)
})
</script>

<template>
  <Teleport to="body">
    <Transition name="dialog-shell">
      <div
        v-if="open"
        class="theme-modal-backdrop dialog-shell-backdrop fixed inset-0 flex"
        :class="resolvedBackdropClass"
        @click.self="handleBackdropClick"
      >
        <section ref="panelRef" class="panel dialog-shell-panel flex min-h-0 w-full flex-col overflow-hidden" :class="panelClass" role="dialog" aria-modal="true" tabindex="-1">
          <div
            v-if="$slots.title || $slots.header || $slots['header-actions'] || showClose"
            class="theme-divider flex items-center justify-between gap-4 border-b"
            :class="headerClass"
          >
            <div class="min-w-0 flex-1">
              <slot name="header">
                <slot name="title" />
              </slot>
            </div>

            <div v-if="$slots['header-actions'] || showClose" class="flex items-center gap-2">
              <slot name="header-actions" />
              <button
                v-if="showClose"
                type="button"
                class="theme-icon-button h-8 w-8 shrink-0"
                title="关闭"
                aria-label="关闭"
                :disabled="closeDisabled"
                @click="requestClose"
              >
                <X class="h-4 w-4" />
              </button>
            </div>
          </div>

          <div :class="bodyClass">
            <slot />
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>
