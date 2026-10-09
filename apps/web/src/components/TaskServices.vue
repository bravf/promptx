<script setup>
import { ref } from 'vue'
import { TerminalSquare, ExternalLink } from 'lucide-vue-next'
import { request } from '../lib/request.js'
import { isRemoteTransport } from '../lib/transport.js'
import PxButton from './PxButton.vue'

const props = defineProps({ taskId: String, services: { type: Array, default: () => [] } })
const emit = defineEmits(['open-terminal', 'changed'])
const busy = ref('')
const error = ref('')
function status(item) {
  if (item.stopping) return '正在停止'
  if (!item.running) return item.exitCode ? '启动失败 / 已退出' : '已停止'
  return item.service.readiness === 'ready' ? '运行中 · 地址可访问' : item.service.readiness === 'starting' ? '正在启动' : '运行中 · 地址未确认'
}
async function action(item, type) {
  if (busy.value) return
  busy.value = item.id
  error.value = ''
  try {
    const result = await request(`/api/v2/tasks/${encodeURIComponent(props.taskId)}/terminals/${item.id}/${type}`, { method: 'POST', body: JSON.stringify(type === 'restart' ? { cols: 100, rows: 30 } : {}) })
    emit('changed')
    if (type === 'restart') emit('open-terminal', result.terminal.id)
  } catch (cause) { error.value = cause.message }
  finally { busy.value = '' }
}
</script>

<template>
  <section v-if="services.length" class="task-services mb-5 min-w-0 space-y-2" aria-label="会话服务">
    <article v-for="item in services" :key="item.id" class="panel rounded-lg border p-3">
      <div class="flex min-w-0 flex-wrap items-start gap-2 text-xs"><TerminalSquare class="h-4 w-4 shrink-0" /><strong class="min-w-0 flex-1 break-words">{{ item.name }}</strong><span class="theme-muted-text">{{ status(item) }}</span></div>
      <div v-if="item.service.url" class="theme-muted-text mt-2 break-all text-xs">{{ item.service.url }}</div>
      <p v-if="isRemoteTransport() && item.service.url" class="theme-muted-text mt-1 text-[10px]">这是电脑上的本地地址，手机需使用可访问的局域网地址或部署地址。</p>
      <div class="mt-2 flex flex-wrap gap-2">
        <PxButton variant="ghost" size="sm" @click="emit('open-terminal', item.id)">查看终端</PxButton>
        <a v-if="item.running && item.service.readiness === 'ready' && !isRemoteTransport()" :href="item.service.url" target="_blank" rel="noopener noreferrer" class="tool-button inline-flex items-center gap-1 rounded-sm px-2 py-1 text-xs"><ExternalLink class="h-3 w-3" />打开页面</a>
        <PxButton v-if="item.running" variant="ghost" size="sm" :disabled="Boolean(busy) || item.stopping" @click="action(item, 'stop')">停止服务</PxButton>
        <PxButton v-else variant="ghost" size="sm" :disabled="Boolean(busy)" :loading="busy === item.id" @click="action(item, 'restart')">重新启动服务</PxButton>
      </div>
    </article>
    <p v-if="error" class="theme-status-danger text-xs" role="alert">{{ error }}</p>
  </section>
</template>
