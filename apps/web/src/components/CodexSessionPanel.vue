<script setup>
import {
  Bot,
  CircleAlert,
  LoaderCircle,
  PencilLine,
  Square,
} from 'lucide-vue-next'
import CodexSessionManagerDialog from './CodexSessionManagerDialog.vue'
import CodexSessionSelect from './CodexSessionSelect.vue'
import { useCodexSessionPanel } from '../composables/useCodexSessionPanel.js'

const emit = defineEmits(['selected-session-change', 'sending-change'])

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
  taskSlug: {
    type: String,
    default: '',
  },
  selectedSessionId: {
    type: String,
    default: '',
  },
  active: {
    type: Boolean,
    default: false,
  },
})

const {
  clearTurns,
  closeManager,
  formatTurnTime,
  getProcessCardClass,
  getProcessStatus,
  handleCreateSession,
  handleDeleteSession,
  handleSelectSession,
  handleSend,
  handleUpdateSession,
  helperText,
  loading,
  managerBusy,
  openManager,
  refreshSessionsForSelection,
  selectedSessionId,
  sending,
  sessionError,
  shouldShowResponse,
  showManager,
  sortedSessions,
  stopSending,
  transcriptRef,
  turns,
  workspaces,
  workingLabel,
  sessions,
  loadSessions,
  scrollToBottom,
} = useCodexSessionPanel(props, emit)

defineExpose({
  send: handleSend,
  scrollToBottom,
  stop: stopSending,
})
</script>

<template>
  <section class="panel relative flex h-full min-h-0 flex-col overflow-hidden">
    <CodexSessionManagerDialog
      :open="showManager"
      :sessions="sessions"
      :workspaces="workspaces"
      :selected-session-id="selectedSessionId"
      :loading="loading"
      :sending="sending"
      :on-refresh="loadSessions"
      :on-create="handleCreateSession"
      :on-update="handleUpdateSession"
      :on-delete="handleDeleteSession"
      @close="closeManager"
      @select-session="handleSelectSession"
    />

    <div class="border-b border-stone-300 bg-stone-50/80 p-3 dark:border-[#342d29] dark:bg-[#221d1a]">
      <div class="flex flex-col gap-3">
        <div class="flex flex-wrap items-center gap-2">
          <div class="min-w-0 shrink-0">
            <div class="flex items-center gap-2 text-sm font-medium text-stone-900 dark:text-stone-100">
              <Bot class="h-4 w-4" />
              <span>会话</span>
            </div>
            <p v-if="helperText" class="mt-1 text-xs text-stone-500 dark:text-stone-400">{{ helperText }}</p>
          </div>

          <div class="ml-auto flex items-center gap-2">
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs dark:border-[#4c423c] dark:bg-[#2b2521] dark:hover:bg-[#342d28]"
              :disabled="sending"
              @click="clearTurns"
            >
              <span>清空记录</span>
            </button>
            <button
              type="button"
              class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs dark:border-[#5a4d45] dark:bg-[#342d28] dark:text-stone-100 dark:hover:bg-[#3d3530]"
              :disabled="sending || managerBusy"
              @click="openManager"
            >
              <PencilLine class="h-4 w-4" />
              <span>管理会话</span>
            </button>
          </div>
        </div>

        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <div class="min-w-0 flex-1">
            <CodexSessionSelect
              v-model="selectedSessionId"
              :sessions="sortedSessions"
              :loading="loading"
              :disabled="sending || managerBusy"
              @refresh-intent="refreshSessionsForSelection"
            />
          </div>

        </div>

        <p v-if="sessionError" class="inline-flex items-center gap-2 text-sm text-red-700 dark:text-red-300">
          <CircleAlert class="h-4 w-4" />
          <span>{{ sessionError }}</span>
        </p>
      </div>
    </div>

    <div class="min-h-0 flex-1">
      <div ref="transcriptRef" class="h-full space-y-4 overflow-y-auto px-4 py-4">
        <div
          v-if="!turns.length"
          class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-4 py-6 text-sm text-stone-500 dark:border-[#544941] dark:bg-[#2d2723] dark:text-stone-400"
        >
          这里会显示会话执行过程和 Codex 回复。
        </div>

        <div v-for="turn in turns" :key="turn.id" class="space-y-3">
          <div class="flex justify-end">
            <div class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed border-stone-300 bg-stone-100 px-4 py-3 text-sm text-stone-800 dark:border-[#544941] dark:bg-[#322b26] dark:text-stone-100">
              <div class="flex items-center justify-between gap-3 text-xs text-stone-500 dark:text-stone-400">
                <span>本轮提示词</span>
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
                    'border-stone-300/70 bg-white/70 dark:border-[#453c36] dark:bg-[#26211d]': item.kind === 'info' || item.kind === 'command',
                    'border-amber-300/70 bg-amber-100/60 dark:border-[#7f6949] dark:bg-[#392f20]': item.kind === 'todo',
                    'border-emerald-300/70 bg-emerald-100/60 dark:border-[#5b7562] dark:bg-[#243228]': item.kind === 'result',
                    'border-red-300/70 bg-red-100/60 dark:border-[#7b4f4a] dark:bg-[#372321]': item.kind === 'error',
                  }"
                >
                  <div class="font-medium">{{ item.title }}</div>
                  <pre v-if="item.detail" class="mt-1 whitespace-pre-wrap break-all font-mono text-[11px] leading-5">{{ item.detail }}</pre>
                </div>
              </div>
              <p v-else class="mt-3 text-xs text-current/80">正在等待 Codex 返回事件...</p>
            </div>
          </div>

          <div v-if="shouldShowResponse(turn)" class="flex justify-start">
            <div
              class="min-w-0 w-full max-w-[92%] rounded-sm border border-dashed px-4 py-3 text-sm leading-7"
              :class="turn.errorMessage
                ? 'border-red-300 bg-red-50 text-red-900 dark:border-[#7b4f4a] dark:bg-[#372321] dark:text-[#f0dfdc]'
                : 'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-[#5b7562] dark:bg-[#243228] dark:text-[#deecdf]'"
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
      class="flex shrink-0 items-center justify-between gap-3 border-t border-dashed border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-[#7f6949] dark:bg-[#392f20] dark:text-[#e5ce9a]"
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
