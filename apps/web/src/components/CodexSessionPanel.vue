<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  RefreshCw,
  Square,
  SendHorizontal,
} from 'lucide-vue-next'
import { listCodexSessions, streamPromptToCodexSession } from '../lib/api.js'

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
const error = ref('')
const responseMessage = ref('')
const eventLogs = ref([])
const currentController = ref(null)
const selectedSessionId = ref(window.localStorage.getItem(props.storageKey) || '')
let logId = 0

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
  return '会把当前文档提示词追加到选中的 Codex session。'
})

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

function normalizeSessionOption(session) {
  const title = session.threadName || session.displayName || session.shortId
  return `${title} · ${formatUpdatedAt(session.updatedAt)} · ${session.shortId}`
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
    return
  }

  return {
    id: ++logId,
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
  }
}

function appendLog(entry) {
  const normalized = normalizeLogEntry(entry)
  if (!normalized) {
    return
  }

  eventLogs.value = [...eventLogs.value, normalized].slice(-120)
}

function formatCommandOutput(output = '', limit = 400) {
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
      const statusText = item.exit_code === 0 || item.status === 'completed'
        ? '命令执行完成'
        : `命令执行失败（exit ${item.exit_code ?? '?' }）`
      return {
        kind: item.exit_code === 0 || item.status === 'completed' ? 'command' : 'error',
        title: statusText,
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

function handleStreamEvent(payload = {}) {
  if (payload.type === 'session') {
    appendLog({
      title: `已连接 session：${payload.session?.displayName || payload.session?.shortId || '未知 session'}`,
      detail: payload.session?.cwd ? `工作目录：${payload.session.cwd}` : '',
    })
    return
  }

  if (payload.type === 'status') {
    appendLog({
      title: payload.message || '状态已更新',
    })
    return
  }

  if (payload.type === 'stderr') {
    appendLog({
      kind: 'error',
      title: 'stderr',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'stdout') {
    appendLog({
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    })
    return
  }

  if (payload.type === 'codex') {
    appendLog(formatCodexEvent(payload.event))
    if (payload.event?.type === 'item.completed' && payload.event?.item?.type === 'agent_message' && payload.event?.item?.text) {
      responseMessage.value = payload.event.item.text
    }
    return
  }

  if (payload.type === 'completed') {
    if (payload.message) {
      responseMessage.value = payload.message
    }
    appendLog({
      kind: 'result',
      title: '已收到最终回复',
    })
    return
  }

  if (payload.type === 'error') {
    error.value = payload.message || 'Codex 执行失败。'
    appendLog({
      kind: 'error',
      title: '执行失败',
      detail: error.value,
    })
  }
}

async function loadSessions() {
  loading.value = true
  error.value = ''

  try {
    const payload = await listCodexSessions()
    sessions.value = payload.items || []

    if (selectedSessionId.value && sessions.value.some((session) => session.id === selectedSessionId.value)) {
      return
    }

    selectedSessionId.value = sessions.value[0]?.id || ''
  } catch (err) {
    error.value = err.message
  } finally {
    loading.value = false
  }
}

async function handleSend() {
  if (!selectedSessionId.value || !hasPrompt.value || sending.value) {
    return
  }

  error.value = ''
  responseMessage.value = ''
  eventLogs.value = []
  sending.value = true
  const controller = new AbortController()
  currentController.value = controller

  try {
    if (typeof props.beforeSend === 'function') {
      const ready = await props.beforeSend()
      if (ready === false) {
        sending.value = false
        currentController.value = null
        return
      }
    }

    const prompt = typeof props.buildPrompt === 'function'
      ? await props.buildPrompt()
      : props.prompt

    if (!String(prompt || '').trim()) {
      error.value = '没有可发送的提示词。'
      appendLog({
        kind: 'error',
        title: '执行失败',
        detail: error.value,
      })
      return
    }

    await streamPromptToCodexSession(selectedSessionId.value, {
      prompt,
    }, {
      signal: controller.signal,
      onEvent: handleStreamEvent,
    })

    if (!responseMessage.value) {
      responseMessage.value = '已发送到 Codex session，但没有拿到最终文本。'
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      appendLog({
        title: '已停止本次发送',
      })
    } else {
      error.value = err.message
      appendLog({
        kind: 'error',
        title: '执行失败',
        detail: error.value,
      })
    }
  } finally {
    sending.value = false
    currentController.value = null
  }
}

function stopSending() {
  currentController.value?.abort()
}

watch(selectedSessionId, (value) => {
  if (!value) {
    window.localStorage.removeItem(props.storageKey)
    return
  }
  window.localStorage.setItem(props.storageKey, value)
})

onMounted(loadSessions)
</script>

<template>
  <section class="dashed-panel p-4">
    <div class="flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0">
        <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
          <Bot class="h-4 w-4" />
          <span>发送到 Codex</span>
        </div>
        <p class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
      </div>
      <button
        type="button"
        class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
        :disabled="loading || sending"
        @click="loadSessions"
      >
        <RefreshCw :class="loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'" />
        <span>刷新 session</span>
      </button>
    </div>

    <div class="mt-4 flex flex-col gap-3">
      <label class="text-xs text-stone-500 dark:text-stone-400">
        <span>选择 session</span>
        <select
          v-model="selectedSessionId"
          class="mt-2 w-full rounded-sm border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:focus:border-stone-400"
          :disabled="loading || sending || !hasSessions"
        >
          <option value="" disabled>{{ hasSessions ? '请选择一个 Codex session' : '暂无可用 session' }}</option>
          <option v-for="session in sessions" :key="session.id" :value="session.id">
            {{ normalizeSessionOption(session) }}
          </option>
        </select>
      </label>

      <div class="flex flex-wrap items-center gap-3">
        <button
          type="button"
          class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
          :disabled="loading || sending || !selectedSessionId || !hasPrompt"
          @click="handleSend"
        >
          <LoaderCircle v-if="sending" class="h-4 w-4 animate-spin" />
          <SendHorizontal v-else class="h-4 w-4" />
          <span>{{ sending ? '发送中...' : '发送到当前 session' }}</span>
        </button>
        <button
          v-if="sending"
          type="button"
          class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
          @click="stopSending"
        >
          <Square class="h-4 w-4" />
          <span>停止</span>
        </button>
        <span v-if="selectedSession" class="text-xs text-stone-500 dark:text-stone-400">
          当前：{{ selectedSession.displayName }} · {{ selectedSession.shortId }}
        </span>
      </div>

      <p v-if="error" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
        <CircleAlert class="h-4 w-4" />
        <span>{{ error }}</span>
      </p>

      <div v-if="responseMessage" class="rounded-sm border border-dashed border-emerald-300 bg-emerald-50 px-4 py-3 text-sm leading-7 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100">
        <div class="mb-1 text-xs uppercase tracking-[0.18em] text-emerald-700 dark:text-emerald-300">Codex 返回</div>
        <div class="whitespace-pre-wrap">{{ responseMessage }}</div>
      </div>

      <div v-if="eventLogs.length" class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-3 dark:border-stone-700 dark:bg-stone-950">
        <div class="mb-2 text-xs uppercase tracking-[0.18em] text-stone-500 dark:text-stone-400">执行过程</div>
        <div class="max-h-72 space-y-3 overflow-y-auto">
          <div
            v-for="item in eventLogs"
            :key="item.id"
            class="rounded-sm border border-dashed px-3 py-2 text-xs leading-6"
            :class="{
              'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300': item.kind === 'info',
              'border-stone-300 bg-white text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300': item.kind === 'command',
              'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-100': item.kind === 'todo',
              'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/30 dark:text-emerald-100': item.kind === 'result',
              'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/30 dark:text-red-100': item.kind === 'error',
            }"
          >
            <div class="font-medium">{{ item.title }}</div>
            <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap font-mono text-[11px] leading-5">{{ item.detail }}</pre>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>
