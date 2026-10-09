<script setup>
import { computed, ref, useId, watch } from 'vue'
import { TerminalSquare, ExternalLink, Server, ChevronDown, ChevronUp, Square, RotateCw } from 'lucide-vue-next'
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
watch(() => props.compact, compact => { open.value = !compact })
watch(() => props.visible, visible => { if (!visible && props.compact) open.value = false })
function collapse() { open.value = false; trigger.value?.focus() }
function showTerminal(id) { if (props.compact) open.value = false; emit('open-terminal', id) }
function status(item) {
  if (item.stopping) return '正在停止'
  if (!item.running) return item.exitCode ? '启动失败 / 已退出' : '已停止'
  return item.service.readiness === 'ready' ? '运行中 · 地址可访问' : item.service.readiness === 'starting' ? '正在启动' : '运行中 · 地址未确认'
}
function statusTone(item) {
  if (!item.running) return item.exitCode ? 'failed' : 'stopped'
  return !item.stopping && item.service.readiness === 'ready' ? 'ready' : 'pending'
}
async function action(item, type) {
  if (busy.value) return
  busy.value = item.id
  error.value = ''
  try {
    const result = await request(`/api/v2/tasks/${encodeURIComponent(props.taskId)}/terminals/${item.id}/${type}`, { method: 'POST', body: JSON.stringify(type === 'restart' ? { cols: 100, rows: 30 } : {}) })
    emit('changed')
    if (type === 'restart') showTerminal(result.terminal.id)
  } catch (cause) { error.value = cause.message }
  finally { busy.value = '' }
}
</script>

<template>
  <section v-if="services.length" class="task-services flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border" aria-label="会话服务" @keydown.esc.stop.prevent="collapse">
    <button ref="trigger" type="button" class="service-heading flex w-full shrink-0 items-center gap-2 px-3 py-2.5 text-left text-xs" aria-label="会话服务" :aria-expanded="open" :aria-controls="contentId" @click="open = !open" @keydown.down.prevent="open = true">
      <Server class="theme-muted-text h-3.5 w-3.5 shrink-0" aria-hidden="true" /><span class="flex-1 font-medium">会话服务</span>
      <span class="service-count rounded px-1.5 py-0.5 text-[10px]" :class="{ 'has-running': runningCount }">{{ runningCount ? `${runningCount} 运行中` : `${services.length} 个服务` }}</span>
      <ChevronUp v-if="open" class="theme-muted-text h-3.5 w-3.5" /><ChevronDown v-else class="theme-muted-text h-3.5 w-3.5" />
    </button>
    <div v-show="open" :id="contentId" class="service-content min-h-0 overflow-y-auto border-t px-3">
      <article v-for="item in services" :key="item.id" class="service-item py-3">
        <div class="flex min-w-0 items-start gap-2 text-xs"><strong class="min-w-0 flex-1 break-words font-semibold leading-relaxed" :title="item.name">{{ item.name }}</strong></div>
        <p class="theme-muted-text mt-1 flex items-center gap-1.5 text-[10px]"><span class="service-status-dot h-1.5 w-1.5 shrink-0 rounded-full" :class="statusTone(item)" aria-hidden="true" />{{ status(item) }}</p>
        <div v-if="item.service.url" class="service-address mt-2 rounded px-2 py-1.5 font-mono text-[11px] leading-relaxed">{{ item.service.url }}</div>
        <p v-if="isRemoteTransport() && item.service.url" class="theme-muted-text mt-1.5 text-[10px] leading-relaxed">这是电脑上的本地地址，手机需使用可访问的局域网地址或部署地址。</p>
        <div class="mt-2.5 flex flex-wrap gap-1">
          <PxButton class="service-action" variant="ghost" size="sm" @click="showTerminal(item.id)"><TerminalSquare class="h-3 w-3 shrink-0" aria-hidden="true" />查看终端</PxButton>
          <a v-if="item.running && item.service.readiness === 'ready' && !isRemoteTransport()" :href="item.service.url" target="_blank" rel="noopener noreferrer" class="service-action inline-flex items-center justify-center"><ExternalLink class="h-3 w-3 shrink-0" aria-hidden="true" />打开页面</a>
          <PxButton v-if="item.running" class="service-action service-stop" variant="ghost" size="sm" :disabled="Boolean(busy) || item.stopping" @click="action(item, 'stop')"><Square class="h-2.5 w-2.5 shrink-0" aria-hidden="true" />停止服务</PxButton>
          <PxButton v-else class="service-action" variant="ghost" size="sm" :disabled="Boolean(busy)" :loading="busy === item.id" @click="action(item, 'restart')"><RotateCw v-if="busy !== item.id" class="h-3 w-3 shrink-0" aria-hidden="true" />重新启动服务</PxButton>
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
