<script setup>
import { computed } from 'vue'
import { Check } from 'lucide-vue-next'
import { useTheme } from '../composables/useTheme.js'

const { currentTheme, setTheme, themes } = useTheme()

const themeGroups = computed(() => {
  const light = themes.value.filter((theme) => theme.mode === 'light')
  const dark = themes.value.filter((theme) => theme.mode === 'dark')
  return [
    { id: 'light', label: '浅色', items: light },
    { id: 'dark', label: '深色', items: dark },
  ].filter((group) => group.items.length)
})

function handleThemeSelect(themeId) {
  setTheme(themeId)
}

</script>

<template>
  <div class="space-y-4">
    <div>
      <div class="flex items-center justify-between gap-3">
        <div class="theme-heading text-sm font-medium">界面主题</div>
        <div class="theme-toggle-current theme-badge-muted theme-muted-text rounded-sm border border-dashed px-2 py-1 text-[11px]">
          当前：{{ currentTheme.shortName }}
        </div>
      </div>
      <div class="theme-muted-text theme-note-text mt-1">主题会立即应用并保存在当前浏览器。</div>
    </div>

    <div class="space-y-4">
      <section v-for="group in themeGroups" :key="group.id" class="space-y-1.5">
        <div class="theme-muted-text px-1 text-[10px] font-medium uppercase tracking-[0.16em]">{{ group.label }}</div>
        <button
          v-for="theme in group.items"
          :key="theme.id"
          type="button"
          class="theme-option theme-toggle-card flex w-full items-start gap-3 rounded-sm border px-3 py-3 text-left"
          :class="theme.id === currentTheme.id ? 'theme-option-active' : 'theme-option-idle'"
          @click="handleThemeSelect(theme.id)"
        >
          <div class="mt-0.5 flex shrink-0 items-center gap-1.5">
            <span
              v-for="(swatch, index) in theme.swatches"
              :key="`${theme.id}-${index}`"
              class="h-3 w-3 rounded-full border border-black/10"
              :style="{ backgroundColor: swatch }"
            />
          </div>
          <div class="min-w-0 flex-1">
            <div class="flex items-center justify-between gap-2">
              <span class="truncate text-sm font-medium">{{ theme.shortName }}</span>
              <Check v-if="theme.id === currentTheme.id" class="h-4 w-4 shrink-0" />
            </div>
            <div class="theme-muted-text theme-note-text mt-1">{{ theme.description }}</div>
          </div>
        </button>
      </section>
    </div>
  </div>
</template>
