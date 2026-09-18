// 标准 ACP 事件的纯转换；实时流与 Provider 历史适配器共用。
export function acpContentText(content) {
  if (!content) return ''
  if (typeof content === 'string') return content
  if (content.type === 'text') return content.text || ''
  if (Array.isArray(content)) return content.map(acpContentText).filter(Boolean).join('\n')
  if (content.content) return acpContentText(content.content)
  return typeof content.text === 'string' ? content.text : ''
}

export function mergeAcpToolCall(previous, update) {
  const statuses = { in_progress: 'running', pending: 'running', cancelled: 'canceled', error: 'failed' }
  const status = statuses[update.status] || update.status || previous?.status || 'running'
  const detail = { ...previous?.detail, type: 'acp_tool' }
  for (const key of ['kind', 'content', 'rawInput', 'rawOutput', 'locations']) {
    if (update[key] !== undefined) detail[key] = update[key]
  }
  return {
    type: 'tool_call',
    callId: update.toolCallId || previous?.callId,
    name: update.title || previous?.name || '工具调用',
    status,
    detail,
    ...(status === 'failed' ? { error: { message: acpContentText(detail.content) || previous?.error?.message || '工具调用失败' } } : {}),
  }
}
