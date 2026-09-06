<script setup>
import { ref } from 'vue'
import { FolderOpen, LoaderCircle, Search } from 'lucide-vue-next'
import PxButton from './PxButton.vue'

const props = defineProps({
  modelValue: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  open: { type: Boolean, default: false },
  suggestions: { type: Array, default: () => [] },
  error: { type: String, default: '' },
  selectedIndex: { type: Number, default: -1 },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['update:modelValue', 'input', 'keydown', 'select', 'mouseenter'])
const input = ref(null)

defineExpose({ focus: () => input.value?.focus() })
</script>

<template>
  <div class="directory-search relative shrink-0">
    <Search class="theme-muted-text pointer-events-none absolute left-3 top-1/2 z-10 h-4 w-4 -translate-y-1/2" />
    <input
      id="workspace-path"
      ref="input"
      :value="props.modelValue"
      class="tool-input w-full pl-9 pr-9 font-mono"
      placeholder="搜索目录名称或输入绝对路径"
      autocomplete="off"
      role="combobox"
      aria-controls="directory-suggestions"
      :aria-expanded="props.open"
      :aria-activedescendant="props.selectedIndex >= 0 ? `directory-suggestion-${props.selectedIndex}` : undefined"
      :disabled="props.disabled"
      @input="emit('update:modelValue', $event.target.value); emit('input', $event)"
      @keydown="emit('keydown', $event)"
    />
    <LoaderCircle v-if="props.loading" class="theme-muted-text pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin" />
    <div v-if="props.open" id="directory-suggestions" class="directory-suggestions theme-popover overflow-y-auto rounded-sm border shadow-sm" role="listbox">
      <PxButton
        v-for="(directory, index) in props.suggestions"
        :id="`directory-suggestion-${index}`"
        :key="directory.path"
        variant="ghost"
        size="sm"
        class="directory-suggestion h-auto min-h-0 w-full min-w-0 justify-start gap-2 border-0 px-3 py-2 text-left"
        :class="index === props.selectedIndex ? 'row-active' : ''"
        role="option"
        :aria-selected="index === props.selectedIndex"
        @mouseenter="emit('mouseenter', index)"
        @mousedown.prevent
        @click="emit('select', directory)"
      >
        <FolderOpen class="h-4 w-4 shrink-0" />
        <span class="min-w-0 flex-1">
          <span class="block truncate text-xs font-medium">{{ directory.name }}</span>
          <span class="theme-muted-text block truncate font-mono text-[10px]">{{ directory.path }}</span>
        </span>
      </PxButton>
      <div v-if="props.error" class="error-row m-2 rounded-sm border px-3 py-2 text-xs">{{ props.error }}</div>
      <div v-else-if="!props.loading && !props.suggestions.length" class="theme-muted-text px-3 py-5 text-center text-xs">没有找到匹配目录</div>
    </div>
  </div>
</template>

<style scoped>
.directory-suggestions {
  position: absolute;
  z-index: 30;
  top: calc(100% + 0.375rem);
  left: 0;
  right: 0;
  max-height: min(18rem, calc(100dvh - 16rem));
  background: var(--theme-appPanelStrong);
  border-color: var(--theme-borderDefault);
}
.directory-suggestion:hover { background: var(--theme-appPanelHover); }
.row-active { background: var(--theme-appPanelActive); }
</style>
