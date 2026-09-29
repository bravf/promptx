<script setup>
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useTheme } from '../composables/useTheme.js'
import { toolContentPreview } from '../lib/toolContentPreview.js'
import { highlightToolSection } from '../lib/toolDetailHighlight.js'
const props = defineProps({ section: { type: Object, required: true }, active: { type: Boolean, default: true } })
const emit = defineEmits(['rendered'])
const pauseTimelineFollow = inject('pauseTimelineFollow', () => {})
const { isDark } = useTheme()
const rendered = ref(null), showContext = ref(false), pages = ref(1), wrapCode = ref(false)
const preview = computed(() => toolContentPreview(props.section.text || '', pages.value))
const isCode = computed(() => props.section.id !== 'command' && (['code', 'diff', 'json'].includes(props.section.format) || Boolean(rendered.value?.rows)))
const wrap = computed(() => !isCode.value || wrapCode.value)
const visibleSection = computed(() => ({ ...props.section, text: preview.value.text, hasMore: props.section.hasMore || preview.value.hidden }))
watch(() => props.section.id, () => { pages.value = 1; showContext.value = false })
let version = 0, timer
watch(() => [props.section.text, props.section.format, props.section.filePath, props.section.matchText, props.section.hasMore, pages.value, isDark.value, props.active, showContext.value], () => {
  const current = ++version
  clearTimeout(timer)
  if (!props.active) return
  // 更新期间保留当前节点，避免追加正文或切换主题时重置内部滚动位置。
  timer = setTimeout(async () => {
    const result = await highlightToolSection(visibleSection.value, isDark.value, showContext.value)
    if (current !== version) return
    rendered.value = result
    emit('rendered')
  }, 80)
}, { immediate: true })
onBeforeUnmount(() => { version++; clearTimeout(timer) })
</script>

<template>
  <div class="tool-content min-w-0" :class="{ 'tool-content-wrap': wrap }" @click.capture="$event.target.closest('button') && pauseTimelineFollow()">
    <div v-if="isCode" class="mb-1 flex justify-end">
      <button type="button" class="theme-muted-text border-0 bg-transparent text-[10px]" :aria-pressed="wrapCode" @click="wrapCode = !wrapCode">自动换行</button>
    </div>
    <div v-if="rendered?.rows" class="tool-output tool-diff" role="region" aria-label="本次修改 Diff" tabindex="0">
      <div class="tool-diff-lines">
        <template v-for="(line, index) in rendered.rows" :key="index">
          <button v-if="line.kind === 'fold'" type="button" class="tool-diff-fold" @click="showContext = true">展开 {{ line.count }} 行未修改内容</button>
          <span v-else class="tool-diff-line" :class="`tool-diff-${line.kind}`" v-html="line.html" />
        </template>
      </div>
    </div>
    <pre v-else-if="rendered" class="tool-output" tabindex="0" v-html="rendered.html" />
    <pre v-else class="tool-output" tabindex="0">{{ preview.text }}</pre>
    <div v-if="preview.hidden || pages > 1" class="mt-2 flex flex-wrap gap-3">
      <button v-if="preview.hidden" type="button" class="theme-muted-text border-0 bg-transparent text-[11px] underline" @click="pages++; emit('rendered')">展开更多已加载内容</button>
      <button v-if="pages > 1" type="button" class="theme-muted-text border-0 bg-transparent text-[11px] underline" @click="pages = 1; emit('rendered')">收起内容</button>
    </div>
    <div v-if="rendered?.limited" class="theme-muted-text mt-1 text-[10px]">内容较长，已简化着色以保持流畅。</div>
  </div>
</template>

<style scoped>
.tool-output { margin: 0; max-width: 100%; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; white-space: pre; font-family: var(--theme-fontMono); font-size: 11px; line-height: 1.65; tab-size: 2; }
.tool-content-wrap .tool-output { white-space: pre-wrap; overflow-wrap: anywhere; overflow: visible; }
.tool-content-wrap .tool-diff-lines { width: auto; min-width: 0; }
.tool-content-wrap .tool-diff-line { white-space: pre-wrap; overflow-wrap: anywhere; }
.tool-diff-lines { min-width: 100%; width: max-content; }
.tool-diff-line { display: block; min-height: 1.65em; padding: 0 0.5rem; }
.tool-diff-add { background: var(--theme-successSoft); color: var(--theme-successText); }
.tool-diff-delete { background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
.tool-diff-header, .tool-diff-fold { color: var(--theme-textMuted); background: var(--theme-appPanelInset); }
.tool-diff-fold { display: block; width: 100%; border: 0; padding: 0.25rem 0.5rem; text-align: left; font: inherit; }
.tool-diff-fold:hover { color: var(--theme-accentText); }
.tool-diff-add :deep(mark) { color: inherit; background: color-mix(in srgb, var(--theme-success) 24%, transparent); }
.tool-diff-delete :deep(mark) { color: inherit; background: color-mix(in srgb, var(--theme-danger) 24%, transparent); }
:deep(.tool-line-number) { color: var(--theme-textMuted); }
pre :deep(mark) { color: var(--theme-accentText); background: var(--theme-accentSoft); }
</style>
