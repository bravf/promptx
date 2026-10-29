export function grokWorkflowTask(update, previous = {}) {
  if (!update.run_id) return null
  if (Number.isFinite(previous.revision) && update.revision < previous.revision) return null
  const complete = ['complete', 'completed'].includes(update.status)
  const awaitingSummary = complete && update.foreground !== true
  const status = complete ? (awaitingSummary ? 'running' : 'completed')
    : ({ failed: 'failed', cancelled: 'canceled', canceled: 'canceled', interrupted: 'interrupted' })[update.status] || 'running'
  // 重复及乱序通知不能重新打开已经结束的工作流。
  if (['completed', 'failed', 'canceled', 'interrupted'].includes(previous.status) && previous.revision === update.revision) return null
  return {
    id: `grok-workflow:${update.run_id}`, workflowId: update.run_id, kind: 'workflow',
    title: update.name || '研究工作流', background: true, status, revision: update.revision,
    awaitingSummary, summary: awaitingSummary ? '子任务已结束，等待主 Agent 完成最终汇总。' : update.result_summary || '',
  }
}

export function grokWorkflowForPrompt(tasks, promptId) {
  return [...tasks].find(task => task.kind === 'workflow' && task.awaitingSummary
    && promptId === `workflow-completed-${task.workflowId}-${task.revision}`)
}
