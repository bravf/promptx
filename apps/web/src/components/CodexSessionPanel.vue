<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  Square,
} from 'lucide-vue-next'
import ConfirmDialog from './ConfirmDialog.vue'
import { listCodexSessions, streamPromptToCodexSession } from '../lib/api.js'

const emit = defineEmits(['sending-change'])

const props = defineProps({
  prompt: {
    type: String,
    default: '',
  },
  buildPrompt: {
    type: Function,
    default: null,
  },
  beforeSend: {
    type: Function,
    default: null,
  },
  storageKey: {
    type: String,
    default: 'promptx:codex-session-id',
  },
})

const sessions = ref([])
const loading = ref(false)
const sending = ref(false)
const sessionError = ref('')
const turns = ref([])
const currentController = ref(null)
const selectedSessionId = ref('')
const sessionSelectRef = ref(null)
const transcriptRef = ref(null)
const sendingStartedAt = ref(0)
const sendingElapsedSeconds = ref(0)
const showSelectSessionDialog = ref(false)

let turnId = 0
let logId = 0
let sendingTimer = null

const hasPrompt = computed(() => {
  if (typeof props.buildPrompt === 'function') {
    return true
  }
  return Boolean(String(props.prompt || '').trim())
})
const hasSessions = computed(() => sessions.value.length > 0)
const selectedSession = computed(() => sessions.value.find((session) => session.id === selectedSessionId.value) || null)
const helperText = computed(() => {
  if (loading.value) {
    return '正在读取本机 Codex session...'
  }
  if (!hasSessions.value) {
    return '还没有读取到本机 Codex session。'
  }
  return ''
})
const workingLabel = computed(() => `Working (${sendingElapsedSeconds.value}s)`)
const selectSessionDescription = computed(() => {
  if (!hasSessions.value) {
    return '还没有读取到可用的 Codex session，请先在本机打开一个 Codex session。'
  }
  return '发送前请先手动选择一个 Codex session，避免发错会话。'
})

function clearSendingTimer() {
  if (sendingTimer) {
    window.clearInterval(sendingTimer)
    sendingTimer = null
  }
}

function startSendingTimer() {
  sendingStartedAt.value = Date.now()
  sendingElapsedSeconds.value = 0
  clearSendingTimer()
  sendingTimer = window.setInterval(() => {
    sendingElapsedSeconds.value = Math.max(0, Math.floor((Date.now() - sendingStartedAt.value) / 1000))
  }, 1000)
}

function formatUpdatedAt(value = '') {
  if (!value) {
    return '未知时间'
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return value
  }
  return date.toLocaleString('zh-CN')
}

function formatTurnTime(value = '') {
  if (!value) {
    return ''
  }
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return ''
  }
  return date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function normalizeSessionOption(session) {
  const title = session.threadName || session.displayName || session.shortId
  return `${title} · ${session.shortId}`
}

function normalizeLogEntry(entry) {
  if (!entry) {
    return null
  }

  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) {
      return null
    }
    return {
      id: ++logId,
      kind: 'info',
      title: text,
      detail: '',
    }
  }

  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  if (!title && !detail) {
    return null
  }

  return {
    id: ++logId,
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
  }
}

function scheduleScrollToBottom() {
  nextTick(() => {
    if (!transcriptRef.value) {
      return
    }
    const scrollToBottom = () => {
      if (!transcriptRef.value) {
        return
      }
      transcriptRef.value.scrollTop = transcriptRef.value.scrollHeight
    }

    scrollToBottom()
    requestAnimationFrame(() => {
      scrollToBottom()
      requestAnimationFrame(scrollToBottom)
    })
  })
}

function appendTurnEvent(turn, entry) {
  const normalized = normalizeLogEntry(entry)
  if (!normalized) {
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
  scheduleScrollToBottom()
}

function formatCommandOutput(output = '', limit = 500) {
  const text = String(output || '').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatTodoItems(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return ''
  }

  return list
    .map((item) => `${item.completed ? '[x]' : '[ ]'} ${item.text || '未命名步骤'}`)
    .join('\n')
}

function formatCodexEvent(event = {}) {
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (!eventType) {
    return {
      title: '收到一条 Codex 事件',
      detail: '',
    }
  }

  if (eventType === 'thread.started') {
    return {
      title: '已恢复目标 session',
      detail: event.thread_id ? `线程 ID：${event.thread_id}` : '',
    }
  }

  if (eventType === 'turn.started') {
    return {
      title: 'Codex 开始处理这轮请求',
      detail: '',
    }
  }

  if (eventType === 'turn.completed') {
    const usage = event.usage
      ? `输入 ${event.usage.input_tokens || 0} · 输出 ${event.usage.output_tokens || 0}`
      : ''
    return {
      title: 'Codex 已完成本轮执行',
      detail: usage,
    }
  }

  if (eventType === 'item.started') {
    if (item.type === 'command_execution') {
      return {
        kind: 'command',
        title: '开始执行命令',
        detail: item.command || '',
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '生成执行计划',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `开始处理 ${item.type || '任务'}`,
      detail: '',
    }
  }

  if (eventType === 'item.updated' && item.type === 'todo_list') {
    return {
      kind: 'todo',
      title: '更新执行计划',
      detail: formatTodoItems(item.items),
    }
  }

  if (eventType === 'item.completed') {
    if (item.type === 'agent_message' && item.text) {
      return {
        kind: 'result',
        title: 'Codex 已产出回复',
        detail: '',
      }
    }

    if (item.type === 'command_execution') {
      const success = item.exit_code === 0 || item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success ? '命令执行完成' : `命令执行失败（exit ${item.exit_code ?? '?'})`,
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
      }
    }

    if (item.type === 'todo_list') {
      return {
        kind: 'todo',
        title: '执行计划完成',
        detail: formatTodoItems(item.items),
      }
    }

    return {
      title: `完成 ${item.type || '任务'}`,
      detail: '',
    }
  }

  return {
    title: `事件：${eventType}`,
    detail: '',
  }
}

function createTurn(promptText) {
  const turn = reactive({
    id: ++turnId,
    prompt: String(promptText || '').trim(),
    status: 'running',
    startedAt: new Date().toISOString(),
    events: [],
    responseMessage: '',
    errorMessage: '',
  })
  turns.value.push(turn)
  scheduleScrollToBottom()
  return turn
}

function getProcessStatus(turn) {
  if (turn.status === 'running') {
    return '处理中'
  }
  if (turn.status === 'error') {
    return '执行失败'
  }
  if (turn.status === 'stopped') {
    return '已停止'
  }
  return '已完成'
}

function getProcessCardClass(turn) {
  if (turn.status === 'error') {
    return 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
  }
  if (turn.status === 'stopped') {
    return 'border-stone-300 bg-stone-100 text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200'
  }
  if (turn.status === 'completed') {
    return 'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300'
  }
  return 'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100'
}

function shouldShowResponse(turn) {
  return Boolean(turn.responseMessage || turn.errorMessage || turn.status === 'completed')
}

function handleStreamEvent(payload = {}, turn) {
  if (payload.type === 'session') {
    appendTurnEvent(turn, {
      title: `已连接 session：${payload.session?.displayName || payload.session?.shortId || '未知 session'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    })
    return
  }

  if (payload.type === 'status') {
    appendTurnEvent(turn, {
      title: payload.message || '状态已更新',
      detail: '',
    })
    return
  }

  if (payload.type === 'stderr') {
    appendTurnEvent(turn, {
      kind: 'error',
      title: 'stderr',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'stdout') {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'codex') {
    appendTurnEvent(turn, formatCodexEvent(payload.event))
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    return
  }

  if (payload.type === 'completed') {
    turn.status = 'completed'
    if (payload.message) {
      turn.responseMessage = payload.message
    }
    if (!turn.responseMessage) {
      turn.responseMessage = '已发送到 Codex session，但没有拿到最终文本。'
    }
    appendTurnEvent(turn, {
      kind: 'result',
      title: '已收到最终回复',
      detail: '',
    })
    return
  }

  if (payload.type === 'error') {
    turn.status = 'error'
    turn.errorMessage = payload.message || 'Codex 执行失败。'
    appendTurnEvent(turn, {
      kind: 'error',
      title: '执行失败',
      detail: turn.errorMessage,
    })
  }
}

async function loadSessions() {
  loading.value = true
  sessionError.value = ''

  try {
    const payload = await listCodexSessions()
    sessions.value = payload.items || []
  } catch (err) {
    sessionError.value = err.message
  } finally {
    loading.value = false
  }
}

async function handleSend() {
  if (!hasPrompt.value || sending.value) {
    return false
  }

  if (!selectedSessionId.value) {
    showSelectSessionDialog.value = true
    return false
  }

  sessionError.value = ''

  try {
    if (typeof props.beforeSend === 'function') {
      const ready = await props.beforeSend()
      if (ready === false) {
        return false
      }
    }

    const prompt = typeof props.buildPrompt === 'function'
      ? await props.buildPrompt()
      : props.prompt

    if (!String(prompt || '').trim()) {
      sessionError.value = '没有可发送的提示词。'
      return false
    }

    sending.value = true
    const controller = new AbortController()
    const turn = createTurn(prompt)
    currentController.value = controller

    ;(async () => {
      try {
        await streamPromptToCodexSession(selectedSessionId.value, {
          prompt,
        }, {
          signal: controller.signal,
          onEvent(payload) {
            handleStreamEvent(payload, turn)
          },
        })
      } catch (err) {
        if (err.name === 'AbortError') {
          turn.status = 'stopped'
          appendTurnEvent(turn, {
            title: '已停止本次发送',
            detail: '',
          })
        } else {
          turn.status = 'error'
          turn.errorMessage = err.message
          appendTurnEvent(turn, {
            kind: 'error',
            title: '执行失败',
            detail: turn.errorMessage,
          })
        }
      } finally {
        sending.value = false
        currentController.value = null
      }
    })()

    return true
  } catch (err) {
    sessionError.value = err.message
    return false
  }
}

function stopSending() {
  currentController.value?.abort()
}

function closeSelectSessionDialog() {
  showSelectSessionDialog.value = false
}

function focusSessionSelect() {
  showSelectSessionDialog.value = false
  nextTick(() => {
    sessionSelectRef.value?.focus?.()
    sessionSelectRef.value?.showPicker?.()
  })
}

function clearTurns() {
  turns.value = []
}

watch(
  sending,
  (value) => {
    if (value) {
      startSendingTimer()
      scheduleScrollToBottom()
    } else {
      clearSendingTimer()
      sendingStartedAt.value = 0
      sendingElapsedSeconds.value = 0
    }
    emit('sending-change', value)
  },
  { immediate: true }
)

defineExpose({
  send: handleSend,
  stop: stopSending,
})

onMounted(loadSessions)

onBeforeUnmount(() => {
  clearSendingTimer()
})

watch(
  turns,
  () => {
    scheduleScrollToBottom()
  },
  { deep: true, flush: 'post' }
)
</script>

<template>
  <section class="panel relative flex h-full min-h-0 flex-col overflow-hidden">
    <ConfirmDialog
      :open="showSelectSessionDialog"
      title="请先选择 session"
      :description="selectSessionDescription"
      confirm-text="去选择"
      cancel-text="知道了"
      @cancel="closeSelectSessionDialog"
      @confirm="focusSessionSelect"
    />

    <div class="border-b border-stone-300 bg-stone-50/80 p-3 dark:border-stone-700 dark:bg-stone-900/80">
      <div class="flex flex-col gap-2.5">
        <div class="flex items-center gap-2">
          <div class="min-w-0 shrink-0">
            <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              <Bot class="h-4 w-4" />
              <span>Codex 对话</span>
            </div>
            <p v-if="helperText" class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
          </div>

          <label class="ml-auto min-w-0 w-full max-w-[220px] sm:max-w-[260px]">
            <select
              ref="sessionSelectRef"
              v-model="selectedSessionId"
              class="w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-400"
              :disabled="loading || sending || !hasSessions"
            >
              <option value="" disabled>{{ hasSessions ? '请选择一个 Codex session' : '暂无可用 session' }}</option>
              <option v-for="session in sessions" :key="session.id" :value="session.id">
                {{ normalizeSessionOption(session) }}
              </option>
            </select>
          </label>
        </div>

        <div v-if="selectedSession?.cwd" class="hidden rounded-sm border border-dashed border-stone-300 bg-stone-50 px-3 py-2 text-xs text-stone-600 sm:block dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300">
          <div class="break-all font-mono text-[11px] text-stone-500 dark:text-stone-400">{{ selectedSession.cwd }}</div>
        </div>

        <p v-if="sessionError" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div ref="transcriptRef" class="h-full space-y-4 overflow-y-auto px-4 py-4">
        <div v-if="!turns.length" class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-sm text-stone-500 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400">
          发送当前文档后，这里会按对话形式显示每一轮的执行过程和 Codex 回复。
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed border-stone-300 bg-stone-100 px-4 py-3 text-sm text-stone-800 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100">
              <div class="flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                <span>本次发送</span>
                <span>{{ formatTurnTime(turn.startedAt) }}</span>
              </div>
              <pre class="mt-2 whitespace-pre-wrap break-all font-sans leading-7">{{ turn.prompt }}</pre>
            </div>
          </div>

          <div class="flex justify-start">
            <div class="min-w-0 w-full max-w-[94%] rounded-sm border border-dashed px-4 py-3" :class="getProcessCardClass(turn)">
              <div class="flex items-center justify-between gap-3 text-xs">
                <span>执行过程</span>
                <span>{{ getProcessStatus(turn) }}</span>
              </div>
              <div v-if="turn.events.length" class="mt-3 space-y-3">
                <div
                  v-for="item in turn.events"
                  :key="item.id"
                  class="rounded-sm border border-dashed px-3 py-2"
                  :class="{
                    'border-stone-300/70 bg-white/70 dark:border-stone-700 dark:bg-stone-950/60': item.kind === 'info' || item.kind === 'command',
                    'border-amber-300/70 bg-amber-100/60 dark:border-amber-800 dark:bg-amber-950/40': item.kind === 'todo',
                    'border-emerald-300/70 bg-emerald-100/60 dark:border-emerald-800 dark:bg-emerald-950/40': item.kind === 'result',
                    'border-red-300/70 bg-red-100/60 dark:border-red-800 dark:bg-red-950/40': item.kind === 'error',
                  }"
                >
                  <div class="font-medium">{{ item.title }}</div>
                  <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{{ item.detail }}</pre>
                </div>
              </div>
              <p v-else class="mt-3 text-xs text-current/80">等待 Codex 返回过程事件...</p>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100'"
            >
              <div class="text-xs text-current/80">{{ turn.errorMessage ? 'Codex 错误' : 'Codex 回复' }}</div>
              <div class="mt-2 whitespace-pre-wrap break-all">{{ turn.errorMessage || turn.responseMessage }}</div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div
      v-if="sending"
      class="flex shrink-0 items-center justify-between gap-3 border-t border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100"
    >
      <div class="flex items-center gap-2">
        <LoaderCircle class="h-4 w-4 animate-spin" />
        <span>{{ workingLabel }}</span>
      </div>
      <button
        type="button"
        class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
        @click="stopSending"
      >
        <Square class="h-4 w-4" />
        <span>停止</span>
      </button>
    </div>
  </section>
</template>
