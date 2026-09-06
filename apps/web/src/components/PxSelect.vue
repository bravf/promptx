<script setup>
import { Check, ChevronDown } from 'lucide-vue-next'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  id: { type: String, default: '' },
  modelValue: { type: [String, Number], default: '' },
  options: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' },
  ariaLabel: { type: String, default: '' },
  size: { type: String, default: 'md' },
  tone: { type: String, default: 'default' },
})
const emit = defineEmits(['update:modelValue', 'change'])
const open = ref(false)
const activeIndex = ref(-1)
const internalValue = ref(props.modelValue)
const trigger = ref(null)
const menu = ref(null)
const menuStyle = ref({})
const selected = computed(() => props.options.find((option) => String(option.value) === String(internalValue.value)))

function enabledOptions() { return props.options.map((option, index) => ({ option, index })).filter(({ option }) => !option.disabled) }
function firstEnabled() { return enabledOptions()[0]?.index ?? -1 }
function lastEnabled() { const values = enabledOptions(); return values[values.length - 1]?.index ?? -1 }
function positionMenu() {
  const rect = trigger.value?.getBoundingClientRect()
  if (!rect) return
  const maxHeight = Math.min(320, Math.max(160, window.innerHeight - rect.bottom - 12))
  const opensUp = rect.bottom + maxHeight > window.innerHeight - 8 && rect.top > maxHeight
  menuStyle.value = {
    minWidth: `${Math.max(rect.width, 144)}px`,
    maxHeight: `${maxHeight}px`,
    left: `${Math.min(rect.left, Math.max(8, window.innerWidth - Math.max(rect.width, 144) - 8))}px`,
    ...(opensUp ? { bottom: `${window.innerHeight - rect.top + 6}px` } : { top: `${rect.bottom + 6}px` }),
  }
}
function openMenu() {
  if (props.disabled) return
  open.value = true
  activeIndex.value = selected.value ? props.options.indexOf(selected.value) : firstEnabled()
  nextTick(() => { positionMenu(); menu.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }) })
}
function closeMenu() { open.value = false; trigger.value?.focus() }
function choose(option) {
  if (option.disabled) return
  internalValue.value = option.value
  emit('update:modelValue', option.value)
  emit('change', option.value)
  closeMenu()
}
function move(delta) {
  const options = enabledOptions().map(({ index }) => index)
  if (!options.length) return
  const current = options.indexOf(activeIndex.value)
  activeIndex.value = options[(current + delta + options.length) % options.length]
  nextTick(() => menu.value?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' }))
}
function onTriggerKeydown(event) {
  if (!open.value) {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) { event.preventDefault(); openMenu() }
    return
  }
  if (event.key === 'ArrowDown') { event.preventDefault(); move(1) }
  else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1) }
  else if (event.key === 'Home') { event.preventDefault(); activeIndex.value = firstEnabled() }
  else if (event.key === 'End') { event.preventDefault(); activeIndex.value = lastEnabled() }
  else if (['Enter', ' '].includes(event.key)) { event.preventDefault(); const option = props.options[activeIndex.value]; if (option) choose(option) }
  else if (event.key === 'Escape') { event.preventDefault(); closeMenu() }
}
function onDocumentPointerdown(event) {
  if (!open.value || trigger.value?.contains(event.target) || menu.value?.contains(event.target)) return
  open.value = false
}
watch(() => props.modelValue, (value) => { internalValue.value = value })
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
  <div class="px-select relative min-w-0" :class="[`px-select-${props.size}`, `px-select-${props.tone}`]">
    <button :id="props.id || undefined" ref="trigger" type="button" class="px-select-trigger flex w-full min-w-0 items-center gap-2 text-left" :disabled="props.disabled" :aria-label="props.ariaLabel || undefined" :aria-expanded="open" aria-haspopup="listbox" @click="open ? closeMenu() : openMenu()" @keydown="onTriggerKeydown">
      <span class="min-w-0 flex-1 truncate">{{ selected?.label || props.placeholder }}</span>
      <ChevronDown class="h-3.5 w-3.5 shrink-0 transition-transform" :class="open ? 'rotate-180' : ''" aria-hidden="true" />
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menu" class="px-select-menu fixed z-[120] overflow-y-auto rounded-sm border p-1" :style="menuStyle" role="listbox">
        <button v-for="(option, index) in props.options" :key="String(option.value)" type="button" class="px-select-option flex w-full items-center gap-2 rounded-sm px-2.5 py-2 text-left text-xs" :class="[index === activeIndex ? 'is-active' : '', option.disabled ? 'is-disabled' : '']" :data-active="index === activeIndex ? 'true' : undefined" role="option" :aria-selected="String(option.value) === String(internalValue)" :disabled="option.disabled" @mouseenter="activeIndex = index" @click="choose(option)">
          <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
          <Check v-if="String(option.value) === String(internalValue)" class="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
        </button>
      </div>
    </Teleport>
  </div>
</template>
