import { codexToolStatus } from '../../../../../../packages/protocol/src/toolDetails.js'
import { parseJsonLinesWithOffsets, readStableHistoryFileRange, toIsoTimestamp } from '../historySnapshot.js'

function threadRevision(thread) {
  return [thread?.recencyAt, thread?.updatedAt]
    .filter((value) => value !== undefined && value !== null && value !== '')
    .map(String)
    .join(':')
}

function textParts(parts = []) {
  return parts.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('')
}

function normalizedItemType(value) {
  if (typeof value !== 'string' || !value) return ''
  return value[0].toLowerCase() + value.slice(1)
}

function userContent(content = []) {
  const result = []
  for (const block of content) {
    if (block?.type === 'text' && block.text) result.push({ type: 'text', text: block.text })
    else if (block?.type === 'localImage' && block.path) result.push({ type: 'history_image', source: block.path })
    else if (['image', 'input_image'].includes(block?.type)) {
      const source = block.imageUrl || block.image_url?.url || block.image_url || block.url
      if (typeof source === 'string') result.push({ type: 'history_image', source })
    }
  }
  return result
}

export function mapCodexHistoryItem(item, { completed = false } = {}) {
  if (!item?.type || !item.id) return []
  const type = normalizedItemType(item.type)
  if (type === 'userMessage') {
    const content = userContent(item.content || item.message?.content)
    if (!content.length) return []
    return [{
      providerMessageId: item.id,
      item: {
        type: 'user_message',
        clientMessageId: item.clientId || item.client_id || item.id,
        content,
      },
    }]
  }
  if (type === 'agentMessage') {
    const text = item.text || textParts(item.content)
    if (!text) return []
    return [{
      providerMessageId: item.id,
      item: {
        type: 'assistant_message',
        messageId: item.id,
        phase: ['commentary', 'final_answer'].includes(item.phase) ? item.phase : 'unknown',
        text,
      },
    }]
  }
  if (type === 'reasoning') {
    const text = textParts(item.summary) || textParts(item.content)
    return text ? [{ providerMessageId: item.id, item: { type: 'reasoning', messageId: item.id, text } }] : []
  }
  const names = {
    subAgentActivity: '子 Agent 活动',
    collabAgentToolCall: '子 Agent 协作',
    commandExecution: '终端命令',
    fileChange: '文件修改',
    mcpToolCall: item.tool || 'MCP 工具',
    webSearch: '网页搜索',
    imageView: '查看图片',
    imageGeneration: '生成图片',
  }
  if (!names[type]) return []
  return [{
    providerMessageId: item.id,
    item: {
      type: 'tool_call',
      callId: item.id,
      name: names[type],
      status: codexToolStatus(item, completed ? 'completed' : 'running'),
      detail: { type, ...item },
      ...(item.error?.message ? { error: { message: item.error.message } } : {}),
    },
  }]
}

export function mapCodexHistorySnapshot(thread, revision = '') {
  const backgroundTasks = new Map()
  for (const turn of thread.turns || []) for (const item of turn.items || []) {
    if (normalizedItemType(item.type) === 'subAgentActivity' && item.agentThreadId) {
      backgroundTasks.set(item.agentThreadId, { id: item.agentThreadId, originSourceTurnId: turn.id, title: item.agentPath || 'Codex 子 Agent', kind: 'local_agent', status: item.kind === 'completed' ? 'completed' : item.kind === 'failed' ? 'failed' : 'interrupted', historyOnly: true })
    }
    if (normalizedItemType(item.type) === 'collabAgentToolCall') for (const id of item.receiverThreadIds || []) {
      const state = item.agentsStates?.[id]
      backgroundTasks.set(id, { id, originSourceTurnId: backgroundTasks.get(id)?.originSourceTurnId || turn.id, title: item.prompt || backgroundTasks.get(id)?.title || 'Codex 子 Agent', kind: 'local_agent', status: ['completed', 'failed'].includes(state?.status) ? state.status : 'interrupted', summary: state?.message || '', historyOnly: true })
    }
  }
  return {
    backgroundTasks: [...backgroundTasks.values()],
    sourceId: thread.id,
    revision: revision || threadRevision(thread),
    turns: (thread.turns || []).map((turn) => {
      const startedAt = toIsoTimestamp(turn.startedAt)
      const finishedAt = toIsoTimestamp(turn.completedAt || turn.finishedAt)
      const status = turn.status === 'interrupted' ? 'canceled'
        : turn.status === 'inProgress' ? 'running'
          : turn.status
      return {
        sourceTurnId: turn.id || turn.sourceTurnId,
        providerPromptId: turn.id || turn.sourceTurnId,
        runtimeTurnId: turn.id || turn.sourceTurnId,
        status,
        startedAt,
        finishedAt,
        errorMessage: turn.error?.message || '',
        items: (turn.items || []).flatMap((item) => {
          const mapped = item?.item && item?.providerMessageId
            ? [item]
            : mapCodexHistoryItem(item, { completed: status === 'completed' })
          return mapped.map((entry) => ({
            ...entry,
            timestamp: toIsoTimestamp(item.timestamp || item.createdAt) || (entry.item.type === 'user_message' ? startedAt : finishedAt),
          }))
        }),
      }
    }),
  }
}

function rolloutText(value) {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  return value.map((part) => typeof part === 'string' ? part : part?.text || '').filter(Boolean).join('')
}

function rolloutTimestamp(record) {
  return toIsoTimestamp(record?.timestamp || record?.payload?.timestamp || record?.completed_at || record?.payload?.completed_at)
}

function addRolloutItem(turn, item, timestamp, completed = false) {
  const entries = mapCodexHistoryItem(item, { completed })
  for (const entry of entries) {
    if (turn.items.some((existing) => existing.providerMessageId === entry.providerMessageId)) continue
    turn.items.push({ ...entry, timestamp: timestamp || turn.finishedAt || turn.startedAt })
  }
}

function addRolloutMessage(turn, id, role, content, phase, timestamp) {
  const text = rolloutText(content)
  const blocks = Array.isArray(content) ? content.map(block => block?.type === 'input_text' ? { type: 'text', text: block.text } : block) : [{ type: 'text', text }]
  if (!id || (!text && !userContent(blocks).length) || !['user', 'assistant'].includes(role)) return
  addRolloutItem(turn, {
    id,
    type: role === 'user' ? 'userMessage' : 'agentMessage',
    ...(role === 'user' ? { client_id: id, content: blocks } : { phase, text }),
  }, timestamp)
}

function rolloutTurnId(record, fallback = '') {
  return String(
    record?.payload?.turn_id
    || record?.payload?.turnId
    || record?.turn_id
    || record?.turnId
    || fallback
    || 'codex-turn:unknown',
  )
}

// Codex 0.15x stores paginated threads as an append-only rollout JSONL. This
// parser intentionally consumes only durable events and ignores prompt/context
// metadata, so importing a session never replays developer instructions.
export function mapCodexRolloutSnapshot(thread, content, revision = '') {
  const turns = []
  const byId = new Map()
  let currentTurnId = ''
  const getTurn = (id, timestamp) => {
    const turnId = rolloutTurnId({ turn_id: id }, currentTurnId)
    let turn = byId.get(turnId)
    if (!turn) {
      turn = { sourceTurnId: turnId, status: 'running', startedAt: timestamp, finishedAt: timestamp, items: [] }
      byId.set(turnId, turn)
      turns.push(turn)
    }
    if (!turn.startedAt && timestamp) turn.startedAt = timestamp
    if (timestamp) turn.finishedAt = timestamp
    currentTurnId = turnId
    return turn
  }

  const records = String(content || '').split(/\r?\n/).flatMap((line) => {
    if (!line.trim()) return []
    try { return [JSON.parse(line)] } catch { return [] }
  })
  const hasDurableEventItems = records.some((record) => (
    record.type === 'event_msg'
    && ['item_completed', 'user_message', 'agent_message', 'agent_reasoning'].includes(record.payload?.type)
  ))

  for (const record of records) {
    const timestamp = rolloutTimestamp(record)
    const payload = record.payload || {}
    const eventType = record.type === 'event_msg' ? payload.type : ''
    if (eventType === 'task_started') {
      const turn = getTurn(payload.turn_id, timestamp)
      turn.status = 'running'
      continue
    }
    if (eventType === 'item_completed') {
      const turn = getTurn(payload.turn_id, timestamp)
      addRolloutItem(turn, payload.item, timestamp, true)
      continue
    }
    if (eventType === 'task_complete' || eventType === 'turn_completed') {
      const turn = getTurn(payload.turn_id, timestamp)
      turn.status = 'completed'
      turn.finishedAt = timestamp || turn.finishedAt
      continue
    }
    if (eventType === 'turn_aborted' || eventType === 'turn_canceled') {
      const turn = getTurn(payload.turn_id, timestamp)
      turn.status = 'canceled'
      turn.finishedAt = timestamp || turn.finishedAt
      continue
    }
    if (eventType === 'error' && payload.error && !payload.willRetry) {
      const turn = getTurn(payload.turn_id, timestamp)
      turn.status = 'failed'
      turn.errorMessage = payload.error.message || ''
      turn.finishedAt = timestamp || turn.finishedAt
      continue
    }
    if (eventType === 'user_message' || eventType === 'agent_message') {
      const turn = getTurn(payload.turn_id, timestamp)
      const message = eventType === 'user_message'
        ? [{ type: 'text', text: rolloutText(payload.message) },
            ...(payload.local_images || []).map(path => ({ type: 'localImage', path })),
            ...(payload.images || []).map(image => typeof image === 'string' ? { type: 'image', image_url: image } : image)]
        : payload.message
      addRolloutMessage(turn, `${turn.sourceTurnId}:${eventType}:${turn.items.length}`, eventType === 'user_message' ? 'user' : 'assistant',
        message, payload.phase, timestamp)
      continue
    }
    if (eventType === 'agent_reasoning') {
      const turn = getTurn(payload.turn_id, timestamp)
      const text = rolloutText(payload.text)
      if (text) addRolloutItem(turn, { id: `${turn.sourceTurnId}:reasoning:${turn.items.length}`, type: 'reasoning', content: [{ type: 'text', text }] }, timestamp)
      continue
    }

    // Older rollout files expose the response stream directly. Keep this
    // compatibility path for sessions created before item_completed existed.
    if (!hasDurableEventItems && record.type === 'response_item') {
      const turn = getTurn(rolloutTurnId(record), timestamp)
      if (payload.type === 'message') {
        addRolloutMessage(turn, payload.id || `message:${turn.items.length}`, payload.role, payload.content,
          payload.phase, timestamp)
      } else if (payload.type === 'reasoning') {
        const text = rolloutText(payload.summary) || rolloutText(payload.content)
        if (text) addRolloutItem(turn, { id: payload.id || `reasoning:${turn.items.length}`, type: 'reasoning', content: [{ type: 'text', text }] }, timestamp)
      } else if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
        addRolloutItem(turn, {
          id: payload.call_id || payload.id || `tool:${turn.items.length}`,
          type: 'mcpToolCall',
          tool: payload.name || '工具调用',
          status: 'running',
          arguments: payload.arguments ?? payload.input,
        }, timestamp)
      } else if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
        const callId = payload.call_id || payload.id
        const target = turn.items.find(entry => entry.item?.callId === callId)
        if (target) {
          target.item.detail.result = payload.output
          target.item.status = payload.is_error ? 'failed' : 'completed'
        }
      }
    }
  }
  return mapCodexHistorySnapshot({ id: thread.id, turns }, revision)
}

function isPaginatedThreadsError(error) {
  return /paginated_threads/i.test(error?.message || '')
}

export async function readCodexHistorySnapshot(runtime, { knownRevision = '', cursor = 0 } = {}) {
  await runtime.connect()
  const metadata = await runtime.rpc.request('thread/read', { threadId: runtime.threadId, includeTurns: false })
  await runtime.refreshContextUsageFromHistory?.(metadata.thread?.path)
  try {
    const result = await runtime.rpc.request('thread/read', { threadId: runtime.threadId, includeTurns: true })
    return mapCodexHistorySnapshot(result.thread, threadRevision(result.thread) || threadRevision(metadata.thread))
  } catch (error) {
    if (!isPaginatedThreadsError(error)) throw error
    const file = metadata.thread?.path
    if (!file) throw error
    const persisted = readStableHistoryFileRange(file, { knownRevision, cursor })
    if (persisted.status === 'unchanged') return persisted
    if (persisted.status !== 'ready') {
      return { status: 'unavailable', revision: persisted.revision || threadRevision(metadata.thread) }
    }
    const snapshot = mapCodexRolloutSnapshot(metadata.thread, persisted.content, persisted.revision)
    const records = parseJsonLinesWithOffsets(persisted.content, persisted.baseOffset)
    let safeCursor = persisted.content.endsWith('\n')
      ? persisted.endOffset
      : persisted.baseOffset + Buffer.byteLength(persisted.content.slice(0, Math.max(0, persisted.content.lastIndexOf('\n') + 1)))
    if (snapshot.turns.at(-1)?.status === 'running') {
      const start = [...records].reverse().find(({ value }) => value.type === 'event_msg' && value.payload?.type === 'task_started')
      if (start) safeCursor = start.offset
    }
    return {
      ...snapshot,
      completeness: persisted.baseOffset > 0 && !persisted.reset ? 'incremental' : 'full',
      cursor: safeCursor,
    }
  }
}
