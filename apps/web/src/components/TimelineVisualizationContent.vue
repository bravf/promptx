<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PhArrowsClockwise } from '@phosphor-icons/vue'
import PxButton from './PxButton.vue'
import PxIconButton from './PxIconButton.vue'
import { useTheme } from '../composables/useTheme.js'
import { v2Api } from '../lib/v2Api.js'
import { createVisualizationDocument, VISUALIZATION_SANDBOX } from '../lib/visualizationDocument.js'

const props = defineProps({ taskId: String, path: String, title: String, mode: { type: String, default: 'preview' }, visible: { type: Boolean, default: true } })
const emit = defineEmits(['escape', 'update:mode'])
const { currentTheme, isDark } = useTheme()
const frame = ref(null)
const mode = ref(props.mode)
const html = ref('')
const loading = ref(false)
const error = ref('')
const warning = ref('')
const ready = ref(false)
const token = ref('')
const previewMounted = ref(props.mode !== 'source')
function selectMode(value) { mode.value = value; emit('update:mode', value) }
watch(() => props.mode, value => { mode.value = value })
watch(mode, value => { if (value === 'preview') previewMounted.value = true })
let controller = null
let timer = null
const srcdoc = computed(() => html.value ? createVisualizationDocument(html.value, { token: token.value, colors: currentTheme.value.colors, dark: isDark.value }) : '')

async function load() {
  controller?.abort(); clearTimeout(timer)
  const request = new AbortController(); controller = request
  loading.value = true; error.value = ''; warning.value = ''; html.value = ''; ready.value = false
  token.value = crypto.randomUUID()
  try {
    const result = await v2Api.readTaskVisualization(props.taskId, props.path, { signal: request.signal })
    if (!request.signal.aborted) html.value = result.visualization.html
  } catch (cause) { if (!request.signal.aborted) error.value = cause.message || '图表读取失败，请重试。' }
  finally { if (!request.signal.aborted) loading.value = false }
}
function message(event) {
  if (event.source !== frame.value?.contentWindow || event.data?.source !== 'promptx-visualization' || event.data?.token !== token.value) return
  if (event.data.type === 'ready') { ready.value = true; clearTimeout(timer) }
  if (event.data.type === 'error') warning.value = '图表运行出错或依赖加载失败，可重试或查看源码。'
  if (event.data.type === 'blocked') warning.value = '部分内容因隔离策略被拦截；预览仅支持内嵌资源与已允许的图表依赖。'
  if (event.data.type === 'unsupported') warning.value = '这个图表的操作需要 Codex 宿主功能，PromptX 暂不支持；可以返回会话手动发送。'
  if (event.data.type === 'close' && props.visible) emit('escape')
}
watch([srcdoc, previewMounted], () => {
  clearTimeout(timer); ready.value = false
  if (srcdoc.value && previewMounted.value) timer = setTimeout(() => { if (!ready.value) warning.value = '图表加载超时，请检查网络后重试，或查看源码。' }, 15000)
})
watch(() => [props.taskId, props.path], load, { immediate: true })
onMounted(() => {
  window.addEventListener('message', message)
})
onBeforeUnmount(() => {
  controller?.abort(); clearTimeout(timer)
  window.removeEventListener('message', message)
})
</script>

<template>
  <section class="visualization-content flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
    <div class="flex shrink-0 items-center gap-2 border-b px-3 py-2">
      <PxButton size="sm" :variant="mode === 'preview' ? 'primary' : 'ghost'" :aria-pressed="mode === 'preview'" @click="selectMode('preview')">预览</PxButton>
      <PxButton size="sm" :variant="mode === 'source' ? 'primary' : 'ghost'" :aria-pressed="mode === 'source'" @click="selectMode('source')">源码</PxButton>
      <span class="theme-muted-text ml-auto text-xs">隔离预览</span>
      <PxIconButton label="重新加载图表" :disabled="loading" @click="load"><PhArrowsClockwise class="h-4 w-4" /></PxIconButton>
    </div>
    <div v-if="loading || error" class="theme-muted-text flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-6 text-center text-sm" role="status">
      <p>{{ error || '正在读取图表…' }}</p><PxButton v-if="error" size="sm" @click="load">重试</PxButton>
    </div>
    <template v-else-if="html">
      <p v-if="warning && mode === 'preview'" class="theme-muted-text shrink-0 border-b px-3 py-2 text-xs" role="status">{{ warning }}</p>
      <iframe v-if="previewMounted" v-show="mode === 'preview'" ref="frame" class="min-h-0 w-full flex-1 border-0" title="交互图表预览" :sandbox="VISUALIZATION_SANDBOX" referrerpolicy="no-referrer" :srcdoc="srcdoc" allow="camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'" />
      <pre v-if="mode === 'source'" class="min-h-0 flex-1 overflow-auto whitespace-pre p-4 text-xs" tabindex="0" aria-label="图表 HTML 源码">{{ html }}</pre>
    </template>
  </section>
</template>

<style scoped>
.visualization-content { background: var(--theme-appPanel); color: var(--theme-textPrimary); }
</style>
