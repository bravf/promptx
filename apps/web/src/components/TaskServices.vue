<script setup>
import { computed, ref, useId, watch } from 'vue'
import { PhTerminalWindow, PhArrowSquareOut, PhHardDrives, PhCaretDown, PhCaretUp, PhSquare, PhArrowsClockwise } from '@phosphor-icons/vue'
import { request } from '../lib/request.js'
import { isRemoteTransport } from '../lib/transport.js'
import PxButton from './PxButton.vue'

const props = defineProps({ taskId: String, services: { type: Array, default: () => [] }, compact: Boolean, visible: { type: Boolean, default: true } })
const emit = defineEmits(['open-terminal', 'changed'])
const busy = ref('')
const error = ref('')
const open = ref(!props.compact)
const trigger = ref(null)
const contentId = useId()
const runningCount = computed(() => props.services.filter(item => item.running && !item.stopping).length)
const showEnded = ref(false)
const failed = item => !item.running && Boolean(item.exitCode) && !item.service.stoppedByUser && !item.service.dismissed
const activeServices = computed(() => props.services.filter(item => item.running || failed(item)))
const endedServices = computed(() => props.services.filter(item => !item.running && !failed(item)))
const failedCount = computed(() => props.services.filter(failed).length)
const visibleServices = computed(() => showEnded.value ? [...activeServices.value, ...endedServices.value] : activeServices.value)
watch(() => props.taskId, () => { showEnded.value = false })
watch(() => activeServices.value.length, (count, old) => { if (!count) open.value = false; else if (!old && !props.compact) open.value = true }, { immediate: true })
async function clearEnded() {
  if (busy.value) return
  busy.value = 'clear'
  try { await request(`/api/v2/tasks/${encodeURIComponent(props.taskId)}/services/clear-ended`, { method: 'POST' }); emit('changed') }
  catch (cause) { error.value = cause.message }
  finally { busy.value = '' }
}
watch(() => props.compact, compact => { open.value = !compact })
watch(() => props.visible, visible => { if (!visible && props.compact) open.value = false })
function collapse() { open.value = false; trigger.value?.focus() }
function showTerminal(id) { if (props.compact) open.value = false; emit('open-terminal', id) }
function taskType(item) { return item.service.type || (item.service.url ? 'web' : /\.app\/Contents\/MacOS\//.test(item.service.command || '') ? 'desktop' : 'process') }
function typeLabel(item) { return { web: 'Web 服务', desktop: '桌面应用', watch: '监听任务', process: '通用进程', remote: '远程连接' }[taskType(item)] || '通用进程' }
function errorSummary(item) {
  const message = item.service.error || ''
  if (/Address already in use/i.test(message) && /(?:local forwarding|channel_setup_fwd_listener)/i.test(message)) return '本地转发端口被占用，SSH 连接未能建立所请求的转发；不能据此判断远程服务是否运行。'
  return message
}
function status(item) {
  if (taskType(item) === 'remote') {
    if (item.stopping) return '正在断开'
    if (!item.running) return item.exitCode && !item.service.stoppedByUser ? '连接失败' : '已断开'
    return item.service.readiness === 'starting' ? '正在启动连接' : '连接进程运行中'
  }
  if (item.stopping) return '正在停止'
  if (!item.running) return item.exitCode && !item.service.stoppedByUser ? '执行失败' : taskType(item) === 'desktop' ? '已退出' : '已停止'
  if (taskType(item) !== 'web') return item.service.readiness === 'starting' ? '正在启动' : '运行中'
  if (item.service.readiness !== 'starting' && !item.service.url) return '运行中 · 页面地址未确认'
  return item.service.readiness === 'ready' ? '运行中 · 地址可访问' : item.service.readiness === 'starting' ? '正在启动' : '运行中 · 地址未确认'
}
function statusTone(item) {
  if (!item.running) return item.exitCode && !item.service.stoppedByUser ? 'failed' : 'stopped'
  return !item.stopping && (taskType(item) !== 'web' || item.service.readiness === 'ready') ? 'ready' : 'pending'
}
async function action(item, type) {
  if (busy.value) return
  busy.value = item.id
  error.value = ''
  try {
    await request(`/api/v2/tasks/${encodeURIComponent(props.taskId)}/terminals/${item.id}/${type}`, { method: 'POST', body: JSON.stringify(type === 'restart' ? { cols: 100, rows: 30 } : {}) })
    emit('changed')
  } catch (cause) { error.value = cause.message }
  finally { busy.value = '' }
}
</script>

<template>
  <section v-if="services.length" class="task-services flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border" aria-label="运行任务" @keydown.esc.stop.prevent="collapse">
    <button ref="trigger" type="button" class="service-heading flex w-full shrink-0 items-center gap-2 px-3 py-2.5 text-left text-xs" aria-label="运行任务" :aria-expanded="open" :aria-controls="contentId" @click="open = !open" @keydown.down.prevent="open = true">
      <PhHardDrives class="theme-muted-text h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span class="flex-1 font-medium">运行任务</span>
      <span class="service-count rounded px-1.5 py-0.5 text-[10px]" :class="{ 'has-running': runningCount }">{{ [runningCount ? `${runningCount} 运行中` : '', failedCount ? `${failedCount} 失败` : '', !activeServices.length ? `${endedServices.length} 已结束` : ''].filter(Boolean).join(' · ') }}</span>
      <PhCaretUp v-if="open" class="theme-muted-text h-3.5 w-3.5" /><PhCaretDown v-else class="theme-muted-text h-3.5 w-3.5" />
    </button>
    <div v-show="open" :id="contentId" class="service-content min-h-0 overflow-y-auto border-t px-3">
      <div v-if="endedServices.length" class="flex items-center justify-between py-2 text-xs"><button type="button" class="theme-muted-text" :aria-expanded="showEnded" @click="showEnded = !showEnded">{{ showEnded ? '收起' : '展开' }}已结束 · {{ endedServices.length }}</button><PxButton variant="ghost" size="sm" :disabled="Boolean(busy)" @click="clearEnded">清空已结束</PxButton></div>
      <article v-for="item in visibleServices" :key="item.id" class="service-item py-3">
        <div class="flex min-w-0 items-start gap-2 text-xs"><strong class="min-w-0 flex-1 break-words font-semibold leading-relaxed" :title="item.name">{{ item.name }}</strong></div>
        <p class="theme-muted-text mt-1 flex items-center gap-1.5 text-[10px]"><span class="service-status-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="statusTone(item)" aria-hidden="true" />{{ typeLabel(item) }} · {{ status(item) }}</p>
        <div v-if="taskType(item) === 'web' && item.service.url" class="service-address mt-2 rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed">{{ item.service.url }}</div>
        <p v-if="taskType(item) === 'web' && isRemoteTransport() && item.service.url" class="theme-muted-text mt-1.5 text-[10px] leading-relaxed">这是电脑上的本地地址，手机需使用可访问的局域网地址或部署地址。</p>
        <p v-if="!item.running && item.service.error" class="theme-status-danger mt-2 whitespace-pre-wrap break-words text-[11px]" role="alert">{{ errorSummary(item) }}</p>
        <p v-if="taskType(item) === 'remote'" class="theme-muted-text mt-1.5 text-[10px] leading-relaxed">这里只跟踪本机连接进程，不代表远程服务健康；停止连接不保证远程程序停止。</p>
        <div class="mt-2.5 flex flex-wrap gap-1">
          <PxButton class="service-action" variant="ghost" size="sm" @click="showTerminal(item.id)"><PhTerminalWindow class="h-3 w-3 shrink-0" aria-hidden="true" />查看日志</PxButton>
          <a v-if="taskType(item) === 'web' && item.running && item.service.url && item.service.readiness === 'ready' && !isRemoteTransport()" :href="item.service.url" target="_blank" rel="noopener noreferrer" class="service-action inline-flex items-center justify-center"><PhArrowSquareOut class="h-3 w-3 shrink-0" aria-hidden="true" />打开页面</a>
          <PxButton v-if="item.running" class="service-action service-stop" variant="ghost" size="sm" :disabled="Boolean(busy) || item.stopping" @click="action(item, 'stop')"><PhSquare class="h-2.5 w-2.5 shrink-0" aria-hidden="true" />停止</PxButton>
          <PxButton v-else class="service-action" variant="ghost" size="sm" :disabled="Boolean(busy)" :loading="busy === item.id" @click="action(item, 'restart')"><PhArrowsClockwise v-if="busy !== item.id" class="h-3 w-3 shrink-0" aria-hidden="true" />重新启动</PxButton>
          <PxButton v-if="failed(item)" class="service-action" variant="ghost" size="sm" :disabled="Boolean(busy)" @click="action(item, 'dismiss')">忽略</PxButton>
        </div>
      </article>
      <p v-if="error" class="theme-status-danger mb-3 rounded p-2 text-xs" role="alert">{{ error }}</p>
    </div>
  </section>
</template>

<style scoped>
.task-services { background: var(--theme-appPanelStrong); color: var(--theme-textPrimary); border-color: var(--theme-borderMuted); box-shadow: 0 4px 16px color-mix(in srgb, var(--theme-textPrimary) 9%, transparent); }
.service-heading { background: transparent; transition: background-color 150ms ease; }
.service-heading:hover { background: color-mix(in srgb, var(--theme-appPanelHover) 50%, var(--theme-appPanelStrong)); }
.service-heading:focus-visible, .service-action:focus-visible { outline: 2px solid var(--theme-focusRing); outline-offset: -2px; }
.service-count { color: var(--theme-textMuted); background: var(--theme-appPanelInset); }
.service-count.has-running { color: var(--theme-successText); background: var(--theme-successSoft); }
.service-content { border-color: var(--theme-borderMuted); }
.service-item + .service-item { border-top: 1px solid var(--theme-borderMuted); }
.service-status-dot { background: var(--theme-textMuted); }
.service-status-dot.ready { background: var(--theme-success); }
.service-status-dot.pending { background: var(--theme-warning); }
.service-status-dot.failed { background: var(--theme-danger); }
.service-address { background: color-mix(in srgb, var(--theme-appPanelInset) 60%, var(--theme-appPanelStrong)); color: var(--theme-textSecondary); overflow-wrap: anywhere; }
.service-action { min-height: 28px; border: 1px solid var(--theme-borderMuted); border-radius: var(--theme-buttonRadius); background: transparent; color: var(--theme-textSecondary); padding: 4px 6px; gap: 4px; font-size: 11px; font-weight: 500; line-height: 1.5; text-decoration: none; transition: background-color 150ms ease, color 150ms ease; }
.service-action:hover:not(:disabled) { background: var(--theme-appPanelHover); color: var(--theme-textPrimary); }
.service-stop:hover:not(:disabled) { background: var(--theme-dangerSoft); color: var(--theme-dangerText); }
</style>
