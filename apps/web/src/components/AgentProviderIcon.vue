<script setup>
import { computed } from 'vue'
import claude from '../assets/providers/claude.svg?raw'
import codex from '../assets/providers/codex.svg?raw'
import grok from '../assets/providers/grok.svg?raw'
import kimi from '../assets/providers/kimi.svg?raw'

const props = defineProps({
  providerId: { type: String, default: '' },
  label: { type: String, default: '' },
})
const icons = { claude, codex, grok, kimi }
const icon = computed(() => icons[props.providerId])
const name = computed(() => props.label || props.providerId || 'Agent')
</script>

<template>
  <span class="agent-provider-icon inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center" role="img" :aria-label="name" :title="name">
    <!-- 仅渲染随应用打包的静态 SVG，不接受用户或接口返回的 HTML。 -->
    <span v-if="icon" class="provider-symbol h-full w-full" aria-hidden="true" v-html="icon" />
    <span v-else class="text-[10px] font-semibold leading-none" aria-hidden="true">{{ name.slice(0, 1).toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.provider-symbol :deep(svg) { display: block; width: 100%; height: 100%; }
</style>
