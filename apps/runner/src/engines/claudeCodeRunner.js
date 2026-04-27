import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  AGENT_ENGINES,
  AGENT_RUN_ITEM_TYPES,
  createAgentEventEnvelopeEvent,
  createCompletedEnvelopeEvent,
  createErrorEvent,
  createItemCompletedEvent,
  createItemStartedEvent,
  createStatusEnvelopeEvent,
  createStderrEnvelopeEvent,
  createStdoutEnvelopeEvent,
  createThreadStartedEvent,
  createTurnCompletedEvent,
  getAgentEngineLabel,
} from '../../../../packages/shared/src/index.js'
import { createManagedSpawnOptions, forceStopChildProcess } from '../processControl.js'

const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || 'claude'
const CLAUDE_DEFAULT_ARGS = ['--dangerously-skip-permissions']
const RESOLVED_CLAUDE_CODE_BIN = resolveClaudeCodeBinary()
const CLAUDE_RESULT_EXIT_GRACE_MS = Math.max(
  0,
  Number(process.env.PROMPTX_CLAUDE_RESULT_EXIT_GRACE_MS) || 3000
)
const CLAUDE_RESULT_FORCE_STOP_GRACE_MS = Math.max(
  200,
  Number(process.env.PROMPTX_CLAUDE_RESULT_FORCE_STOP_GRACE_MS) || 1000
)

function resolveClaudeCodeBinary() {
  if (process.platform !== 'win32') {
    return CLAUDE_CODE_BIN
  }

  if (path.extname(CLAUDE_CODE_BIN)) {
    return CLAUDE_CODE_BIN
  }

  if (fs.existsSync(`${CLAUDE_CODE_BIN}.cmd`)) {
    return `${CLAUDE_CODE_BIN}.cmd`
  }

  if (fs.existsSync(`${CLAUDE_CODE_BIN}.bat`)) {
    return `${CLAUDE_CODE_BIN}.bat`
  }

  if (fs.existsSync(CLAUDE_CODE_BIN)) {
    return CLAUDE_CODE_BIN
  }

  try {
    const output = execFileSync('where.exe', [CLAUDE_CODE_BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return CLAUDE_CODE_BIN
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || CLAUDE_CODE_BIN
  } catch {
    return CLAUDE_CODE_BIN
  }
}

function createClaudeSpawn(commandArgs = [], cwd = '') {
  const options = createManagedSpawnOptions({
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(RESOLVED_CLAUDE_CODE_BIN)) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', RESOLVED_CLAUDE_CODE_BIN, ...commandArgs],
      options
    )
  }

  return spawn(RESOLVED_CLAUDE_CODE_BIN, commandArgs, options)
}

function normalizeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    const attempted = RESOLVED_CLAUDE_CODE_BIN === CLAUDE_CODE_BIN
      ? CLAUDE_CODE_BIN
      : `${CLAUDE_CODE_BIN} -> ${RESOLVED_CLAUDE_CODE_BIN}`
    return new Error(
      `找不到 Claude Code CLI（尝试执行：${attempted}）。请先确认终端里可以运行 \`claude --version\`，或设置环境变量 \`CLAUDE_CODE_BIN\`。`
    )
  }

  return error
}

function parseJsonLine(line = '') {
  const text = String(line || '').trim()
  if (!text) {
    return null
  }

  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function splitBufferedLines(buffer = '') {
  const text = String(buffer || '')
  if (!text) {
    return { lines: [], rest: '' }
  }

  const normalized = text.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n')
  const rest = parts.pop() || ''
  return {
    lines: parts.map((line) => line.trim()).filter(Boolean),
    rest,
  }
}

function flushBufferedText(buffer = '') {
  const { lines, rest } = splitBufferedLines(buffer)
  const tail = String(rest || '').trim()
  return tail ? [...lines, tail] : lines
}

function extractAgentTargetFromTexts(...values) {
  const matcher = /(?:^|[\s`'"])([A-Za-z]:[\\/][^\s`'"]+\.[A-Za-z0-9]+|\/[^\s`'"]+\.[A-Za-z0-9]+|(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\.[A-Za-z0-9]+)(?=$|[\s`'"])/i
  for (const value of values) {
    const text = String(value || '').trim()
    if (!text) {
      continue
    }

    const matched = text.match(matcher)
    if (!matched?.[1]) {
      continue
    }

    const normalized = matched[1].replace(/\\/g, '/')
    const parts = normalized.split('/').filter(Boolean)
    return parts[parts.length - 1] || normalized
  }

  return ''
}

function normalizeCollabAgentStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase()
  if (['completed', 'complete', 'succeeded', 'success', 'done'].includes(normalized)) {
    return 'completed'
  }
  if (['failed', 'error', 'errored', 'cancelled', 'canceled', 'stopped'].includes(normalized)) {
    return 'failed'
  }
  if (['running', 'in_progress', 'in-progress', 'pending_init', 'pending'].includes(normalized)) {
    return normalized === 'pending_init' ? 'pending_init' : 'running'
  }
  return normalized || 'pending_init'
}

function isClaudeCollabToolName(name = '') {
  return ['agent', 'task'].includes(String(name || '').trim().toLowerCase())
}

function isClaudeTodoToolName(name = '') {
  return String(name || '').trim().toLowerCase() === 'todowrite'
}

function normalizeClaudeTodoStatus(status = '') {
  const normalized = String(status || '').trim().toLowerCase()
  if (['completed', 'complete', 'done', 'checked'].includes(normalized)) {
    return 'completed'
  }
  if (['in_progress', 'in-progress', 'active', 'doing', 'running'].includes(normalized)) {
    return 'in_progress'
  }
  return 'pending'
}

function normalizeClaudeTodoText(entry = {}, status = 'pending') {
  const content = String(entry?.content || entry?.text || entry?.title || entry?.label || '').trim()
  const activeForm = String(entry?.activeForm || '').trim()
  if (status === 'in_progress' && activeForm) {
    return activeForm
  }
  return content || activeForm
}

function normalizeClaudeTodoItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null
      }

      const status = normalizeClaudeTodoStatus(entry.status)
      const text = normalizeClaudeTodoText(entry, status)
      if (!text) {
        return null
      }

      return {
        text,
        status,
        completed: status === 'completed',
      }
    })
    .filter(Boolean)
}

function collectTextParts(value, parts = []) {
  if (!value) {
    return parts
  }

  if (typeof value === 'string') {
    const text = value.trim()
    if (text) {
      parts.push(text)
    }
    return parts
  }

  if (Array.isArray(value)) {
    value.forEach((item) => collectTextParts(item, parts))
    return parts
  }

  if (typeof value !== 'object') {
    return parts
  }

  if (value.type === 'text' && typeof value.text === 'string') {
    return collectTextParts(value.text, parts)
  }

  const candidateKeys = ['text', 'message', 'content', 'result']
  candidateKeys.forEach((key) => {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectTextParts(value[key], parts)
    }
  })

  return parts
}

export function extractClaudeAssistantText(event = {}) {
  const parts = []
  if (event?.message?.content) {
    collectTextParts(event.message.content, parts)
  } else if (event?.content) {
    collectTextParts(event.content, parts)
  } else if (event?.message) {
    collectTextParts(event.message, parts)
  }
  return parts.join('\n').trim()
}

function stringifyClaudeToolResultContent(value) {
  const parts = []
  collectTextParts(value, parts)
  if (parts.length) {
    return parts.join('\n').trim()
  }

  if (typeof value === 'string') {
    return value.trim()
  }

  if (value == null) {
    return ''
  }

  try {
    const compact = JSON.stringify(value)
    return compact.length <= 12000 ? compact : `${compact.slice(0, 11997)}...`
  } catch {
    return String(value || '').trim()
  }
}

export function extractClaudeResultText(event = {}) {
  const parts = []
  if (event?.result) {
    collectTextParts(event.result, parts)
  } else if (event?.message?.content) {
    collectTextParts(event.message.content, parts)
  }
  return parts.join('\n').trim()
}

export function extractClaudeSessionId(event = {}) {
  const candidates = [
    event?.session_id,
    event?.sessionId,
    event?.message?.session_id,
    event?.message?.sessionId,
    event?.result?.session_id,
    event?.result?.sessionId,
  ]

  return candidates.map((value) => String(value || '').trim()).find(Boolean) || ''
}

export function createClaudeNormalizationState() {
  return {
    toolUses: new Map(),
    taskIdToToolUseId: new Map(),
    completedCollabToolUseIds: new Set(),
  }
}

function getClaudeMessageContentBlocks(event = {}) {
  const content = event?.message?.content ?? event?.content
  return Array.isArray(content) ? content : []
}

function stringifyClaudeToolInput(input = {}) {
  if (!input || typeof input !== 'object') {
    return ''
  }

  const command = String(input.command || '').trim()
  if (command) {
    return command
  }

  const singleValueKeys = ['file_path', 'path', 'pattern', 'query', 'url', 'description']
  for (const key of singleValueKeys) {
    const value = String(input[key] || '').trim()
    if (value) {
      return value
    }
  }

  try {
    const compact = JSON.stringify(input)
    return compact.length <= 240 ? compact : `${compact.slice(0, 237)}...`
  } catch {
    return ''
  }
}

function buildClaudeToolCommand(name = '', input = {}) {
  const toolName = String(name || 'Claude Code tool').trim() || 'Claude Code tool'
  const inputSummary = stringifyClaudeToolInput(input)
  return inputSummary ? `${toolName}: ${inputSummary}` : toolName
}

function buildClaudeCollabState(toolUse = {}, overrides = {}) {
  const taskId = String(overrides.taskId || '').trim()
  const message = stringifyClaudeToolResultContent(overrides.message)
  const baseStatus = overrides.status ?? (message ? 'completed' : 'running')
  const status = normalizeCollabAgentStatus(baseStatus)

  return {
    status,
    message,
    title: String(overrides.title || toolUse.description || '').trim(),
    role: String(overrides.role || toolUse.role || '').trim(),
    target: String(overrides.target || toolUse.target || '').trim(),
    model: String(overrides.model || toolUse.model || '').trim(),
    ...(taskId ? { task_id: taskId } : {}),
  }
}

function createClaudeToolUseEvent(block = {}, state = createClaudeNormalizationState()) {
  const toolUseId = String(block?.id || '').trim()
  const name = String(block?.name || block?.tool_name || 'Claude Code tool').trim() || 'Claude Code tool'
  const input = block?.input && typeof block.input === 'object' ? block.input : {}
  const command = buildClaudeToolCommand(name, input)
  const isCollabTool = isClaudeCollabToolName(name)
  const isTodoTool = isClaudeTodoToolName(name)
  const collabPrompt = String(input.prompt || '').trim()
  const collabDescription = String(input.description || '').trim()
  const collabRole = String(input.subagent_type || input.agent || '').trim()
  const collabModel = String(input.model || '').trim()
  const collabTarget = extractAgentTargetFromTexts(collabDescription, collabPrompt)
  const todoItems = normalizeClaudeTodoItems(input.todos)

  if (toolUseId) {
    state.toolUses.set(toolUseId, {
      name,
      command,
      kind: isCollabTool ? 'collab' : (isTodoTool ? 'todo' : 'command'),
      prompt: collabPrompt || collabDescription,
      description: collabDescription,
      role: collabRole,
      model: collabModel,
      target: collabTarget,
      taskIds: [],
      todoItems,
    })
  }

  if (isCollabTool) {
    return {
      ...createItemStartedEvent({
        type: AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL,
        tool: 'spawn_agent',
        receiver_thread_ids: [],
        prompt: collabPrompt || collabDescription,
        agents_states: {},
      }),
    }
  }

  if (isTodoTool) {
    return {
      ...createItemStartedEvent({
        type: AGENT_RUN_ITEM_TYPES.TODO_LIST,
        items: todoItems,
      }),
    }
  }

  return {
    ...createItemStartedEvent({
      type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
      command,
      status: 'in_progress',
    }),
  }
}

function createClaudeToolResultEvent(block = {}, state = createClaudeNormalizationState()) {
  const toolUseId = String(block?.tool_use_id || block?.toolUseId || '').trim()
  const remembered = toolUseId ? state.toolUses.get(toolUseId) : null
  const output = stringifyClaudeToolResultContent(block?.content ?? block?.result)
  const isError = Boolean(block?.is_error)
  const taskIds = Array.isArray(remembered?.taskIds) ? remembered.taskIds.filter(Boolean) : []
  const collabTool = remembered?.kind === 'collab'
  const todoTool = remembered?.kind === 'todo'

  if (toolUseId && state.completedCollabToolUseIds.has(toolUseId)) {
    return null
  }

  if (toolUseId) {
    state.toolUses.delete(toolUseId)
  }
  taskIds.forEach((taskId) => {
    state.taskIdToToolUseId.delete(taskId)
  })

  if (collabTool) {
    if (toolUseId) {
      state.completedCollabToolUseIds.add(toolUseId)
    }
    const receiverThreadIds = taskIds.length
      ? taskIds
      : (toolUseId ? [`claude-agent-${toolUseId}`] : [])
    const agentsStates = Object.fromEntries(
      receiverThreadIds.map((taskId) => [taskId, buildClaudeCollabState(remembered, {
        taskId,
        status: isError ? 'failed' : 'completed',
        message: output,
      })])
    )

    return {
      ...createItemCompletedEvent({
        type: AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL,
        tool: 'wait',
        receiver_thread_ids: receiverThreadIds,
        prompt: remembered?.prompt || remembered?.description || '',
        agents_states: agentsStates,
      }),
    }
  }

  if (todoTool) {
    return {
      ...createItemCompletedEvent({
        type: AGENT_RUN_ITEM_TYPES.TODO_LIST,
        items: Array.isArray(remembered?.todoItems) ? remembered.todoItems : [],
      }),
    }
  }

  return {
    ...createItemCompletedEvent({
      type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
      command: remembered?.command || remembered?.name || 'Claude Code tool',
      status: isError ? 'failed' : 'completed',
      exit_code: isError ? 1 : 0,
      aggregated_output: output,
    }),
  }
}

function resolveClaudeTaskToolUseId(event = {}, state = createClaudeNormalizationState()) {
  const explicitToolUseId = String(event?.tool_use_id || event?.toolUseId || '').trim()
  if (explicitToolUseId) {
    return explicitToolUseId
  }

  const taskId = String(event?.task_id || event?.taskId || '').trim()
  if (!taskId) {
    return ''
  }

  return String(state.taskIdToToolUseId.get(taskId) || '').trim()
}

function createClaudeTaskStartedEvent(event = {}, state = createClaudeNormalizationState()) {
  const toolUseId = resolveClaudeTaskToolUseId(event, state)
  const taskId = String(event?.task_id || event?.taskId || '').trim()
  const remembered = toolUseId ? state.toolUses.get(toolUseId) : null

  if (!remembered || remembered.kind !== 'collab' || !taskId) {
    return null
  }

  if (!Array.isArray(remembered.taskIds)) {
    remembered.taskIds = []
  }
  if (!remembered.taskIds.includes(taskId)) {
    remembered.taskIds.push(taskId)
  }
  state.taskIdToToolUseId.set(taskId, toolUseId)

  return {
    ...createItemCompletedEvent({
      type: AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL,
      tool: 'spawn_agent',
      receiver_thread_ids: [taskId],
      prompt: remembered.prompt || String(event?.prompt || event?.description || '').trim(),
      agents_states: {
        [taskId]: buildClaudeCollabState(remembered, {
          taskId,
          status: 'running',
          title: String(event?.description || remembered.description || '').trim(),
          target: extractAgentTargetFromTexts(event?.description, event?.prompt, remembered.target),
        }),
      },
    }),
  }
}

function createClaudeTaskFinishedEvent(event = {}, state = createClaudeNormalizationState()) {
  const subtype = String(event?.subtype || '').trim().toLowerCase()
  const toolUseId = resolveClaudeTaskToolUseId(event, state)
  const taskId = String(event?.task_id || event?.taskId || '').trim()
  const remembered = toolUseId ? state.toolUses.get(toolUseId) : null

  if (!remembered || remembered.kind !== 'collab') {
    return null
  }

  if (toolUseId && state.completedCollabToolUseIds.has(toolUseId)) {
    return null
  }

  const failed = subtype === 'task_failed'
  const output = stringifyClaudeToolResultContent(
    event?.result
      ?? event?.message
      ?? event?.content
      ?? event?.error
      ?? event?.task_result
  )

  if (toolUseId) {
    state.toolUses.delete(toolUseId)
    state.completedCollabToolUseIds.add(toolUseId)
  }
  if (taskId) {
    state.taskIdToToolUseId.delete(taskId)
  }

  return {
    ...createItemCompletedEvent({
      type: AGENT_RUN_ITEM_TYPES.COLLAB_TOOL_CALL,
      tool: 'wait',
      receiver_thread_ids: taskId ? [taskId] : (Array.isArray(remembered.taskIds) ? remembered.taskIds.filter(Boolean) : []),
      prompt: remembered.prompt || remembered.description || '',
      agents_states: {
        [(taskId || `claude-agent-${toolUseId}`)]: buildClaudeCollabState(remembered, {
          taskId,
          status: failed ? 'failed' : 'completed',
          message: output,
          title: String(event?.description || remembered.description || '').trim(),
          target: extractAgentTargetFromTexts(event?.description, event?.prompt, remembered.target),
        }),
      },
    }),
  }
}

function buildClaudeApiRetryReason(event = {}) {
  const status = Number(event?.error_status) || 0
  const code = String(event?.error || '').trim()
  const parts = []
  if (status > 0) {
    parts.push(`HTTP ${status}`)
  }
  if (code) {
    parts.push(code)
  }
  return parts.join(' ').trim()
}

function isClaudeFatalAuthRetry(event = {}) {
  const status = Number(event?.error_status) || 0
  const code = String(event?.error || '').trim().toLowerCase()
  return status === 401 || code === 'authentication_failed'
}

function formatClaudeFatalAuthMessage(event = {}) {
  const reason = buildClaudeApiRetryReason(event)
  return reason
    ? `Claude Code 认证失败（${reason}）。请重新登录 Claude Code，或检查当前环境中的认证令牌配置。`
    : 'Claude Code 认证失败。请重新登录 Claude Code，或检查当前环境中的认证令牌配置。'
}

export function normalizeClaudeEvents(event = {}, state = createClaudeNormalizationState()) {
  const eventType = String(event?.type || '').trim().toLowerCase()
  const normalizedEvents = []

  if (eventType === 'system' && String(event?.subtype || '').trim().toLowerCase() === 'init') {
    return [createThreadStartedEvent(extractClaudeSessionId(event))]
  }

  if (eventType === 'system' && String(event?.subtype || '').trim().toLowerCase() === 'task_started') {
    const collabEvent = createClaudeTaskStartedEvent(event, state)
    return collabEvent ? [collabEvent] : []
  }

  if (
    eventType === 'system'
    && ['task_result', 'task_completed', 'task_failed'].includes(String(event?.subtype || '').trim().toLowerCase())
  ) {
    const collabEvent = createClaudeTaskFinishedEvent(event, state)
    return collabEvent ? [collabEvent] : []
  }

  if (eventType === 'system' && String(event?.subtype || '').trim().toLowerCase() === 'api_retry') {
    if (isClaudeFatalAuthRetry(event)) {
      return [createErrorEvent(formatClaudeFatalAuthMessage(event))]
    }

    const attempt = Math.max(1, Number(event?.attempt) || 1)
    const total = Math.max(attempt, Number(event?.max_retries) || attempt)
    const reason = buildClaudeApiRetryReason(event) || 'request failed'
    return [createErrorEvent(`Reconnecting... ${attempt}/${total} (${reason})`)]
  }

  if (eventType === 'assistant') {
    const blocks = getClaudeMessageContentBlocks(event)

    blocks.forEach((block) => {
      const blockType = String(block?.type || '').trim().toLowerCase()
      if (blockType === 'thinking') {
        const text = String(block?.thinking || block?.text || '').trim()
        if (text) {
          normalizedEvents.push({
            ...createItemStartedEvent({
              type: AGENT_RUN_ITEM_TYPES.REASONING,
              text,
            }),
          })
        }
        return
      }

      if (blockType === 'tool_use') {
        normalizedEvents.push(createClaudeToolUseEvent(block, state))
        return
      }

      if (blockType === 'text') {
        const text = String(block?.text || '').trim()
        if (text) {
          normalizedEvents.push({
            ...createItemCompletedEvent({
              type: AGENT_RUN_ITEM_TYPES.AGENT_MESSAGE,
              text,
            }),
          })
        }
      }
    })

    return normalizedEvents
  }

  if (eventType === 'user') {
    const blocks = getClaudeMessageContentBlocks(event)
    blocks.forEach((block) => {
      const blockType = String(block?.type || '').trim().toLowerCase()
      if (blockType === 'tool_result') {
        const toolResultEvent = createClaudeToolResultEvent(block, state)
        if (toolResultEvent) {
          normalizedEvents.push(toolResultEvent)
        }
      }
    })
    return normalizedEvents
  }

  if (eventType === 'tool_use' || eventType === 'tool_use.delta') {
    return [createClaudeToolUseEvent(event, state)]
  }

  if (eventType === 'result') {
    const text = extractClaudeResultText(event)
    const usage = event?.usage && typeof event.usage === 'object'
      ? {
          input_tokens: Number(event.usage.input_tokens) || 0,
          output_tokens: Number(event.usage.output_tokens) || 0,
          cached_input_tokens: Number(event.usage.cached_input_tokens ?? event.usage.cache_read_input_tokens) || 0,
        }
      : null
    return [createTurnCompletedEvent({
      result: text,
      ...(usage ? { usage } : {}),
    })]
  }

  if (eventType === 'error') {
    const message = extractClaudeResultText(event) || extractClaudeAssistantText(event) || String(event?.error || event?.message || '').trim()
    return [createErrorEvent(message)]
  }

  return [{
    type: `claude.${eventType || 'event'}`,
    detail: extractClaudeAssistantText(event) || extractClaudeResultText(event) || '',
  }]
}

export function normalizeClaudeEvent(event = {}, state = createClaudeNormalizationState()) {
  return normalizeClaudeEvents(event, state)[0] || null
}

function createExecArgs(session, prompt) {
  const args = [
    ...CLAUDE_DEFAULT_ARGS,
    '--output-format',
    'stream-json',
    '--verbose',
  ]

  const sessionId = String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  if (sessionId) {
    args.push('--resume', sessionId)
  }

  args.push('-p', String(prompt || ''))
  return args
}

function createClaudeRunStatusEvent(session = {}) {
  const hasExistingThread = Boolean(
    String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  )

  return {
    ...createStatusEnvelopeEvent({
      stage: hasExistingThread ? 'resuming' : 'starting',
      message: hasExistingThread
        ? '已连接 PromptX 项目，正在继续这轮执行。'
        : '已创建 PromptX 项目，正在启动第一轮执行。',
    }),
  }
}

export function streamPromptToClaudeCodeSession(sessionInput, prompt, callbacks = {}) {
  const session = sessionInput && typeof sessionInput === 'object' ? sessionInput : null
  const normalizedPrompt = String(prompt || '').trim()

  if (!session?.id || !session?.cwd) {
    throw new Error('缺少 PromptX 项目。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : () => {}
  const onThreadStarted = typeof callbacks.onThreadStarted === 'function' ? callbacks.onThreadStarted : () => {}

  const child = createClaudeSpawn(createExecArgs(session, normalizedPrompt), session.cwd)
  onEvent(createClaudeRunStatusEvent(session))

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrLine = ''
  let finalMessage = ''
  let finalSessionId = String(session.engineSessionId || session.engineThreadId || session.codexThreadId || '').trim()
  let fatalClaudeErrorMessage = ''
  let fatalClaudeErrorTriggered = false
  let resultExitGraceTimer = null
  let settled = false
  let resolveResult = null
  let rejectResult = null
  const normalizationState = createClaudeNormalizationState()

  const clearResultExitGraceTimer = () => {
    if (resultExitGraceTimer) {
      clearTimeout(resultExitGraceTimer)
      resultExitGraceTimer = null
    }
  }

  const settleCompleted = (options = {}) => {
    if (settled) {
      return
    }

    settled = true
    clearResultExitGraceTimer()
    onEvent(createCompletedEnvelopeEvent(finalMessage))
    resolveResult?.({
      sessionId: session.id,
      threadId: finalSessionId,
      message: finalMessage,
    })

    if (options.stopChild && child.exitCode === null && child.signalCode === null) {
      forceStopChildProcess(child, { graceMs: CLAUDE_RESULT_FORCE_STOP_GRACE_MS })
    }
  }

  const settleError = (error) => {
    if (settled) {
      return
    }

    settled = true
    clearResultExitGraceTimer()
    rejectResult?.(error)
  }

  const scheduleResultExitGrace = () => {
    if (settled || resultExitGraceTimer || CLAUDE_RESULT_EXIT_GRACE_MS <= 0) {
      return
    }

    resultExitGraceTimer = setTimeout(() => {
      resultExitGraceTimer = null
      settleCompleted({ stopChild: true })
    }, CLAUDE_RESULT_EXIT_GRACE_MS)
    resultExitGraceTimer.unref?.()
  }

  const rememberSessionId = (sessionId) => {
    const value = String(sessionId || '').trim()
    if (!value || value === finalSessionId) {
      return
    }
    finalSessionId = value
    onThreadStarted(value)
  }

  const emitClaudeJsonLine = (line) => {
    const event = parseJsonLine(line)
    if (!event) {
      onEvent({
        ...createStdoutEnvelopeEvent(line),
      })
      return
    }

    const sessionId = extractClaudeSessionId(event)
    if (sessionId) {
      rememberSessionId(sessionId)
    }

    const normalizedEvents = normalizeClaudeEvents(event, normalizationState)
    normalizedEvents.forEach((normalizedEvent) => {
      onEvent(createAgentEventEnvelopeEvent(normalizedEvent))
    })

    if (!fatalClaudeErrorTriggered && isClaudeFatalAuthRetry(event)) {
      fatalClaudeErrorTriggered = true
      fatalClaudeErrorMessage = formatClaudeFatalAuthMessage(event)
      forceStopChildProcess(child)
    }

    if (String(event?.type || '').trim().toLowerCase() === 'result') {
      finalMessage = extractClaudeResultText(event) || finalMessage
      scheduleResultExitGrace()
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest
    lines.forEach(emitClaudeJsonLine)
  })

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest
    lines.forEach((line) => {
      lastStderrLine = line
      onEvent(createStderrEnvelopeEvent(line))
    })
  })

  const result = new Promise((resolve, reject) => {
    resolveResult = resolve
    rejectResult = reject

    child.on('error', (error) => {
      settleError(normalizeSpawnError(error))
    })

    child.on('close', (code) => {
      if (settled) {
        return
      }

      flushBufferedText(stdoutBuffer).forEach(emitClaudeJsonLine)
      flushBufferedText(stderrBuffer).forEach((line) => {
        lastStderrLine = line
        onEvent(createStderrEnvelopeEvent(line))
      })

      if (code !== 0) {
        const detail = fatalClaudeErrorMessage || lastStderrLine || 'Claude Code 执行失败。'
        settleError(new Error(detail))
        return
      }

      settleCompleted()
    })
  })

  return {
    child,
    result,
    cancel(options = {}) {
      forceStopChildProcess(child, options)
    },
  }
}

export const claudeCodeRunner = {
  engine: AGENT_ENGINES.CLAUDE_CODE,
  label: getAgentEngineLabel(AGENT_ENGINES.CLAUDE_CODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  streamSessionPrompt(session, prompt, callbacks = {}) {
    return streamPromptToClaudeCodeSession(session, prompt, callbacks)
  },
}
