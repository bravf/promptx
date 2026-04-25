import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import {
  AGENT_ENGINES,
  AGENT_RUN_ITEM_TYPES,
  createAgentEventEnvelopeEvent,
  createCompletedEnvelopeEvent,
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

const KIMI_CODE_BIN = process.env.KIMI_CODE_BIN || 'kimi'
const RESOLVED_KIMI_CODE_BIN = resolveKimiCodeBinary()

function resolveKimiCodeBinary() {
  if (process.platform !== 'win32') {
    return KIMI_CODE_BIN
  }

  if (path.extname(KIMI_CODE_BIN)) {
    return KIMI_CODE_BIN
  }

  if (fs.existsSync(`${KIMI_CODE_BIN}.cmd`)) {
    return `${KIMI_CODE_BIN}.cmd`
  }

  if (fs.existsSync(`${KIMI_CODE_BIN}.bat`)) {
    return `${KIMI_CODE_BIN}.bat`
  }

  if (fs.existsSync(KIMI_CODE_BIN)) {
    return KIMI_CODE_BIN
  }

  try {
    const output = execFileSync('where.exe', [KIMI_CODE_BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return KIMI_CODE_BIN
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || KIMI_CODE_BIN
  } catch {
    return KIMI_CODE_BIN
  }
}

function createKimiSpawn(commandArgs = [], cwd = '') {
  const options = createManagedSpawnOptions({
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(RESOLVED_KIMI_CODE_BIN)) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', RESOLVED_KIMI_CODE_BIN, ...commandArgs],
      options
    )
  }

  return spawn(RESOLVED_KIMI_CODE_BIN, commandArgs, options)
}

function normalizeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    const attempted = RESOLVED_KIMI_CODE_BIN === KIMI_CODE_BIN
      ? KIMI_CODE_BIN
      : `${KIMI_CODE_BIN} -> ${RESOLVED_KIMI_CODE_BIN}`
    return new Error(
      `找不到 Kimi Code CLI（尝试执行：${attempted}）。请先确认终端里可以运行 \`kimi --version\`，或设置环境变量 \`KIMI_CODE_BIN\`。`
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

function stringifyKimiToolResultContent(value) {
  if (typeof value === 'string') {
    return value.trim()
  }

  if (value == null) {
    return ''
  }

  if (Array.isArray(value)) {
    const parts = []
    for (const item of value) {
      if (item && typeof item === 'object') {
        const text = String(item.text || '').trim()
        if (text) parts.push(text)
      } else if (typeof item === 'string') {
        const text = item.trim()
        if (text) parts.push(text)
      }
    }
    return parts.join('\n').trim()
  }

  try {
    const compact = JSON.stringify(value)
    return compact.length <= 12000 ? compact : `${compact.slice(0, 11997)}...`
  } catch {
    return String(value || '').trim()
  }
}

function buildKimiToolCommand(name = '', input = {}) {
  const toolName = String(name || 'Kimi tool').trim() || 'Kimi tool'
  if (!input || typeof input !== 'object') {
    return toolName
  }

  const command = String(input.command || '').trim()
  if (command) {
    return `${toolName}: ${command}`
  }

  const singleValueKeys = ['file_path', 'path', 'pattern', 'query', 'url', 'description']
  for (const key of singleValueKeys) {
    const value = String(input[key] || '').trim()
    if (value) {
      return `${toolName}: ${value}`
    }
  }

  try {
    const compact = JSON.stringify(input)
    return compact.length <= 240 ? `${toolName}: ${compact}` : `${toolName}: ${compact.slice(0, 237)}...`
  } catch {
    return toolName
  }
}

function extractKimiSessionIdFromStderrLine(line = '') {
  const match = String(line || '').match(/To resume this session:\s*kimi\s+(?:-r|--session|--resume)\s+([a-f0-9-]+)/i)
  return match?.[1] ? String(match[1]).trim() : ''
}

export function isKimiInfoStderrLine(line = '') {
  const text = String(line || '').trim()
  if (!text) {
    return true
  }
  if (/^To resume this session:/i.test(text)) {
    return true
  }
  if (/^Shell cwd was reset to /i.test(text)) {
    return true
  }
  return false
}

export function createKimiNormalizationState() {
  return {
    turnStarted: false,
    toolUses: new Map(),
  }
}

export function normalizeKimiEvents(event = {}, state = createKimiNormalizationState()) {
  const role = String(event?.role || '').trim().toLowerCase()
  const normalizedEvents = []

  if (role === 'assistant') {
    if (!state.turnStarted) {
      state.turnStarted = true
      normalizedEvents.push({ type: 'turn.started' })
    }

    const content = Array.isArray(event.content) ? event.content : []
    content.forEach((block) => {
      const blockType = String(block?.type || '').trim().toLowerCase()
      if (blockType === 'think') {
        const text = String(block?.think || '').trim()
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
        return
      }
    })

    const toolCalls = Array.isArray(event.tool_calls) ? event.tool_calls : []
    toolCalls.forEach((toolCall) => {
      const toolUseId = String(toolCall?.id || '').trim()
      const name = String(toolCall?.function?.name || toolCall?.name || 'Kimi tool').trim() || 'Kimi tool'
      const argsText = toolCall?.function?.arguments || toolCall?.arguments || '{}'
      let parsedArgs = {}
      try {
        parsedArgs = JSON.parse(argsText)
      } catch {
        parsedArgs = {}
      }
      const command = buildKimiToolCommand(name, parsedArgs)

      if (toolUseId) {
        state.toolUses.set(toolUseId, { name, command })
      }

      normalizedEvents.push({
        ...createItemStartedEvent({
          type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
          command,
          status: 'in_progress',
        }),
      })
    })

    return normalizedEvents
  }

  if (role === 'tool') {
    const toolCallId = String(event?.tool_call_id || '').trim()
    const remembered = toolCallId ? state.toolUses.get(toolCallId) : null
    const output = stringifyKimiToolResultContent(event?.content)

    if (toolCallId) {
      state.toolUses.delete(toolCallId)
    }

    normalizedEvents.push({
      ...createItemCompletedEvent({
        type: AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION,
        command: remembered?.command || remembered?.name || 'Kimi tool',
        status: 'completed',
        exit_code: 0,
        aggregated_output: output,
      }),
    })

    return normalizedEvents
  }

  return [{
    type: `kimi.${role || 'event'}`,
    detail: stringifyKimiToolResultContent(event?.content),
  }]
}

export function normalizeKimiEvent(event = {}, state = createKimiNormalizationState()) {
  return normalizeKimiEvents(event, state)[0] || null
}

function createExecArgs(session, prompt) {
  const args = [
    '--print',
    '--output-format', 'stream-json',
  ]

  const sessionId = String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  if (sessionId) {
    args.push('--session', sessionId)
  }

  if (session?.cwd) {
    args.push('--work-dir', session.cwd)
  }

  args.push('-p', String(prompt || ''))

  return args
}

function createKimiRunStatusEvent(session = {}) {
  const hasExistingThread = Boolean(
    String(session?.engineSessionId || session?.engineThreadId || session?.codexThreadId || '').trim()
  )

  return createStatusEnvelopeEvent({
    stage: hasExistingThread ? 'resuming' : 'starting',
    message: hasExistingThread
      ? '已连接 PromptX 项目，正在继续这轮执行。'
      : '已创建 PromptX 项目，正在启动第一轮执行。',
  })
}

export function streamPromptToKimiCodeSession(sessionInput, prompt, callbacks = {}) {
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

  const child = createKimiSpawn(createExecArgs(session, normalizedPrompt), session.cwd)
  onEvent(createKimiRunStatusEvent(session))

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let lastStderrLine = ''
  let finalMessage = ''
  let finalSessionId = String(session.engineSessionId || session.engineThreadId || session.codexThreadId || '').trim()
  const normalizationState = createKimiNormalizationState()

  const rememberSessionId = (sessionId) => {
    const value = String(sessionId || '').trim()
    if (!value || value === finalSessionId) {
      return
    }

    finalSessionId = value
    onThreadStarted(value)
  }

  const emitKimiJsonLine = (line) => {
    const event = parseJsonLine(line)
    if (!event) {
      onEvent(createStdoutEnvelopeEvent(line))
      return
    }

    const normalizedEvents = normalizeKimiEvents(event, normalizationState)
    normalizedEvents.forEach((normalizedEvent) => {
      onEvent(createAgentEventEnvelopeEvent(normalizedEvent))
    })

    const role = String(event?.role || '').trim().toLowerCase()
    if (role === 'assistant') {
      const content = Array.isArray(event.content) ? event.content : []
      const textBlocks = content
        .filter((block) => String(block?.type || '').trim().toLowerCase() === 'text')
        .map((block) => String(block?.text || '').trim())
        .filter(Boolean)

      if (textBlocks.length) {
        const text = textBlocks.join('\n').trim()
        finalMessage = `${finalMessage}${finalMessage ? '\n' : ''}${text}`
      }
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest
    lines.forEach(emitKimiJsonLine)
  })

  child.stderr.on('data', (chunk) => {
    stderrBuffer += chunk.toString()
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest
    lines.forEach((line) => {
      const sessionId = extractKimiSessionIdFromStderrLine(line)
      if (sessionId) {
        rememberSessionId(sessionId)
      }

      if (isKimiInfoStderrLine(line)) {
        return
      }

      lastStderrLine = line
      onEvent(createStderrEnvelopeEvent(line))
    })
  })

  const result = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      reject(normalizeSpawnError(error))
    })

    child.on('close', (code) => {
      flushBufferedText(stdoutBuffer).forEach(emitKimiJsonLine)
      flushBufferedText(stderrBuffer).forEach((line) => {
        const sessionId = extractKimiSessionIdFromStderrLine(line)
        if (sessionId) {
          rememberSessionId(sessionId)
        }

        if (isKimiInfoStderrLine(line)) {
          return
        }

        lastStderrLine = line
        onEvent(createStderrEnvelopeEvent(line))
      })

      if (code !== 0) {
        reject(new Error(lastStderrLine || 'Kimi Code 执行失败。'))
        return
      }

      const message = finalMessage.trim()
      onEvent(createAgentEventEnvelopeEvent(createTurnCompletedEvent()))
      onEvent(createCompletedEnvelopeEvent(message))

      resolve({
        sessionId: session.id,
        threadId: finalSessionId,
        message,
      })
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

export const kimiCodeRunner = {
  engine: AGENT_ENGINES.KIMI_CODE,
  label: getAgentEngineLabel(AGENT_ENGINES.KIMI_CODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  streamSessionPrompt(session, prompt, callbacks = {}) {
    return streamPromptToKimiCodeSession(session, prompt, callbacks)
  },
}
