import { randomUUID } from 'node:crypto'
import { taskStatus } from './backgroundTasks.js'
import { createAcpProvider } from './acp.js'
import { listGrokHistorySessions, readGrokHistorySnapshot } from '../history/providers/grokHistory.js'

export const GROK_ACP_ARGS = Object.freeze(['agent', '--always-approve', '--no-leader', 'stdio'])

export function grokExtensionNotification(method, params) {
  if (method !== '_x.ai/session/update') return null
  const update = params.update
  if (update?.sessionUpdate !== 'retry_state' || update.type !== 'retrying') return null
  return { type: 'system_notice', code: 'provider_retrying', text: update.reason || '模型服务连接异常，正在自动重试。' }
}

// Grok 的子任务是厂商扩展，不能让通用 ACP 层猜测普通工具名称。
export function grokRuntimeExtension(runtime, method, params) {
  if (method === 'stopBackgroundTasks') return (async () => {
    const results = await Promise.allSettled(runtime.backgroundTasks.running.map(async task => {
      if (!task.childSessionId) throw new Error('后台任务缺少可停止的子会话标识。')
      await runtime.connection.extMethod('_x.ai/session/close', { sessionId: task.childSessionId })
      runtime.backgroundTasks.update({ id: task.id, status: 'canceled', summary: '子会话已关闭' })
    }))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'))
  })()
  const update = params.update || {}
  if (method === 'session/update' && !runtime.activeRunId && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(update.sessionUpdate)) {
    runtime.activeRunId = `grok:auto:${params._meta?.eventId || update._meta?.eventId || randomUUID()}`
    runtime.autonomousRun = true
    runtime.emit('turnStarted', { nativeTurnId: runtime.activeRunId, autonomous: true })
    return
  }
  if (method !== '_x.ai/session_notification') return
  if (update.sessionUpdate === 'turn_completed' && runtime.autonomousRun) {
    const nativeTurnId = runtime.activeRunId
    runtime.activeRunId = null
    runtime.autonomousRun = false
    if (update.stop_reason === 'cancelled') runtime.emit('turnCanceled', { nativeTurnId })
    else if (update.stop_reason === 'error') runtime.emit('turnFailed', Object.assign(new Error(update.agent_result || 'Grok 自动续跑失败'), { nativeTurnId }))
    else runtime.emit('turnCompleted', { nativeTurnId, usage: update.usage || {} })
    return
  }
  const id = update.subagent_id
  if (update.sessionUpdate === 'subagent_spawned') {
    runtime.backgroundTasks.update({ id, title: update.description || 'Grok 子 Agent', kind: 'local_agent', status: 'running', background: true, attemptId: update.attempt_id, childSessionId: update.child_session_id })
  } else if (id && runtime.backgroundTasks.tasks.has(id)) {
    const task = runtime.backgroundTasks.tasks.get(id)
    if (update.attempt_id && task.attemptId !== update.attempt_id) return
    if (update.sessionUpdate === 'subagent_finished') runtime.backgroundTasks.update({ id, status: taskStatus(update.status), summary: update.output || '', usage: { tokens: update.tokens_used, durationMs: update.duration_ms } })
    if (update.sessionUpdate === 'subagent_progress') runtime.backgroundTasks.update({ id, usage: { tokens: update.tokens_used, durationMs: update.duration_ms } })
  }
}

export const grokProvider = createAcpProvider({
  id: 'grok',
  label: 'Grok',
  command: () => process.env.GROK_BIN || 'grok',
  args: () => GROK_ACP_ARGS,
  capabilities: { backgroundTasks: true, backgroundTaskDetails: true, stopBackgroundTasks: true, autonomousTurns: true, resume: true, images: true, models: true, reasoningEffort: true, contextUsage: false },
  // Grok CLI 声明 image: false；参考 Paseo 直接发送标准图片块，由接口决定是否接受。
  allowUndeclaredImages: true,
  extensionNotification: grokExtensionNotification,
  runtimeExtension: grokRuntimeExtension,
  readHistorySnapshot: readGrokHistorySnapshot,
  listHistorySessions: listGrokHistorySessions,
})
