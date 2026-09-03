<script setup>
import { computed } from 'vue'
import { capTimelineMarkdown, splitTimelineMarkdownBlocks, TIMELINE_MARKDOWN_CHARACTER_LIMIT } from '../lib/timelineMarkdown.js'
import TimelineMarkdownBlock from './TimelineMarkdownBlock.vue'

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
})
const emit = defineEmits(['rendered', 'open-workspace-path'])

const renderedMessage = computed(() => capTimelineMarkdown(props.text))
const blocks = computed(() => splitTimelineMarkdownBlocks(renderedMessage.value.text))
const formattedLimit = new Intl.NumberFormat('zh-CN').format(TIMELINE_MARKDOWN_CHARACTER_LIMIT)
</script>

<template>
  <div class="timeline-markdown min-w-0">
    <TimelineMarkdownBlock
      v-for="(block, index) in blocks"
      :key="index"
      :class="index ? 'mt-3' : ''"
      :text="block"
      :is-dark="isDark"
      :streaming="streaming && index === blocks.length - 1"
      :workspace-cwd="workspaceCwd"
      @rendered="emit('rendered')"
      @open-workspace-path="emit('open-workspace-path', $event)"
    />
    <p v-if="renderedMessage.capped" class="theme-muted-text mt-3 text-xs italic">
      消息内容过长，仅展示前 {{ formattedLimit }} 个字符。
    </p>
  </div>
</template>
