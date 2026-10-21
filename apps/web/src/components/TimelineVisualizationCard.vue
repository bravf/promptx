<script setup>
import { inject, onMounted } from 'vue'
import { PhChartLine } from '@phosphor-icons/vue'
import PxButton from './PxButton.vue'
const props = defineProps({ taskId: String, path: String, title: String })
const emit = defineEmits(['rendered'])
const open = inject('openVisualizationPreview', null)
function show(mode) { open?.({ taskId: props.taskId, path: props.path, title: props.title, mode }) }
onMounted(() => emit('rendered'))
</script>

<template>
  <section class="panel visualization-card min-w-0 rounded-sm border p-3" aria-label="交互图表">
    <div class="flex min-w-0 items-center gap-2"><PhChartLine class="theme-muted-text h-4 w-4 shrink-0" /><span class="theme-heading break-all text-sm font-medium">{{ title }}</span></div>
    <p class="theme-muted-text mt-1 text-xs">交互图表 · 在隔离环境中预览</p>
    <div class="mt-3 flex flex-wrap gap-2">
      <PxButton size="sm" :disabled="!taskId || !open" @click="show('preview')">打开预览</PxButton>
      <PxButton size="sm" variant="ghost" :disabled="!taskId || !open" @click="show('source')">查看源码</PxButton>
    </div>
  </section>
</template>
