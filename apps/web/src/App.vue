<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { Sparkles } from 'lucide-vue-next'
import ThemeToggle from './components/ThemeToggle.vue'

const route = useRoute()
const isEditorRoute = computed(() => route.name === 'editor')
const shellWidthClass = computed(() => (
  route.name === 'home' || route.name === 'public'
    ? 'w-full max-w-none'
    : 'max-w-6xl'
))
</script>

<template>
  <div
    class="flex min-h-screen flex-col bg-stone-100 text-stone-900 transition-colors dark:bg-stone-950 dark:text-stone-100"
    :class="isEditorRoute ? 'h-dvh overflow-hidden' : ''"
  >
    <header
      v-if="!isEditorRoute"
      class="border-b border-stone-300 bg-stone-100/90 backdrop-blur dark:border-stone-800 dark:bg-stone-950/90"
    >
      <div
        class="mx-auto flex items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8"
        :class="shellWidthClass"
      >
        <RouterLink to="/" class="inline-flex items-center gap-2 font-mono text-sm font-medium uppercase tracking-[0.2em] text-stone-600 dark:text-stone-400">
          <span class="inline-flex h-8 w-8 items-center justify-center rounded-sm border border-dashed border-stone-300 bg-stone-50 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200">
            <Sparkles class="h-4 w-4" />
          </span>
          <span>PromptX</span>
        </RouterLink>
        <ThemeToggle />
      </div>
    </header>

    <main
      class="mx-auto flex-1 px-4 py-6 sm:px-6 lg:px-8"
      :class="isEditorRoute ? 'flex min-h-0 w-full max-w-none overflow-hidden px-3 py-3 sm:px-4 sm:py-4 lg:px-4 lg:py-4' : shellWidthClass"
    >
      <div :class="isEditorRoute ? 'h-full min-h-0 w-full overflow-hidden' : 'w-full'">
        <RouterView />
      </div>
    </main>
  </div>
</template>
