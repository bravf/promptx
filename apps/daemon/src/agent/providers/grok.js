import { randomUUID } from 'node:crypto'
import { taskStatus } from './backgroundTasks.js'
import { createAcpProvider } from './acp.js'
import { grokWorkflowForPrompt, grokWorkflowTask } from './grokWorkflow.js'
import { normalizeInteractionQuestions } from '../../../../../packages/protocol/src/interaction.js'
import { listGrokHistorySessions, readGrokHistorySnapshot } from '../history/providers/grokHistory.js'

export const GROK_ACP_ARGS = Object.freeze(['agent', '--always-approve', '--no-leader', 'stdio'])

// Grok 的问答通过独立 ACP 扩展回调，普通权限自动批准不会回答此请求。
export function grokExtensionRequest(runtime, method, params) {
  if (method !== '_x.ai/ask_user_question') return undefined
  const questions = normalizeInteractionQuestions((params.questions || []).map((question, index) => ({
    ...question, id: String(index), multiSelect: question.multiSelect === true,
  })), { allowOther: true })
  return runtime.interactions.ask({ kind: 'question', title: '需要你回答', questions }, {
    signal: runtime.connection?.signal,
    respond: (response, answers) => response.decision === 'answer'
      ? { outcome: 'accepted', answers: Object.fromEntries(questions.map(question => [question.question, answers[question.id]])), annotations: {} }
      : { outcome: 'declined' },
  })
}

export function grokExtensionNotification(method, params) {
  if (method !== '_x.ai/session/update') return null
  const update = params.update
  if (update?.sessionUpdate !== 'retry_state' || update.type !== 'retrying') return null
  return { type: 'system_notice', code: 'provider_retrying', text: update.reason || '模型服务连接异常，正在自动重试。' }
}

// Grok 的子任务是厂商扩展，不能让通用 ACP 层猜测普通工具名称。
export function grokRuntimeExtension(runtime, method, params) {
  if (method === 'stopBackgroundTasks') return (async () => {
    const tasks = runtime.backgroundTasks.running
    const operations = tasks.filter(task => task.kind !== 'workflow').map(async task => {
      if (!task.childSessionId) throw new Error('后台任务缺少可停止的子会话标识。')
      await runtime.connection.extMethod('_x.ai/session/close', { sessionId: task.childSessionId })
      runtime.backgroundTasks.update({ id: task.id, status: 'canceled', summary: '子会话已关闭' })
    })
    // 工作流在阶段间可能没有子会话，仍须取消父会话；等待原生终态确认后才解锁。
    if (tasks.some(task => task.kind === 'workflow')) operations.push(runtime.cancel())
    const results = await Promise.allSettled(operations)
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'))
  })()
  const update = params.update || {}
  if (['_x.ai/session_notification', '_x.ai/session/update'].includes(method)) {
    if (update.sessionUpdate === 'workflow_updated') {
      const task = grokWorkflowTask(update, runtime.backgroundTasks.tasks.get(`grok-workflow:${update.run_id}`))
      if (task) runtime.backgroundTasks.update(task)
      return
    }
    if (update.sessionUpdate === 'turn_completed') {
      const workflow = grokWorkflowForPrompt(runtime.backgroundTasks.tasks.values(), update.prompt_id || update.promptId)
      if (workflow) runtime.backgroundTasks.update({ id: workflow.id, status: ['cancelled', 'canceled'].includes(update.stop_reason) ? 'canceled' : update.stop_reason === 'error' ? 'failed' : 'completed', awaitingSummary: false })
    }
  }
  if (method === 'session/update' && !runtime.activeRunId && ['agent_message_chunk', 'agent_thought_chunk', 'tool_call'].includes(update.sessionUpdate)) {
    runtime.activeRunId = `grok:auto:${params._meta?.eventId || update._meta?.eventId || randomUUID()}`
    runtime.autonomousRun = true
    runtime.emit('turnStarted', { nativeTurnId: runtime.activeRunId, autonomous: true })
    return
  }
  if (!['_x.ai/session_notification', '_x.ai/session/update'].includes(method)) return
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
    runtime.backgroundTasks.update({ id, title: update.description || 'Grok 子 Agent', kind: 'local_agent', status: 'running', background: true, workflowId: update.workflow_run_id, attemptId: update.attempt_id, childSessionId: update.child_session_id })
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
  extensionRequest: grokExtensionRequest,
  runtimeExtension: grokRuntimeExtension,
  readHistorySnapshot: readGrokHistorySnapshot,
  listHistorySessions: listGrokHistorySessions,
})
