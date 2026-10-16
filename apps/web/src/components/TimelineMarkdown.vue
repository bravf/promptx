<script setup>
import { computed } from 'vue'
import { capTimelineMarkdown, splitTimelineMarkdownBlocks, TIMELINE_MARKDOWN_CHARACTER_LIMIT } from '../lib/timelineMarkdown.js'
import TimelineMarkdownBlock from './TimelineMarkdownBlock.vue'
import TimelineVisualizationCard from './TimelineVisualizationCard.vue'
import { splitVisualizationContent } from '@promptx/protocol'

defineOptions({ inheritAttrs: false })

const props = defineProps({
  text: {
    type: String,
    default: '',
  },
  isDark: {
    type: Boolean,
    default: false,
  },
  streaming: {
    type: Boolean,
    default: false,
  },
  workspaceCwd: {
    type: String,
    default: '',
  },
  taskId: {
    type: String,
    default: '',
  },
})
const emit = defineEmits(['rendered', 'open-workspace-path'])

const renderedMessage = computed(() => capTimelineMarkdown(props.text))
const blocks = computed(() => splitVisualizationContent(renderedMessage.value.text, { streaming: props.streaming || renderedMessage.value.capped }).flatMap(part =>
  part.type === 'markdown' ? splitTimelineMarkdownBlocks(part.text).map(text => ({ type: 'markdown', text })) : [part],
))
const formattedLimit = new Intl.NumberFormat('zh-CN').format(TIMELINE_MARKDOWN_CHARACTER_LIMIT)
</script>

<template>
  <div v-bind="$attrs" class="timeline-markdown min-w-0">
    <template v-for="(block, index) in blocks" :key="index">
      <TimelineVisualizationCard v-if="block.type === 'visualization'" :class="index ? 'mt-3' : ''" :task-id="taskId" :path="block.path" :title="block.title" @rendered="emit('rendered')" />
      <p v-else-if="block.type === 'visualization-error'" class="theme-muted-text my-3 rounded-sm border border-dashed p-3 text-xs">{{ block.message }}</p>
      <TimelineMarkdownBlock
        v-else
        :class="index ? 'mt-3' : ''"
        :text="block.text"
        :is-dark="isDark"
        :streaming="streaming && index === blocks.length - 1"
        :workspace-cwd="workspaceCwd"
        :task-id="taskId"
        @rendered="emit('rendered')"
        @open-workspace-path="emit('open-workspace-path', $event)"
      />
    </template>
    <p v-if="renderedMessage.capped" class="theme-muted-text mt-3 text-xs italic">
      消息内容过长，仅展示前 {{ formattedLimit }} 个字符。
    </p>
  </div>
</template>
