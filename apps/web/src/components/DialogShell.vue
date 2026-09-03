<script setup>
import { computed, onBeforeUnmount, watch } from 'vue'
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
  if (!props.open || !props.closeOnEscape || props.closeDisabled) {
    return
  }

  if (event.key === 'Escape') {
    emit('close')
  }
}

watch(
  () => props.open,
  (open) => {
    if (props.lockBodyScroll) {
      document.body.classList.toggle('overflow-hidden', open)
    }

    if (open && props.closeOnEscape) {
      window.addEventListener('keydown', handleKeydown)
      return
    }

    window.removeEventListener('keydown', handleKeydown)
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
        <section class="panel dialog-shell-panel flex min-h-0 w-full flex-col overflow-hidden" :class="panelClass">
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
