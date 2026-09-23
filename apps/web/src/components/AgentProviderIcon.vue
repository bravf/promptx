<script setup>
import { computed } from 'vue'
import claude from '../assets/providers/claude.svg'
import codex from '../assets/providers/codex.svg'
import grok from '../assets/providers/grok.svg'
import kimi from '../assets/providers/kimi.svg'

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
    <span v-if="icon" class="provider-symbol h-full w-full" :style="{ maskImage: `url(${icon})`, WebkitMaskImage: `url(${icon})` }" aria-hidden="true" />
    <span v-else class="text-[10px] font-semibold leading-none" aria-hidden="true">{{ name.slice(0, 1).toUpperCase() }}</span>
  </span>
</template>

<style scoped>
.provider-symbol { background: currentColor; mask-size: contain; mask-position: center; mask-repeat: no-repeat; -webkit-mask-size: contain; -webkit-mask-position: center; -webkit-mask-repeat: no-repeat; }
</style>
