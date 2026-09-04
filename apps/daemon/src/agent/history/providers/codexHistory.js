import { toIsoTimestamp } from '../historySnapshot.js'

function threadRevision(thread) {
  return String(thread?.recencyAt || thread?.updatedAt || '')
}

function textParts(parts = []) {
  return parts.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('')
}

function toolStatus(value) {
  if (['completed', 'failed', 'canceled'].includes(value)) return value
  if (value === 'declined') return 'canceled'
  return 'running'
}

function userContent(content = []) {
  const result = []
  for (const block of content) {
    if (block?.type === 'text' && block.text) result.push({ type: 'text', text: block.text })
    else if (block?.type === 'localImage' && block.path) result.push({ type: 'text', text: `[图片] ${block.path}` })
  }
  return result
}

export function mapCodexHistoryItem(item) {
  if (!item?.type || !item.id) return []
  if (item.type === 'userMessage') {
    const content = userContent(item.content)
    if (!content.length) return []
    return [{
      providerMessageId: item.id,
      item: {
        type: 'user_message',
        clientMessageId: item.clientId || item.id,
        content,
      },
    }]
  }
  if (item.type === 'agentMessage') {
    if (!item.text) return []
    return [{
      providerMessageId: item.id,
      item: {
        type: 'assistant_message',
        messageId: item.id,
        phase: ['commentary', 'final_answer'].includes(item.phase) ? item.phase : 'unknown',
        text: item.text,
      },
    }]
  }
  if (item.type === 'reasoning') {
    const text = textParts(item.summary) || textParts(item.content)
    return text ? [{ providerMessageId: item.id, item: { type: 'reasoning', messageId: item.id, text } }] : []
  }
  const names = {
    commandExecution: '终端命令',
    fileChange: '文件修改',
    mcpToolCall: item.tool || 'MCP 工具',
    webSearch: '网页搜索',
    imageView: '查看图片',
    imageGeneration: '生成图片',
  }
  if (!names[item.type]) return []
  return [{
    providerMessageId: item.id,
    item: {
      type: 'tool_call',
      callId: item.id,
      name: names[item.type],
      status: toolStatus(item.status),
      detail: { type: item.type, ...item },
      ...(item.error?.message ? { error: { message: item.error.message } } : {}),
    },
  }]
}

export function mapCodexHistorySnapshot(thread, revision = '') {
  return {
    sourceId: thread.id,
    revision: revision || threadRevision(thread),
    turns: (thread.turns || []).map((turn) => {
      const startedAt = toIsoTimestamp(turn.startedAt)
      const finishedAt = toIsoTimestamp(turn.completedAt)
      const status = turn.status === 'interrupted' ? 'canceled'
        : turn.status === 'inProgress' ? 'running'
          : turn.status
      return {
        sourceTurnId: turn.id,
        status,
        startedAt,
        finishedAt,
        errorMessage: turn.error?.message || '',
        items: (turn.items || []).flatMap((item) => mapCodexHistoryItem(item).map((entry) => ({
          ...entry,
          timestamp: toIsoTimestamp(item.timestamp || item.createdAt) || (entry.item.type === 'user_message' ? startedAt : finishedAt),
        }))),
      }
    }),
  }
}

export async function readCodexHistorySnapshot(runtime, { knownRevision = '' } = {}) {
  await runtime.connect()
  const metadata = await runtime.rpc.request('thread/read', { threadId: runtime.threadId, includeTurns: false })
  const revision = threadRevision(metadata.thread)
  if (knownRevision && revision && revision === knownRevision) return { status: 'unchanged' }
  const result = await runtime.rpc.request('thread/read', { threadId: runtime.threadId, includeTurns: true })
  return mapCodexHistorySnapshot(result.thread, threadRevision(result.thread) || revision)
}
