<script setup>
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { request } from '../lib/request.js'
import { useTheme } from '../composables/useTheme.js'

const props = defineProps({ taskId: { type: String, required: true }, terminalId: { type: String, required: true } })
const emit = defineEmits(['state', 'missing'])
const host = ref(null)
const error = ref('')
const { currentTheme } = useTheme()
const base = `/api/v2/tasks/${encodeURIComponent(props.taskId)}/terminals/${encodeURIComponent(props.terminalId)}`
let terminal, fit, observer, timer, resizeTimer, controller
let cursor = 0, disposed = false, running = true, polling = false, delay = 100, queue = Promise.resolve(), inputBuffer = '', inputTimer, inputPending = 0
let lastSize = '', exitShown = false
const shortcutKeys = [
  { label: 'Ctrl+C', title: '中断当前命令', data: '\x03' },
  { label: 'Tab', title: '补全命令', data: '\t' },
  { label: 'Esc', title: '退出当前模式', data: '\x1b' },
  { label: '←', title: '光标左移', arrow: 'D' },
  { label: '↓', title: '下一条历史或向下', arrow: 'B' },
  { label: '↑', title: '上一条历史或向上', arrow: 'A' },
  { label: '→', title: '光标右移', arrow: 'C' },
]
function sendShortcut(key) {
  if (!terminal || disposed || !running) return
  terminal.focus()
  const data = key.arrow ? `\x1b${terminal.modes.applicationCursorKeysMode ? 'O' : '['}${key.arrow}` : key.data
  terminal.input(data, true)
  flushInput()
}
function applyTheme() {
  if (!terminal || disposed) return
  const style = getComputedStyle(host.value)
  const token = name => style.getPropertyValue(`--theme-${name}`).trim()
  terminal.options.theme = { background: token('appPanel'), foreground: token('textPrimary'), cursor: token('accent'), selectionBackground: token('selectionBg') }
}
function enqueue(action) {
  queue = queue.then(() => disposed ? undefined : action()).catch(cause => { if (!disposed) error.value = cause.message })
  return queue
}
function schedule(ms = delay) {
  clearTimeout(timer)
  if (!disposed && !document.hidden && running && !polling) timer = setTimeout(poll, ms)
}
async function poll() {
  if (disposed || document.hidden || polling) return
  polling = true
  controller = new AbortController()
  try {
    const state = await request(`${base}?cursor=${cursor}`, { signal: controller.signal })
    if (disposed) return
    if (state.reset) { terminal.reset(); terminal.writeln('[较早的终端输出已截断]') }
    if (state.data) await new Promise(resolve => terminal.write(state.data, resolve))
    if (disposed) return
    cursor = state.cursor
    running = state.running
    emit('state', { id: props.terminalId, running, exitCode: state.exitCode })
    if (!running && !exitShown) { terminal.writeln(`\r\n[进程已退出，代码 ${state.exitCode}]`); exitShown = true }
    delay = state.data || inputPending ? 100 : Math.min(1500, Math.max(100, delay * 2))
  } catch (cause) {
    if (disposed || cause.name === 'AbortError') return
    error.value = cause.message
    delay = 1500
    if (cause.statusCode === 409 || cause.statusCode === 404) { running = false; emit('missing') }
  } finally { polling = false; schedule() }
}
function resize() {
  if (disposed || !fit || document.hidden) return
  fit.fit()
  clearTimeout(resizeTimer)
  resizeTimer = setTimeout(() => {
    if (disposed || !running) return
    const cols = Math.max(2, Math.min(500, terminal.cols)), rows = Math.max(2, Math.min(200, terminal.rows))
    const size = `${cols}:${rows}`
    if (lastSize === size) return
    lastSize = size
    enqueue(() => request(`${base}/resize`, { method: 'POST', body: JSON.stringify({ cols, rows }) }))
  }, 120)
}
function flushInput() {
  clearTimeout(inputTimer)
  const data = inputBuffer
  inputBuffer = ''
  if (!data || disposed || !running) return
  inputPending++
  enqueue(async () => {
    try { await request(`${base}/input`, { method: 'POST', body: JSON.stringify({ id: crypto.randomUUID(), data }) }); delay = 100; schedule(0) }
    finally { inputPending-- }
  })
}
function visibility() {
  clearTimeout(timer)
  if (document.hidden) controller?.abort()
  else { resize(); schedule(0) }
}
watch(currentTheme, applyTheme, { flush: 'post' })
onMounted(() => {
  terminal = new Terminal({ fontSize: 12, fontFamily: 'monospace', scrollback: 3000, cursorBlink: true })
  fit = new FitAddon()
  terminal.loadAddon(fit)
  terminal.open(host.value)
  applyTheme()
  terminal.onData(data => {
    if (!running || disposed) return
    if (inputBuffer.length + data.length > 65536 || inputPending > 64) { error.value = '输入过多，请等待终端响应后重试'; return }
    inputBuffer += data
    while (inputBuffer.length >= 16384) {
      const rest = inputBuffer.slice(16384)
      inputBuffer = inputBuffer.slice(0, 16384)
      flushInput()
      inputBuffer = rest
    }
    clearTimeout(inputTimer)
    inputTimer = setTimeout(flushInput, 8)
  })
  terminal.attachCustomKeyEventHandler(event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && terminal.hasSelection()) {
      if (event.type === 'keydown') navigator.clipboard.writeText(terminal.getSelection()).catch(() => { error.value = '复制失败，请检查浏览器剪贴板权限' })
      return false
    }
    return true
  })
  observer = new ResizeObserver(resize)
  observer.observe(host.value)
  document.addEventListener('visibilitychange', visibility)
  resize()
  poll()
  terminal.focus()
})
onBeforeUnmount(() => {
  disposed = true
  clearTimeout(timer); clearTimeout(resizeTimer); clearTimeout(inputTimer)
  controller?.abort(); observer?.disconnect(); document.removeEventListener('visibilitychange', visibility)
  terminal?.dispose()
})
</script>

<template>
  <div class="terminal-screen flex min-h-0 flex-1 flex-col">
    <p v-if="error" class="theme-status-danger shrink-0 px-2 py-1 text-xs" role="alert">{{ error }}</p>
    <div class="terminal-shortcuts shrink-0 items-center gap-1 px-2 pb-1" role="group" aria-label="终端快捷键">
      <button v-for="key in shortcutKeys" :key="key.label" type="button" class="tool-button min-w-0 flex-1 rounded-sm px-1 text-xs" :aria-label="key.title" :title="key.title" @pointerdown.prevent @mousedown.prevent @click="sendShortcut(key)">{{ key.label }}</button>
    </div>
    <div ref="host" class="min-h-0 flex-1 overflow-hidden px-2 pb-2" />
  </div>
</template>

<style scoped>
.terminal-shortcuts { display: none; }
.terminal-shortcuts button { min-height: 36px; touch-action: manipulation; }
@media (max-width: 720px), (pointer: coarse) {
  .terminal-shortcuts { display: flex; }
}
</style>
