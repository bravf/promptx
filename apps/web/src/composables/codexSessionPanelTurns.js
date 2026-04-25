import {
  AGENT_RUN_ENVELOPE_EVENT_TYPES,
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_ITEM_TYPES,
  normalizeAgentRunEnvelopeEventType,
} from '@promptx/shared'
import { getCurrentLocale, translate } from './useI18n.js'
import { resolveAssetUrl } from '../lib/api.js'
import { getAgentEngineLabel, normalizeAgentEngine } from '../lib/agentEngines.js'
import { parseProcessDetailTextBlocks, sanitizeProcessDetailText } from '../lib/processDetailBlocks.js'

const ACTIVE_TURN_STATUSES = new Set(['queued', 'starting', 'running', 'stopping'])

function isEnglishLocale() {
  return getCurrentLocale() === 'en-US'
}

function text(zh, en) {
  return isEnglishLocale() ? en : zh
}

function resolveRunnerMessage(payload = {}) {
  const messageKey = String(payload?.messageKey || '').trim()
  if (messageKey) {
    const params = payload?.messageParams && typeof payload.messageParams === 'object'
      ? payload.messageParams
      : {}
    const translated = translate(messageKey, params)
    if (translated && translated !== messageKey) {
      return translated
    }
  }
  return String(payload?.message || '').trim()
}

function getDateOrderValue(value = '') {
  const timestamp = Date.parse(String(value || ''))
  return Number.isFinite(timestamp) ? timestamp : 0
}

export function sortSessions(items = [], currentSessionId = '') {
  return [...items].sort((left, right) => {
    const runningDiff = Number(Boolean(right?.running)) - Number(Boolean(left?.running))
    if (runningDiff) {
      return runningDiff
    }

    const currentDiff = Number(right?.id === currentSessionId) - Number(left?.id === currentSessionId)
    if (currentDiff) {
      return currentDiff
    }

    const updatedDiff = getDateOrderValue(right.updatedAt) - getDateOrderValue(left.updatedAt)
    if (updatedDiff) {
      return updatedDiff
    }

    return String(left.title || left.cwd || left.id).localeCompare(String(right.title || right.cwd || right.id), getCurrentLocale())
  })
}

function formatCommandOutput(output = '', maxLines = 24, maxChars = 2400) {
  const normalized = sanitizeProcessDetailText(output).trim()
  if (!normalized) {
    return ''
  }

  const lines = normalized.split('\n')
  let nextText = lines.slice(0, maxLines).join('\n')

  if (nextText.length > maxChars) {
    nextText = `${nextText.slice(0, maxChars).trimEnd()}...`
  }

  if (lines.length > maxLines) {
    return `${nextText}\n...`
  }

  return nextText
}

function formatTodoItems(items = []) {
  const list = Array.isArray(items) ? items : []
  if (!list.length) {
    return ''
  }

  return list
    .map((item) => {
      const status = String(item?.status || '').trim().toLowerCase()
      const marker = item.completed
        ? '[x]'
        : (status === 'in_progress' ? '[-]' : '[ ]')
      return `${marker} ${item.text || text('未命名任务', 'Untitled Task')}`
    })
    .join('\n')
}

function formatCount(value = 0) {
  const number = Number(value || 0)
  if (!Number.isFinite(number)) {
    return '0'
  }
  return number.toLocaleString(getCurrentLocale())
}

function isShellEngineValue(value = '') {
  return String(value || '').trim().toLowerCase() === 'shell'
}

function getDisplayEngineLabel(engine = '') {
  return isShellEngineValue(engine) ? text('Shell', 'Shell') : getAgentEngineLabel(engine)
}

function normalizeCollabAgentStatus(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(normalized)) {
    return 'completed'
  }
  if (['failed', 'error', 'errored', 'cancelled', 'canceled', 'stopped'].includes(normalized)) {
    return 'failed'
  }
  if (['running', 'in_progress', 'in-progress'].includes(normalized)) {
    return 'running'
  }
  if (['pending_init', 'pending'].includes(normalized)) {
    return 'pending_init'
  }
  return normalized || 'pending_init'
}

function getCollabAgentIds(item = {}) {
  const ids = []
  const pushId = (value) => {
    const normalized = String(value || '').trim()
    if (!normalized || ids.includes(normalized)) {
      return
    }
    ids.push(normalized)
  }

  ;(Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []).forEach(pushId)

  if (item.agents_states && typeof item.agents_states === 'object') {
    Object.keys(item.agents_states).forEach(pushId)
  }

  return ids
}

function getCollabAgentCount(item = {}) {
  return getCollabAgentIds(item).length
}

function getCollabAgentItems(item = {}) {
  const agentIds = getCollabAgentIds(item)
  const states = item.agents_states && typeof item.agents_states === 'object'
    ? item.agents_states
    : {}

  return agentIds.map((agentId) => {
    const state = states[agentId] && typeof states[agentId] === 'object'
      ? states[agentId]
      : {}
    const message = String(state.message || state.result || '').trim()
    return {
      id: agentId,
      status: normalizeCollabAgentStatus(state.status),
      title: String(state.title || state.description || state.name || '').trim(),
      role: String(state.role || state.subagent_type || state.agent || '').trim(),
      target: String(state.target || state.path || '').trim(),
      model: String(state.model || '').trim(),
      message,
      messageBlocks: message ? buildDetailBlocksFromText(message) : [],
    }
  })
}

function summarizeCollabAgentMessages(item = {}, limit = 120) {
  const messages = getCollabAgentItems(item)
    .map((agent) => agent.message)
    .filter(Boolean)
  return summarizeText(messages.join(isEnglishLocale() ? ' | ' : '｜'), limit)
}

export function formatElapsedDuration(value = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(value) || 0))
  if (totalSeconds < 66) {
    return `${totalSeconds}s`
  }

  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return isEnglishLocale()
      ? `${hours}h ${minutes}m ${seconds}s`
      : `${hours}小时${minutes}分${seconds}秒`
  }

  return isEnglishLocale()
    ? `${minutes}m ${seconds}s`
    : `${minutes}分${seconds}秒`
}

function summarizeText(value = '', limit = 140) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  if (!text) {
    return ''
  }
  if (text.length <= limit) {
    return text
  }
  return `${text.slice(0, limit)}...`
}

function formatMultilineList(prefix = '', items = []) {
  const list = items.filter(Boolean)
  if (!list.length) {
    return ''
  }

  const body = list.map((item) => `- ${item}`).join('\n')
  return prefix ? `${prefix}\n${body}` : body
}

function createMetaBlock(items = []) {
  const normalizedItems = items
    .map((item) => ({
      label: String(item?.label || '').trim(),
      value: String(item?.value || '').trim(),
    }))
    .filter((item) => item.label && item.value)

  if (!normalizedItems.length) {
    return null
  }

  return {
    type: 'meta',
    items: normalizedItems,
  }
}

function normalizeTodoStatus(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  if (['done', 'completed', 'complete', 'checked'].includes(normalized)) {
    return 'completed'
  }
  if (['in_progress', 'in-progress', 'active', 'doing', 'running'].includes(normalized)) {
    return 'in_progress'
  }
  return 'pending'
}

function normalizeTodoText(entry = {}) {
  const candidates = [
    entry?.text,
    entry?.content,
    entry?.title,
    entry?.label,
    entry?.activeForm,
  ]

  return candidates
    .map((value) => String(value || '').trim())
    .find(Boolean) || text('未命名任务', 'Untitled Task')
}

function mapTodoEntries(entries = []) {
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const status = normalizeTodoStatus(entry.status ?? (entry.completed ? 'completed' : 'pending'))
      return {
        completed: status === 'completed',
        status,
        text: normalizeTodoText(entry),
      }
    })
    .filter(Boolean)
}

function parseTodoEntriesFromJson(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return []
  }

  try {
    const parsed = JSON.parse(normalized)
    if (Array.isArray(parsed)) {
      return mapTodoEntries(parsed)
    }

    if (parsed && typeof parsed === 'object') {
      if (Array.isArray(parsed.todos)) {
        return mapTodoEntries(parsed.todos)
      }

      if (Array.isArray(parsed.items)) {
        return mapTodoEntries(parsed.items)
      }
    }
  } catch {
    return []
  }

  return []
}

function buildChecklistBlock(items = []) {
  const list = Array.isArray(items) ? items.filter(Boolean) : []
  if (!list.length) {
    return null
  }

  return {
    type: 'checklist',
    items: list,
    totalCount: list.length,
    hiddenCount: 0,
  }
}

function parseToolCommand(command = '') {
  const raw = String(command || '').trim()
  const separatorIndex = raw.indexOf(':')
  const hasNamedPrefix = separatorIndex > 0 && separatorIndex <= 24
  const toolName = hasNamedPrefix ? raw.slice(0, separatorIndex).trim() : ''
  const subject = hasNamedPrefix ? raw.slice(separatorIndex + 1).trim() : raw
  const normalizedTool = toolName.toLowerCase()

  const aliasGroups = {
    shell: ['bash', 'shell', 'sh', 'terminal', 'cmd', 'powershell'],
    read: ['read', 'open', 'view', 'cat'],
    grep: ['grep', 'rg', 'search', 'find'],
    list: ['glob', 'ls', 'dir', 'tree', 'list'],
    web: ['websearch', 'web_search', 'webfetch', 'fetch', 'browse', 'open_page'],
    todo: ['todowrite', 'todo', 'tasklist', 'tasks'],
    edit: ['edit', 'multiedit', 'write', 'patch', 'apply_patch', 'replace', 'create'],
  }

  const category = hasNamedPrefix
    ? (Object.entries(aliasGroups).find(([, aliases]) => aliases.includes(normalizedTool))?.[0] || 'generic')
    : 'shell'

  return {
    raw,
    toolName,
    normalizedTool,
    subject,
    category,
  }
}

function extractTodoEntriesFromCommandItem(item = {}, parsedCommand = null) {
  const parsed = parsedCommand || parseToolCommand(item.command)
  if (parsed.category !== 'todo') {
    return []
  }

  const fromOutput = parseTodoEntriesFromJson(item.aggregated_output)
  if (fromOutput.length) {
    return fromOutput
  }

  return parseTodoEntriesFromJson(parsed.subject)
}

function buildDetailBlocksFromText(detail = '', options = {}) {
  return parseProcessDetailTextBlocks(sanitizeProcessDetailText(detail), options)
}

function buildWebSearchDetailBlocks(item = {}) {
  const action = item.action || {}
  const query = String(item.query || action.query || '').trim()
  const queries = Array.isArray(action.queries)
    ? action.queries.map((entry) => String(entry || '').trim()).filter(Boolean)
    : []
  const url = String(action.url || '').trim()
  const blocks = []
  const metaBlock = createMetaBlock([
    query ? { label: text('关键词', 'Query'), value: query } : null,
    url ? { label: 'URL', value: url } : null,
  ])

  if (metaBlock) {
    blocks.push(metaBlock)
  }

  if (queries.length > 1) {
    blocks.push({
      type: 'bullet_list',
      items: queries,
      totalCount: queries.length,
      hiddenCount: 0,
    })
  }

  return blocks
}

function buildCollabToolDetailBlocks(item = {}) {
  const tool = String(item.tool || '').trim()
  const agentCount = getCollabAgentCount(item)
  const prompt = String(item.prompt || '').trim()
  const agentItems = getCollabAgentItems(item)
  const blocks = []
  const metaItems = [
    tool ? { label: text('工具', 'Tool'), value: tool } : null,
    agentCount ? { label: text('子代理', 'Sub-agent'), value: String(agentCount) } : null,
  ]
  const metaBlock = createMetaBlock(metaItems)

  if (metaBlock) {
    blocks.push(metaBlock)
  }

  if (agentItems.length) {
    blocks.push({
      type: 'sub_agent_list',
      items: agentItems,
      totalCount: agentItems.length,
      hiddenCount: 0,
    })
  }

  if (prompt) {
    blocks.push(...buildDetailBlocksFromText(prompt, { preferMarkdown: true }))
  }

  return blocks
}

function buildFileChangeDetailBlocks(item = {}) {
  const changes = Array.isArray(item.changes) ? item.changes : []
  if (!changes.length) {
    return []
  }

  return [{
    type: 'file_changes',
    items: changes.map((change) => ({
      kind: String(change?.kind || '').trim(),
      path: String(change?.path || '').trim(),
    })),
    totalCount: changes.length,
    hiddenCount: 0,
  }]
}

function buildCommandDetailBlocks(item = {}, includeOutput = false, engine = 'codex') {
  const blocks = []
  const parsed = parseToolCommand(item.command)
  const todoEntries = extractTodoEntriesFromCommandItem(item, parsed)
  const todoChecklistBlock = buildChecklistBlock(todoEntries)
  const hasExplicitExitCode = typeof item.exit_code === 'number'
  const isSuccessful = hasExplicitExitCode ? item.exit_code === 0 : item.status === 'completed'
  const metaBlock = createMetaBlock([
    parsed.toolName ? { label: text('工具', 'Tool'), value: parsed.toolName } : null,
    todoChecklistBlock || parsed.category !== 'shell'
      ? null
      : (parsed.subject ? { label: text('命令', 'Command'), value: parsed.subject } : (item.command ? { label: text('命令', 'Command'), value: item.command } : null)),
    engine && engine !== 'codex' ? { label: text('引擎', 'Engine'), value: getDisplayEngineLabel(engine) } : null,
    hasExplicitExitCode && !isSuccessful ? { label: text('退出码', 'Exit code'), value: String(item.exit_code) } : null,
  ])

  if (metaBlock) {
    blocks.push(metaBlock)
  }

  if (todoChecklistBlock) {
    blocks.push(todoChecklistBlock)
  }

  if (includeOutput) {
    if (todoChecklistBlock) {
      return blocks
    }

    const output = formatCommandOutput(item.aggregated_output)
    if (output) {
      blocks.push(...buildDetailBlocksFromText(output, {
        preferMarkdown: parsed.category === 'web' || parsed.category === 'edit',
      }))
    }
  }

  return blocks
}

function buildCommandGroupingMeta(item = {}) {
  const parsed = parseToolCommand(item.command)
  return {
    groupType: ['read', 'grep', 'list', 'web', 'todo'].includes(parsed.category) ? parsed.category : '',
    groupTarget: parsed.subject || item.command || '',
    toolName: parsed.toolName || '',
  }
}

function buildTodoDetailBlocks(item = {}) {
  const list = Array.isArray(item.items)
    ? mapTodoEntries(item.items)
    : []
  if (!list.length) {
    return []
  }

  return [buildChecklistBlock(list)]
}

function createTurnSummaryState() {
  return {
    commandCount: 0,
    webSearchCount: 0,
    fileChangeCount: 0,
    subAgentCount: 0,
    waitingAgentCount: 0,
    currentActivity: '',
    latestActivity: '',
    latestDetail: '',
  }
}

export function findTurnByRunId(turnList = [], runId = '') {
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) {
    return null
  }

  return (Array.isArray(turnList) ? turnList : []).find((turn) => turn?.runId === normalizedRunId) || null
}

export function applyRunEventsPayloadToTurns(turnList, runId, payload, nextLogId, mergeSession) {
  const activeTurn = findTurnByRunId(turnList, runId)
  if (!activeTurn) {
    return null
  }

  activeTurn.events = []
  activeTurn.lastEventSeq = 0
  activeTurn.summary = createTurnSummaryState()

  ;(payload?.items || []).forEach((event) => {
    applyRunEventToTurn(activeTurn, event, nextLogId, mergeSession)
  })

  activeTurn.eventCount = Math.max(
    Math.max(0, Number(activeTurn.eventCount) || 0),
    Array.isArray(payload?.items) ? payload.items.length : 0,
    Math.max(0, Number(activeTurn.lastEventSeq) || 0)
  )
  activeTurn.eventsLoaded = true
  activeTurn.eventsLoading = false
  return activeTurn
}

export function getTurnAgentEngine(turn = {}) {
  const displayEngine = String(turn?.displayEngine || '').trim()
  if (displayEngine) {
    return normalizeAgentEngine(displayEngine)
  }
  if (isShellEngineValue(turn?.engine)) {
    return 'codex'
  }
  return normalizeAgentEngine(turn?.engine)
}

export function getTurnAgentLabel(turn = {}) {
  return getAgentEngineLabel(getTurnAgentEngine(turn))
}

export function isShellTurn(turn = {}) {
  return isShellEngineValue(turn?.engine)
}

export function isTurnActiveStatus(status = '') {
  return ACTIVE_TURN_STATUSES.has(String(status || '').trim())
}

function getAgentCliCommand(engine = 'codex') {
  if (isShellEngineValue(engine)) {
    return '!git status'
  }
  const normalized = normalizeAgentEngine(engine)
  if (normalized === 'claude-code') {
    return 'claude --version'
  }
  if (normalized === 'opencode') {
    return 'opencode --version'
  }
  if (normalized === 'kimi-code') {
    return 'kimi --version'
  }
  return 'codex --version'
}

function getAgentFailureText(engine = 'codex') {
  return text(`${getDisplayEngineLabel(engine)} 执行失败`, `${getDisplayEngineLabel(engine)} failed`)
}

function parseCodexRetryMessage(message = '') {
  const text = String(message || '').trim()
  if (!text) {
    return null
  }

  const matched = text.match(/^Reconnecting\.\.\.\s*(\d+)\/(\d+)\s*\(([\s\S]+)\)$/i)
  if (!matched) {
    return null
  }

  return {
    attempt: Number(matched[1] || 0),
    total: Number(matched[2] || 0),
    reason: String(matched[3] || '').trim(),
    rawMessage: text,
  }
}

function formatWebSearchEvent(item = {}, phase = 'completed') {
  const action = item.action || {}
  const actionType = String(action.type || '').trim()
  const query = String(item.query || action.query || '').trim()
  const queries = Array.isArray(action.queries) ? action.queries.map((entry) => String(entry || '').trim()).filter(Boolean) : []
  const url = String(action.url || query || '').trim()

  if (actionType === 'search') {
    const title = phase === 'started' ? text('正在搜索网页', 'Searching the web') : text('已搜索网页', 'Web search completed')
    return {
      kind: 'command',
      title,
      detail: formatMultilineList(
        query ? text(`关键词：${query}`, `Query: ${query}`) : '',
        queries.length > 1 ? queries : []
      ),
    }
  }

  if (actionType === 'open_page') {
    return {
      kind: 'command',
      title: phase === 'started' ? text('正在打开网页', 'Opening page') : text('已打开网页', 'Page opened'),
      detail: url,
    }
  }

  return {
    kind: 'command',
    title: phase === 'started' ? text('准备网页检索', 'Preparing web search') : text('网页检索已更新', 'Web search updated'),
    detail: query,
  }
}

function formatCollabToolEvent(item = {}, phase = 'completed') {
  const tool = String(item.tool || '').trim()
  const agentCount = getCollabAgentCount(item)
  const prompt = summarizeText(item.prompt)

  if (tool === 'spawn_agent') {
    return {
      kind: 'todo',
      title: phase === 'started'
        ? text('正在启动子代理', 'Starting sub-agent')
        : text(`已启动 ${agentCount || 1} 个子代理`, `Started ${agentCount || 1} sub-agent(s)`),
      detail: prompt ? text(`任务：${prompt}`, `Task: ${prompt}`) : '',
    }
  }

  if (tool === 'wait') {
    return {
      kind: 'todo',
      title: phase === 'started'
        ? (agentCount ? text(`等待 ${agentCount} 个子代理返回结果`, `Waiting for ${agentCount} sub-agent result(s)`) : text('等待子代理返回结果', 'Waiting for sub-agent results'))
        : text('子代理结果已汇总', 'Sub-agent results aggregated'),
      detail: prompt ? text(`等待内容：${prompt}`, `Waiting on: ${prompt}`) : '',
    }
  }

  return {
    kind: 'todo',
    title: phase === 'started'
      ? text(`正在执行协作工具：${tool || '未知工具'}`, `Running collaboration tool: ${tool || 'Unknown tool'}`)
      : text(`协作工具完成：${tool || '未知工具'}`, `Collaboration tool completed: ${tool || 'Unknown tool'}`),
    detail: prompt ? text(`任务：${prompt}`, `Task: ${prompt}`) : '',
  }
}

function formatFileChangeEvent(item = {}, phase = 'completed') {
  const changes = Array.isArray(item.changes) ? item.changes : []
  const kindLabelMap = {
    create: text('新增', 'Added'),
    update: text('更新', 'Updated'),
    delete: text('删除', 'Deleted'),
  }

  return {
    kind: 'command',
    title: phase === 'started'
      ? text('正在整理文件变更', 'Collecting file changes')
      : text(`已记录 ${changes.length || 0} 个文件改动`, `Recorded ${changes.length || 0} file change(s)`),
    detail: formatMultilineList('', changes.map((change) => {
      const changePath = String(change?.path || '').trim()
      const changeKind = kindLabelMap[String(change?.kind || '').trim()] || text('变更', 'Changed')
      return `${changeKind} ${changePath || text('未命名文件', 'Unnamed file')}`
    })),
  }
}

function syncTurnSummaryFromCodexEvent(turn, event = {}) {
  if (!turn?.summary) {
    turn.summary = createTurnSummaryState()
  }

  const summary = turn.summary
  const agentLabel = getTurnAgentLabel(turn)
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_STARTED) {
    summary.currentActivity = text('正在分析任务', 'Analyzing task')
    summary.latestActivity = text(`${agentLabel} 开始执行`, `${agentLabel} started`)
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = text(`${agentLabel} 执行完成`, `${agentLabel} completed`)
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED) {
    summary.currentActivity = ''
    summary.waitingAgentCount = 0
    summary.latestActivity = text('本轮运行失败', 'This run failed')
    summary.latestDetail = ''
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ERROR) {
    const retrying = parseCodexRetryMessage(extractCodexEventErrorText(event))
    if (retrying) {
      summary.currentActivity = text(`网络异常，正在重试 (${retrying.attempt}/${retrying.total})`, `Network error, retrying (${retrying.attempt}/${retrying.total})`)
      summary.latestActivity = summary.currentActivity
      summary.latestDetail = summarizeText(retrying.reason, 120)
      return
    }

    summary.currentActivity = ''
    summary.latestActivity = text(`${agentLabel} 返回错误`, `${agentLabel} returned an error`)
    summary.latestDetail = summarizeText(extractCodexEventErrorText(event), 120)
    return
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_STARTED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.REASONING) {
      summary.currentActivity = text('正在思考', 'Thinking')
      summary.latestActivity = text('正在思考', 'Thinking')
      summary.latestDetail = summarizeText(item.text, 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      const commandMeta = buildCommandGroupingMeta(item)
      if (commandMeta.groupType === 'todo') {
        const todoDetail = formatTodoItems(extractTodoEntriesFromCommandItem(item))
        summary.currentActivity = text('正在更新待办列表', 'Updating todo list')
        summary.latestActivity = text('正在更新待办列表', 'Updating todo list')
        summary.latestDetail = summarizeText(todoDetail, 120)
        return
      }

      summary.currentActivity = text('正在执行命令', 'Running command')
      summary.latestActivity = text('开始执行命令', 'Command started')
      summary.latestDetail = summarizeText(item.command, 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      summary.currentActivity = item.action?.type === 'open_page'
        ? text('正在打开网页', 'Opening page')
        : text('正在搜索网页', 'Searching the web')
      summary.latestActivity = summary.currentActivity
      summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
      if (item.tool === 'wait') {
        const agentCount = getCollabAgentCount(item)
        summary.waitingAgentCount = agentCount
        summary.currentActivity = agentCount
          ? text(`等待 ${agentCount} 个子代理返回结果`, `Waiting for ${agentCount} sub-agent result(s)`)
          : text('等待子代理返回结果', 'Waiting for sub-agent results')
        summary.latestActivity = summary.currentActivity
        summary.latestDetail = summarizeText(item.prompt, 120)
        return
      }

      if (item.tool === 'spawn_agent') {
        summary.currentActivity = text('正在启动子代理', 'Starting sub-agent')
        summary.latestActivity = text('正在启动子代理', 'Starting sub-agent')
        summary.latestDetail = summarizeText(item.prompt, 120)
        return
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      summary.currentActivity = text('正在整理文件变更', 'Collecting file changes')
      summary.latestActivity = text('正在整理文件变更', 'Collecting file changes')
      summary.latestDetail = summarizeText((item.changes || []).map((change) => change?.path).filter(Boolean).join(isEnglishLocale() ? ', ' : '，'), 120)
      return
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
      summary.currentActivity = text('正在规划执行步骤', 'Planning steps')
      summary.latestActivity = text('正在规划执行步骤', 'Planning steps')
      summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join(isEnglishLocale() ? '; ' : '；'), 120)
    }
    return
  }

  if (eventType !== AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED) {
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
    const commandMeta = buildCommandGroupingMeta(item)
    if (commandMeta.groupType === 'todo') {
      summary.currentActivity = ''
      summary.latestActivity = text('待办列表已更新', 'Todo list updated')
      summary.latestDetail = summarizeText(formatTodoItems(extractTodoEntriesFromCommandItem(item)), 120)
      return
    }

    summary.commandCount += 1
    summary.currentActivity = ''
    summary.latestActivity = text('命令执行完成', 'Command completed')
    summary.latestDetail = summarizeText(item.command, 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
    summary.webSearchCount += 1
    summary.currentActivity = ''
    summary.latestActivity = item.action?.type === 'open_page'
      ? text('已打开网页', 'Page opened')
      : text('已搜索网页', 'Web search completed')
    summary.latestDetail = summarizeText(item.action?.type === 'open_page' ? (item.action?.url || item.query) : (item.query || item.action?.query), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
    if (item.tool === 'spawn_agent') {
      const agentCount = getCollabAgentCount(item)
      summary.subAgentCount += agentCount
      summary.currentActivity = ''
      summary.latestActivity = agentCount
        ? text(`已启动 ${agentCount} 个子代理`, `Started ${agentCount} sub-agent(s)`)
        : text('已启动子代理', 'Started sub-agent')
      summary.latestDetail = summarizeText(item.prompt, 120)
      return
    }

    if (item.tool === 'wait') {
      summary.waitingAgentCount = 0
      summary.currentActivity = ''
      summary.latestActivity = text('子代理结果已汇总', 'Sub-agent results aggregated')
      summary.latestDetail = summarizeCollabAgentMessages(item, 120) || summarizeText(item.prompt, 120)
      return
    }

    summary.currentActivity = ''
    summary.latestActivity = text(`协作工具完成：${item.tool || '未知工具'}`, `Collaboration tool completed: ${item.tool || 'Unknown tool'}`)
    summary.latestDetail = summarizeText(item.prompt, 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
    const changes = Array.isArray(item.changes) ? item.changes : []
    summary.fileChangeCount += changes.length
    summary.currentActivity = ''
    summary.latestActivity = changes.length
      ? text(`已记录 ${changes.length} 个文件改动`, `Recorded ${changes.length} file change(s)`)
      : text('已记录文件改动', 'Recorded file changes')
    summary.latestDetail = summarizeText(changes.map((change) => change?.path).filter(Boolean).join(isEnglishLocale() ? ', ' : '，'), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
    summary.currentActivity = ''
    summary.latestActivity = text('待办列表已更新', 'Todo list updated')
    summary.latestDetail = summarizeText((item.items || []).map((entry) => entry?.text).filter(Boolean).join(isEnglishLocale() ? '; ' : '；'), 120)
    return
  }

  if (item.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE) {
    summary.currentActivity = ''
    summary.latestActivity = text(`${agentLabel} 已返回结果`, `${agentLabel} returned a result`)
    summary.latestDetail = summarizeText(item.text, 120)
  }
}

function getTurnElapsedSeconds(turn = {}, options = {}) {
  const startedAt = Date.parse(String(turn.startedAt || ''))
  if (!Number.isFinite(startedAt)) {
    return 0
  }

  if (isTurnActiveStatus(turn.status)) {
    if (
      options.currentRunningRunId
      && String(options.currentRunningRunId) === String(turn.runId || '')
      && Number.isFinite(Number(options.runningElapsedSeconds))
    ) {
      return Math.max(0, Math.floor(Number(options.runningElapsedSeconds) || 0))
    }

    const nowMs = Number(options.nowMs) || Date.now()
    return Math.max(0, Math.floor((nowMs - startedAt) / 1000))
  }

  const finishedAt = Date.parse(String(turn.finishedAt || ''))
  if (Number.isFinite(finishedAt) && finishedAt >= startedAt) {
    return Math.max(0, Math.floor((finishedAt - startedAt) / 1000))
  }

  return 0
}

export function getTurnSummaryItems(turn = {}, options = {}) {
  const summary = turn.summary || createTurnSummaryState()
  const items = []
  const elapsedSeconds = getTurnElapsedSeconds(turn, options)

  if (elapsedSeconds > 0) {
    items.push({ key: 'elapsed', label: text('耗时', 'Elapsed'), value: formatElapsedDuration(elapsedSeconds) })
  }

  if (summary.webSearchCount) {
    items.push({ key: 'web', label: text('网页', 'Web'), value: formatCount(summary.webSearchCount) })
  }
  if (summary.commandCount) {
    items.push({ key: 'command', label: text('命令', 'Command'), value: formatCount(summary.commandCount) })
  }
  if (summary.fileChangeCount) {
    items.push({ key: 'file', label: text('改动', 'Changes'), value: formatCount(summary.fileChangeCount) })
  }
  if (summary.subAgentCount) {
    items.push({ key: 'agent', label: text('子代理', 'Sub-agent'), value: formatCount(summary.subAgentCount) })
  }

  return items
}

export function getTurnSummaryStatus(turn = {}) {
  const summary = turn.summary || createTurnSummaryState()

  if (summary.waitingAgentCount > 0) {
    return text(`当前：等待 ${formatCount(summary.waitingAgentCount)} 个子代理返回结果`, `Current: waiting for ${formatCount(summary.waitingAgentCount)} sub-agent result(s)`)
  }

  if (summary.currentActivity) {
    return text(`当前：${summary.currentActivity}`, `Current: ${summary.currentActivity}`)
  }

  if (summary.latestActivity) {
    return text(`最近：${summary.latestActivity}`, `Latest: ${summary.latestActivity}`)
  }

  if (isTurnActiveStatus(turn.status)) {
    return text(`当前：正在等待 ${getTurnAgentLabel(turn)} 返回更多事件`, `Current: waiting for more events from ${getTurnAgentLabel(turn)}`)
  }

  return ''
}

export function getTurnSummaryDetail(turn = {}) {
  const summary = turn.summary || createTurnSummaryState()
  return String(summary.latestDetail || '').trim()
}

export function hasTurnSummary(turn = {}) {
  return Boolean(getTurnSummaryItems(turn).length || getTurnSummaryStatus(turn) || getTurnSummaryDetail(turn))
}

const CODEX_ISSUE_PATTERNS = [
  {
    type: 'startup_config',
    title: (engine) => text(`${getAgentEngineLabel(engine)} 启动配置冲突`, `${getAgentEngineLabel(engine)} startup config conflict`),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 当前启动参数可能与本机包装脚本、别名或外部环境配置冲突，请检查 CLI 启动方式。`, `${getAgentEngineLabel(engine)} startup arguments may conflict with your local wrapper script, alias, or external environment configuration. Please check how the CLI is launched.`),
    patterns: [
      /not inside a trusted directory/i,
      /do you trust the contents of this directory/i,
      /trusted directory/i,
      /skip-git-repo-check/i,
      /prompt injection/i,
      /目录.*信任/,
      /可信目录/,
    ],
  },
  {
    type: 'billing',
    title: text('额度或账单异常', 'Quota or billing issue'),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 可能因为额度不足、欠费或账单限制而无法继续执行。`, `${getAgentEngineLabel(engine)} may be unable to continue due to quota exhaustion, billing issues, or account limits.`),
    patterns: [
      /insufficient_quota/i,
      /exceeded your current quota/i,
      /\bquota\b/i,
      /\bbilling\b/i,
      /credit balance/i,
      /payment required/i,
      /余额不足/,
      /欠费/,
      /账单/,
      /充值/,
    ],
  },
  {
    type: 'permission',
    title: text('权限不足', 'Insufficient permissions'),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 当前权限不够，无法访问所需文件、命令或资源。`, `${getAgentEngineLabel(engine)} does not currently have permission to access the required files, commands, or resources.`),
    patterns: [
      /permission denied/i,
      /insufficient permissions?/i,
      /forbidden/i,
      /unauthorized/i,
      /authentication_failed/i,
      /invalid token/i,
      /invalid api key/i,
      /\b401\b/,
      /access denied/i,
      /not allowed/i,
      /权限不足/,
      /没有权限/,
      /无权/,
      /拒绝访问/,
      /无效的令牌/,
    ],
  },
  {
    type: 'rate_limit',
    title: text('请求过于频繁', 'Too many requests'),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 可能触发了限流，请稍后再试。`, `${getAgentEngineLabel(engine)} may have hit a rate limit. Please try again later.`),
    patterns: [
      /rate limit/i,
      /too many requests/i,
      /\b429\b/,
      /请求过于频繁/,
      /限流/,
    ],
  },
  {
    type: 'context_limit',
    title: text('上下文过长', 'Context too long'),
    summary: text('这次发送的内容可能过长，超过了模型可处理的上下文限制。', 'The content sent in this run may be too long and exceed the model context limit.'),
    patterns: [
      /context length/i,
      /maximum context length/i,
      /context_length_exceeded/i,
      /token limit/i,
      /prompt is too long/i,
      /上下文过长/,
      /超过.*token/i,
      /超出.*上下文/,
    ],
  },
  {
    type: 'model_unavailable',
    title: text('模型或服务暂不可用', 'Model or service unavailable'),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 背后的模型或服务当前不可用，请稍后重试。`, `The model or service behind ${getAgentEngineLabel(engine)} is currently unavailable. Please try again later.`),
    patterns: [
      /model .*not found/i,
      /model .*unavailable/i,
      /service unavailable/i,
      /server error/i,
      /overloaded/i,
      /\b503\b/,
      /模型不可用/,
      /服务不可用/,
    ],
  },
  {
    type: 'network',
    title: text('网络连接异常', 'Network connection issue'),
    summary: (engine) => text(`${getAgentEngineLabel(engine)} 在请求过程中遇到了网络问题或连接超时。`, `${getAgentEngineLabel(engine)} encountered a network problem or timeout while making the request.`),
    patterns: [
      /timed out/i,
      /\btimeout\b/i,
      /stream disconnected/i,
      /error sending request/i,
      /connection reset/i,
      /connection closed/i,
      /socket hang up/i,
      /network error/i,
      /fetch failed/i,
      /econnreset/i,
      /econnrefused/i,
      /enotfound/i,
      /network is unreachable/i,
      /temporary failure in name resolution/i,
      /网络异常/,
      /连接超时/,
    ],
  },
  {
    type: 'cli_missing',
    title: (engine) => text(`${getAgentEngineLabel(engine)} CLI 不可用`, `${getAgentEngineLabel(engine)} CLI unavailable`),
    summary: (engine) => text(`当前环境没有正确安装或配置 ${getAgentEngineLabel(engine)} CLI。`, `${getAgentEngineLabel(engine)} CLI is not correctly installed or configured in the current environment.`),
    patterns: [
      /找不到 Codex CLI/,
      /找不到 Claude Code CLI/,
      /找不到 OpenCode CLI/,
      /找不到 Kimi Code CLI/,
      /codex --version/i,
      /claude --version/i,
      /opencode --version/i,
      /kimi --version/i,
      /enoent/i,
      /not recognized as an internal or external command/i,
      /command not found/i,
    ],
  },
]

export function classifyCodexIssue(message = '', engine = 'codex') {
  const normalizedText = sanitizeProcessDetailText(message).trim()
  if (!normalizedText) {
    return null
  }

  const matched = CODEX_ISSUE_PATTERNS.find((issue) => issue.patterns.some((pattern) => pattern.test(normalizedText)))
  if (!matched) {
    return null
  }

  return {
    type: matched.type,
    title: typeof matched.title === 'function' ? matched.title(engine) : matched.title,
    summary: typeof matched.summary === 'function' ? matched.summary(engine) : matched.summary,
    rawMessage: normalizedText,
  }
}

export function formatCodexIssueMessage(message = '', engine = 'codex') {
  const rawText = sanitizeProcessDetailText(message).trim()
  if (!rawText) {
    return ''
  }

  const issue = classifyCodexIssue(rawText, engine)
  if (!issue) {
    return rawText
  }

  return `${issue.summary}\n\n${text('原始错误', 'Raw error')}: ${issue.rawMessage}`
}

function extractTextFromUnknownError(input, depth = 0) {
  if (!input || depth > 4) {
    return ''
  }

  if (typeof input === 'string') {
    return sanitizeProcessDetailText(input).trim()
  }

  if (typeof input !== 'object') {
    return ''
  }

  const priorityKeys = [
    'message',
    'detail',
    'error',
    'last_error',
    'cause',
    'reason',
    'stderr',
    'text',
    'summary',
  ]

  for (const key of priorityKeys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) {
      continue
    }

    const value = extractTextFromUnknownError(input[key], depth + 1)
    if (value) {
      return value
    }
  }

  for (const value of Object.values(input)) {
    const text = extractTextFromUnknownError(value, depth + 1)
    if (text) {
      return text
    }
  }

  return ''
}

export function extractCodexEventErrorText(event = {}) {
  return extractTextFromUnknownError(event)
}

export function formatCodexEvent(event = {}, agentLabel = 'Codex', engine = 'codex') {
  const eventType = String(event.type || '').trim()
  const item = event.item || {}

  if (!eventType) {
    return { title: text(`收到 ${agentLabel} 事件`, `Received ${agentLabel} event`), detail: '' }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.THREAD_STARTED) {
    const detail = event.thread_id ? text(`线程 ID: ${event.thread_id}`, `Thread ID: ${event.thread_id}`) : ''
    return {
      title: text(`${agentLabel} 会话已创建`, `${agentLabel} session created`),
      detail,
      detailBlocks: detail ? [createMetaBlock([{ label: 'ID', value: event.thread_id }])] : [],
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_STARTED) {
    return { title: text(`${agentLabel} 开始执行`, `${agentLabel} started`), detail: '' }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
    const usage = event.usage
      ? [
        text(`输入 ${formatCount(event.usage.input_tokens)}`, `Input ${formatCount(event.usage.input_tokens)}`),
        event.usage.cached_input_tokens ? text(`缓存 ${formatCount(event.usage.cached_input_tokens)}`, `Cached ${formatCount(event.usage.cached_input_tokens)}`) : '',
        text(`输出 ${formatCount(event.usage.output_tokens)}`, `Output ${formatCount(event.usage.output_tokens)}`),
      ].filter(Boolean).join(' / ')
      : ''
    return {
      title: text(`${agentLabel} 执行完成`, `${agentLabel} completed`),
      detail: usage,
      detailBlocks: event.usage ? [createMetaBlock([
        { label: text('输入', 'Input'), value: formatCount(event.usage.input_tokens) },
        event.usage.cached_input_tokens ? { label: text('缓存', 'Cached'), value: formatCount(event.usage.cached_input_tokens) } : null,
        { label: text('输出', 'Output'), value: formatCount(event.usage.output_tokens) },
      ])] : [],
    }
  }

  if (eventType === 'claude.system') {
    const detail = String(event.detail || '').trim()
    if (!detail) {
      return {
        title: '',
        detail: '',
      }
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ERROR || eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED) {
    const rawMessage = extractCodexEventErrorText(event) || text(`${agentLabel} 执行失败`, `${agentLabel} failed`)
    const retrying = eventType === AGENT_RUN_EVENT_TYPES.ERROR ? parseCodexRetryMessage(rawMessage) : null
    if (retrying) {
      return {
        kind: 'info',
        title: text(`网络异常，正在重试 (${retrying.attempt}/${retrying.total})`, `Network error, retrying (${retrying.attempt}/${retrying.total})`),
        detail: formatCodexIssueMessage(retrying.reason || retrying.rawMessage, engine),
        detailBlocks: buildDetailBlocksFromText(formatCodexIssueMessage(retrying.reason || retrying.rawMessage, engine), { preferMarkdown: true }),
      }
    }

    const issue = classifyCodexIssue(rawMessage, engine)
    return {
      kind: 'error',
      title: issue?.title || (eventType === AGENT_RUN_EVENT_TYPES.TURN_FAILED ? text('本轮运行失败', 'This run failed') : text(`${agentLabel} 返回错误`, `${agentLabel} returned an error`)),
      detail: formatCodexIssueMessage(rawMessage, engine),
      detailBlocks: buildDetailBlocksFromText(formatCodexIssueMessage(rawMessage, engine), { preferMarkdown: true }),
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_STARTED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.REASONING) {
      return {
        kind: 'reasoning',
        title: text('思考过程', 'Thinking'),
        detail: item.text || '',
        detailBlocks: buildDetailBlocksFromText(item.text || '', { preferMarkdown: true }),
        groupType: 'reasoning',
        phase: 'updated',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      return {
        ...formatWebSearchEvent(item, 'started'),
        detailBlocks: buildWebSearchDetailBlocks(item),
        groupType: 'web',
        groupTarget: String(item.query || item.action?.query || item.action?.url || '').trim(),
        phase: 'started',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
      return {
        ...formatCollabToolEvent(item, 'started'),
        detailBlocks: buildCollabToolDetailBlocks(item),
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      return {
        ...formatFileChangeEvent(item, 'started'),
        detailBlocks: buildFileChangeDetailBlocks(item),
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      const commandMeta = buildCommandGroupingMeta(item)
      if (commandMeta.groupType === 'todo') {
        return {
          kind: 'todo',
          title: text('更新待办列表', 'Update todo list'),
          detail: formatTodoItems(extractTodoEntriesFromCommandItem(item)),
          detailBlocks: buildCommandDetailBlocks(item, false, engine),
          groupType: 'todo',
          phase: 'started',
        }
      }

      return {
        kind: 'command',
        title: text('开始执行命令', 'Command started'),
        detail: item.command || '',
        detailBlocks: buildCommandDetailBlocks(item, false, engine),
        ...buildCommandGroupingMeta(item),
        phase: 'started',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
      return {
        kind: 'todo',
        title: text('更新待办列表', 'Update todo list'),
        detail: formatTodoItems(item.items),
        detailBlocks: buildTodoDetailBlocks(item),
        groupType: 'todo',
        phase: 'started',
      }
    }

    return {
      title: text(`开始处理 ${item.type || '未知项目'}`, `Started handling ${item.type || 'unknown item'}`),
      detail: '',
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_UPDATED && item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
    return {
      kind: 'todo',
      title: text('更新待办列表', 'Update todo list'),
      detail: formatTodoItems(item.items),
      detailBlocks: buildTodoDetailBlocks(item),
      groupType: 'todo',
      phase: 'updated',
    }
  }

  if (eventType === AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED) {
    if (item.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE && item.text) {
      return {
        kind: 'result',
        title: text(`${agentLabel} 已返回结果`, `${agentLabel} returned a result`),
        detail: '',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.WEB_SEARCH) {
      return {
        ...formatWebSearchEvent(item, 'completed'),
        detailBlocks: buildWebSearchDetailBlocks(item),
        groupType: 'web',
        groupTarget: String(item.query || item.action?.query || item.action?.url || '').trim(),
        phase: 'completed',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL) {
      return {
        ...formatCollabToolEvent(item, 'completed'),
        detailBlocks: buildCollabToolDetailBlocks(item),
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.FILE_CHANGE) {
      return {
        ...formatFileChangeEvent(item, 'completed'),
        detailBlocks: buildFileChangeDetailBlocks(item),
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION) {
      const commandMeta = buildCommandGroupingMeta(item)
      if (commandMeta.groupType === 'todo') {
        const success = typeof item.exit_code === 'number'
          ? item.exit_code === 0
          : item.status === 'completed'
        return {
          kind: success ? 'todo' : 'error',
          title: success
            ? text('更新待办列表', 'Update todo list')
            : text('更新待办列表失败', 'Todo list update failed'),
          detail: formatTodoItems(extractTodoEntriesFromCommandItem(item)),
          detailBlocks: buildCommandDetailBlocks(item, true, engine),
          groupType: 'todo',
          phase: 'completed',
        }
      }

      const success = typeof item.exit_code === 'number'
        ? item.exit_code === 0
        : item.status === 'completed'
      return {
        kind: success ? 'command' : 'error',
        title: success
          ? text('命令执行完成', 'Command completed')
          : text(`命令执行失败(exit ${item.exit_code ?? '?'})`, `Command failed (exit ${item.exit_code ?? '?'})`),
        detail: [item.command, formatCommandOutput(item.aggregated_output)].filter(Boolean).join('\n\n'),
        detailBlocks: buildCommandDetailBlocks(item, true, engine),
        ...buildCommandGroupingMeta(item),
        phase: 'completed',
      }
    }

    if (item.type === AGENT_RUN_ITEM_TYPES.TODO_LIST) {
      return {
        kind: 'todo',
        title: text('更新待办列表', 'Update todo list'),
        detail: formatTodoItems(item.items),
        detailBlocks: buildTodoDetailBlocks(item),
        groupType: 'todo',
        phase: 'completed',
      }
    }

    return {
      title: text(`完成 ${item.type || '未知项目'}`, `Completed ${item.type || 'unknown item'}`),
      detail: '',
    }
  }

  return {
    title: text(`事件: ${eventType}`, `Event: ${eventType}`),
    detail: '',
  }
}

export function getProcessStatus(turn) {
  if (turn.status === 'queued') {
    return text('排队中', 'Queued')
  }
  if (turn.status === 'starting') {
    return text('启动中', 'Starting')
  }
  if (turn.status === 'stopping') {
    return text('停止中', 'Stopping')
  }
  if (turn.status === 'running') {
    return text('进行中', 'Running')
  }
  if (turn.status === 'error') {
    return text('失败', 'Failed')
  }
  if (turn.status === 'interrupted') {
    return text('已中断', 'Interrupted')
  }
  if (turn.status === 'stopped') {
    return text('已停止', 'Stopped')
  }
  if (turn.status === 'stop_timeout') {
    return text('停止超时', 'Stop timeout')
  }
  return text('已完成', 'Completed')
}

function normalizeLogEntry(entry = {}, nextLogId) {
  if (typeof entry === 'string') {
    const text = entry.trim()
    if (!text) {
      return null
    }
    return {
      id: nextLogId(),
      kind: 'info',
      title: text,
      detail: '',
    }
  }

  const title = String(entry.title || '').trim()
  const detail = String(entry.detail || '').trim()
  const detailBlocks = Array.isArray(entry.detailBlocks) && entry.detailBlocks.length
    ? entry.detailBlocks.filter(Boolean)
    : (detail ? buildDetailBlocksFromText(detail, { preferMarkdown: entry.kind === 'error' }) : [])
  if (!title && !detail) {
    return null
  }

  return {
    id: nextLogId(),
    kind: entry.kind || 'info',
    title: title || detail,
    detail: title ? detail : '',
    detailBlocks,
    groupType: String(entry.groupType || '').trim(),
    groupTarget: String(entry.groupTarget || '').trim(),
    toolName: String(entry.toolName || '').trim(),
    phase: String(entry.phase || '').trim(),
  }
}

function createBaseTurn(run = {}, nextTurnId) {
  const promptBlocks = Array.isArray(run.promptBlocks)
    ? run.promptBlocks.map((block) => ({
        ...block,
        meta: block?.meta ? { ...block.meta } : {},
        content: block?.type === 'image' ? resolveAssetUrl(block.content) : block.content,
      }))
    : []

  return {
    id: nextTurnId(),
    runId: String(run.id || '').trim(),
    engine: String(run.engine || '').trim(),
    displayEngine: String(run.displayEngine || '').trim(),
    prompt: String(run.prompt || '').trim(),
    promptBlocks,
    status: 'completed',
    startedAt: run.startedAt || run.createdAt || '',
    finishedAt: run.finishedAt || '',
    events: [],
    eventCount: Math.max(0, Number(run.eventCount) || (Array.isArray(run.events) ? run.events.length : 0)),
    eventsLoaded: Boolean(run.eventsIncluded),
    eventsLoading: false,
    responseMessage: '',
    errorMessage: '',
    lastEventSeq: 0,
    summary: createTurnSummaryState(),
  }
}

function appendTurnEvent(turn, entry, nextLogId) {
  const normalized = normalizeLogEntry(entry, nextLogId)
  if (!normalized) {
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
}

function upsertRetryingEvent(turn, entry, nextLogId) {
  const normalized = normalizeLogEntry(entry, nextLogId)
  if (!normalized) {
    return
  }

  for (let index = turn.events.length - 1; index >= 0; index -= 1) {
    const retryPrefix = text('网络异常，正在重试', 'Network error, retrying')
    if (!String(turn.events[index]?.title || '').startsWith(retryPrefix)) {
      continue
    }
    turn.events.splice(index, 1, normalized)
    return
  }

  turn.events.push(normalized)
  if (turn.events.length > 120) {
    turn.events.splice(0, turn.events.length - 120)
  }
}

export function applyRunPayloadToTurn(turn, payload = {}, nextLogId, mergeSession = () => {}) {
  const envelopeType = normalizeAgentRunEnvelopeEventType(payload.type)

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION) {
    mergeSession(payload.session)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.SESSION_UPDATED) {
    mergeSession(payload.session)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STATUS) {
    if (payload.stage === 'starting' || payload.stage === 'resuming') {
      return
    }

    appendTurnEvent(turn, {
      title: resolveRunnerMessage(payload) || text('状态已更新', 'Status updated'),
      detail: '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STDERR) {
    const issue = classifyCodexIssue(payload.text, turn.engine)
    appendTurnEvent(turn, {
      kind: 'error',
      title: issue?.title || 'stderr',
      detail: formatCodexIssueMessage(payload.text, turn.engine),
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STDOUT) {
    appendTurnEvent(turn, {
      kind: 'command',
      title: 'stdout',
      detail: payload.text,
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.AGENT_EVENT) {
    syncTurnSummaryFromCodexEvent(turn, payload.event)
    if (payload.event?.type === AGENT_RUN_EVENT_TYPES.THREAD_STARTED) {
      return
    }
    const formattedEvent = formatCodexEvent(payload.event, getTurnAgentLabel(turn), turn.engine)
    if (String(formattedEvent.title || '').startsWith(text('网络异常，正在重试', 'Network error, retrying'))) {
      upsertRetryingEvent(turn, formattedEvent, nextLogId)
    } else {
      appendTurnEvent(turn, formattedEvent, nextLogId)
    }
    if (payload.event?.type === AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED && payload.event?.item?.type === AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE && payload.event?.item?.text) {
      turn.responseMessage = payload.event.item.text
    }
    const message = extractCodexEventErrorText(payload.event) || text(`${getTurnAgentLabel(turn)} 执行失败`, `${getTurnAgentLabel(turn)} failed`)
    const retrying = payload.event?.type === 'error' ? parseCodexRetryMessage(message) : null
    if (!retrying && (payload.event?.type === AGENT_RUN_EVENT_TYPES.ERROR || payload.event?.type === AGENT_RUN_EVENT_TYPES.TURN_FAILED)) {
      const message = extractCodexEventErrorText(payload.event) || text(`${getTurnAgentLabel(turn)} 执行失败`, `${getTurnAgentLabel(turn)} failed`)
      turn.errorMessage = formatCodexIssueMessage(message, turn.engine)
      turn.status = 'error'
    }
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.COMPLETED) {
    appendTurnEvent(turn, {
      kind: 'result',
      title: text('本轮执行结束', 'Run finished'),
      detail: '',
    }, nextLogId)
    const completedMessage = resolveRunnerMessage(payload)
    if (completedMessage) {
      turn.responseMessage = completedMessage
    }
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STOPPED) {
    appendTurnEvent(turn, {
      title: resolveRunnerMessage(payload) || text('执行已手动停止', 'Execution stopped manually'),
      detail: '',
    }, nextLogId)
    return
  }

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.ERROR) {
    const errorMessage = resolveRunnerMessage(payload)
    const issue = classifyCodexIssue(errorMessage, turn.engine)
    appendTurnEvent(turn, {
      kind: 'error',
      title: issue?.title || text('执行失败', 'Execution failed'),
      detail: formatCodexIssueMessage(errorMessage || text(`${getTurnAgentLabel(turn)} 执行失败`, `${getTurnAgentLabel(turn)} failed`), turn.engine),
    }, nextLogId)
  }
}

function shouldPreferEventDerivedError(runError = '', eventError = '', engine = 'codex') {
  const persisted = String(runError || '').trim()
  const derived = String(eventError || '').trim()

  if (!derived) {
    return false
  }

  if (!persisted) {
    return true
  }

  if (/no last agent message|wrote empty content/i.test(persisted)) {
    return true
  }

  if (/执行失败[。.]?$/i.test(persisted)) {
    return true
  }

  const persistedIssue = classifyCodexIssue(persisted, engine)
  const derivedIssue = classifyCodexIssue(derived, engine)

  return !persistedIssue && Boolean(derivedIssue)
}

export function syncTurnStateFromRun(turn, run = {}) {
  turn.status = run.status || 'completed'
  turn.responseMessage = String(run.responseMessage || turn.responseMessage || '')
  turn.finishedAt = String(run.finishedAt || turn.finishedAt || '')
  const persistedError = formatCodexIssueMessage(String(run.errorMessage || ''), turn.engine)
  const eventDerivedError = String(turn.errorMessage || '')
  turn.errorMessage = shouldPreferEventDerivedError(run.errorMessage, eventDerivedError, turn.engine)
    ? eventDerivedError
    : persistedError

  if (turn.status === 'completed' && !turn.responseMessage) {
    turn.responseMessage = text(`本轮 ${getTurnAgentLabel(turn)} 执行已完成，没有返回额外文本。`, `${getTurnAgentLabel(turn)} completed in this run without returning additional text.`)
  }

  return turn
}

export function applyRunEventToTurn(turn, event = {}, nextLogId, mergeSession = () => {}) {
  const nextSeq = Math.max(0, Number(event?.seq) || 0)
  if (nextSeq && nextSeq <= Number(turn.lastEventSeq || 0)) {
    return false
  }

  const payload = event?.payload || {}
  applyRunPayloadToTurn(turn, payload, nextLogId, mergeSession)

  const envelopeType = normalizeAgentRunEnvelopeEventType(payload.type)

  if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.COMPLETED) {
    turn.status = 'completed'
    turn.finishedAt = new Date().toISOString()
  } else if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.STOPPED) {
    turn.status = 'stopped'
    turn.errorMessage = ''
    turn.finishedAt = new Date().toISOString()
  } else if (envelopeType === AGENT_RUN_ENVELOPE_EVENT_TYPES.ERROR) {
    turn.status = 'error'
    turn.errorMessage = formatCodexIssueMessage(String(resolveRunnerMessage(payload) || turn.errorMessage || text(`${getTurnAgentLabel(turn)} 执行失败`, `${getTurnAgentLabel(turn)} failed`)), turn.engine)
    turn.finishedAt = new Date().toISOString()
  }

  if (nextSeq) {
    turn.lastEventSeq = nextSeq
  }
  turn.eventCount = Math.max(
    Math.max(0, Number(turn.eventCount) || 0),
    nextSeq,
    Array.isArray(turn.events) ? turn.events.length : 0
  )
  if (nextSeq || (Array.isArray(turn.events) && turn.events.length)) {
    turn.eventsLoaded = true
  }

  return true
}

export function createTurnFromRun(run, nextTurnId, nextLogId, mergeSession) {
  const turn = createBaseTurn(run, nextTurnId)

  ;(run.events || []).forEach((event) => {
    applyRunEventToTurn(turn, event, nextLogId, mergeSession)
  })

  return syncTurnStateFromRun(turn, run)
}
