<script setup>
import { MoreHorizontal } from 'lucide-vue-next'
import { nextTick, onBeforeUnmount, ref, watch } from 'vue'
import PxIconButton from './PxIconButton.vue'

const props = defineProps({
  label: { type: String, default: '更多操作' },
  items: { type: Array, default: () => [] },
})
const emit = defineEmits(['select'])
const open = ref(false)
const activeIndex = ref(-1)
const trigger = ref(null)
const menu = ref(null)
const menuStyle = ref({})

function triggerElement() {
  return trigger.value?.$el || trigger.value
}

function enabledIndexes() {
  return props.items.map((item, index) => ({ item, index }))
    .filter(({ item }) => !item.separator && !item.disabled)
    .map(({ index }) => index)
}

function positionMenu() {
  const rect = triggerElement()?.getBoundingClientRect()
  if (!rect) return
  const width = 176
  const estimatedHeight = props.items.filter((item) => !item.separator).length * 36 + 16
  const opensUp = rect.bottom + estimatedHeight > window.innerHeight - 8 && rect.top > estimatedHeight
  menuStyle.value = {
    width: `${width}px`,
    left: `${Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8))}px`,
    ...(opensUp ? { bottom: `${window.innerHeight - rect.top + 4}px` } : { top: `${rect.bottom + 4}px` }),
  }
}

function openMenu() {
  open.value = true
  activeIndex.value = enabledIndexes()[0] ?? -1
  nextTick(positionMenu)
}

function closeMenu({ focus = true } = {}) {
  open.value = false
  if (focus) triggerElement()?.focus()
}

function choose(item) {
  if (item.disabled || item.separator) return
  closeMenu({ focus: false })
  emit('select', item.id)
}

function move(delta) {
  const indexes = enabledIndexes()
  if (!indexes.length) return
  const current = indexes.indexOf(activeIndex.value)
  activeIndex.value = indexes[(current + delta + indexes.length) % indexes.length]
}

function onKeydown(event) {
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault()
      openMenu()
    }
    return
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
  else if (event.key === 'Home') { event.preventDefault(); activeIndex.value = enabledIndexes()[0] ?? -1 }
  else if (event.key === 'End') { event.preventDefault(); activeIndex.value = enabledIndexes().at(-1) ?? -1 }
  else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); choose(props.items[activeIndex.value] || {}) }
  else if (event.key === 'Escape') { event.preventDefault(); closeMenu() }
}

function onDocumentPointerdown(event) {
  if (!open.value || triggerElement()?.contains(event.target) || menu.value?.contains(event.target)) return
  closeMenu({ focus: false })
}

watch(open, (value) => {
  if (value) {
    document.addEventListener('pointerdown', onDocumentPointerdown)
    window.addEventListener('resize', positionMenu)
    window.addEventListener('scroll', positionMenu, true)
  } else {
    document.removeEventListener('pointerdown', onDocumentPointerdown)
    window.removeEventListener('resize', positionMenu)
    window.removeEventListener('scroll', positionMenu, true)
  }
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', onDocumentPointerdown)
  window.removeEventListener('resize', positionMenu)
  window.removeEventListener('scroll', positionMenu, true)
})
</script>

<template>
  <div class="inline-flex shrink-0">
    <PxIconButton ref="trigger" class="h-7 w-7" :label="label" :aria-expanded="open" aria-haspopup="menu"
      @click.stop="open ? closeMenu() : openMenu()" @keydown="onKeydown">
      <MoreHorizontal class="h-4 w-4" />
    </PxIconButton>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="action-menu fixed z-[130] rounded-sm border p-1 shadow-sm" :style="menuStyle" role="menu">
        <template v-for="(item, index) in items" :key="item.id || `separator-${index}`">
          <div v-if="item.separator" class="action-menu-separator my-1 border-t" role="separator" />
          <button v-else type="button" class="action-menu-item flex h-9 w-full items-center gap-2 rounded-sm px-2.5 text-left text-xs"
            :class="[{ 'is-active': activeIndex === index, 'is-danger': item.danger }]" :disabled="item.disabled"
            role="menuitem" @mouseenter="activeIndex = index" @click="choose(item)">
            <component :is="item.icon" v-if="item.icon" class="h-3.5 w-3.5 shrink-0" />
            <span class="min-w-0 flex-1 truncate">{{ item.label }}</span>
          </button>
        </template>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.action-menu { border-color: var(--theme-borderDefault); background: var(--theme-appPanelStrong); color: var(--theme-textPrimary); box-shadow: var(--theme-shadowPopover); }
.action-menu-separator { border-color: var(--theme-borderMuted); }
.action-menu-item:hover:not(:disabled), .action-menu-item.is-active:not(:disabled) { background: var(--theme-appPanelActive); }
.action-menu-item.is-danger { color: var(--theme-dangerText); }
.action-menu-item:disabled { cursor: not-allowed; opacity: 0.45; }
</style>
