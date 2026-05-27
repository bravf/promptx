import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import iconv from 'iconv-lite'
import initSqlJs from 'sql.js'
import {
  AGENT_RUN_EVENT_TYPES,
  createAgentEventEnvelopeEvent,
  createCompletedEnvelopeEvent,
  createStatusEnvelopeEvent,
  createStderrEnvelopeEvent,
  createStdoutEnvelopeEvent,
} from '../../../packages/shared/src/index.js'
import { createManagedSpawnOptions, forceStopChildProcess } from './processControl.js'

const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const STATE_DB_PATH = path.join(CODEX_HOME, 'state_5.sqlite')
const TMP_DIR = path.join(CODEX_HOME, 'tmp')
const MAX_THREAD_COUNT = 120
const MAX_OUTPUT_TAIL_LENGTH = 64 * 1024
const CODEX_RESULT_EXIT_GRACE_MS = Math.max(
  0,
  Number(process.env.PROMPTX_CODEX_RESULT_EXIT_GRACE_MS) || 3000
)
const CODEX_RESULT_FORCE_STOP_GRACE_MS = Math.max(
  200,
  Number(process.env.PROMPTX_CODEX_RESULT_FORCE_STOP_GRACE_MS) || 1500
)
const CODEX_DEFAULT_ARGS = ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
const RESOLVED_CODEX_BIN = resolveCodexBinary()
const require = createRequire(import.meta.url)
const sqlWasmPath = require.resolve('sql.js/dist/sql-wasm.wasm')
const SQL = await initSqlJs({
  locateFile: () => sqlWasmPath,
})

function ensureCodexHome() {
  fs.mkdirSync(TMP_DIR, { recursive: true })
}

function resolveCodexBinary() {
  if (process.platform !== 'win32') {
    return CODEX_BIN
  }

  if (path.extname(CODEX_BIN)) {
    return CODEX_BIN
  }

  if (fs.existsSync(`${CODEX_BIN}.cmd`)) {
    return `${CODEX_BIN}.cmd`
  }

  if (fs.existsSync(`${CODEX_BIN}.bat`)) {
    return `${CODEX_BIN}.bat`
  }

  if (fs.existsSync(CODEX_BIN)) {
    return CODEX_BIN
  }

  try {
    const output = execFileSync('where.exe', [CODEX_BIN], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return CODEX_BIN
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || CODEX_BIN
  } catch {
    return CODEX_BIN
  }
}

function createCodexSpawn(commandArgs = [], cwd = '') {
  const options = createManagedSpawnOptions({
    cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(RESOLVED_CODEX_BIN)) {
    return spawn(
      process.env.ComSpec || 'cmd.exe',
      ['/d', '/s', '/c', RESOLVED_CODEX_BIN, ...commandArgs],
      options
    )
  }

  return spawn(RESOLVED_CODEX_BIN, commandArgs, options)
}

function normalizeSpawnError(error) {
  if (error?.code === 'ENOENT') {
    const attempted = RESOLVED_CODEX_BIN === CODEX_BIN
      ? CODEX_BIN
      : `${CODEX_BIN} -> ${RESOLVED_CODEX_BIN}`
    return new Error(
      `找不到 Codex CLI（尝试执行：${attempted}）。请先确认终端里可以运行 \`codex --version\`，或设置环境变量 \`CODEX_BIN\` 指向可执行文件。Windows 常见路径是 \`%APPDATA%\\npm\\codex.cmd\`。`
    )
  }

  return error
}

function trimOutput(value = '', maxLength = 12000) {
  const text = String(value || '').trim()
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(text.length - maxLength)
}

function appendOutputTail(current = '', chunk = '', maxLength = MAX_OUTPUT_TAIL_LENGTH) {
  const text = `${String(current || '')}${String(chunk || '')}`
  if (text.length <= maxLength) {
    return text
  }
  return text.slice(text.length - maxLength)
}

function countSuspiciousMojibakeChars(value = '') {
  return (String(value || '').match(/[鑾彇娴嬭瘯鏁嵁璺緞璇诲彇鍒嗛鍚庡墠杩欎釜閫夋嫨鎻掑叆鍖哄伐浣滃櫒]/g) || []).length
}

function countReadableCjkChars(value = '') {
  return (String(value || '').match(/[\u4e00-\u9fff]/g) || []).length
}

function repairPossibleMojibake(value = '') {
  const text = String(value || '')
  if (!text) {
    return text
  }

  const suspiciousCount = countSuspiciousMojibakeChars(text)
  if (suspiciousCount < 2) {
    return text
  }

  let repaired = text
  try {
    repaired = iconv.decode(iconv.encode(text, 'gb18030'), 'utf8')
  } catch {
    return text
  }

  if (!repaired || repaired === text) {
    return text
  }

  const repairedSuspiciousCount = countSuspiciousMojibakeChars(repaired)

  if (repairedSuspiciousCount < suspiciousCount && countReadableCjkChars(repaired) > 0) {
    return repaired
  }

  return text
}

function sanitizeCodexPayload(value) {
  if (typeof value === 'string') {
    return repairPossibleMojibake(value)
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeCodexPayload(item))
  }

  if (!value || typeof value !== 'object') {
    return value
  }

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeCodexPayload(item)])
  )
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
  const lines = parts.map((line) => line.trim()).filter(Boolean)
  return { lines, rest }
}

function flushBufferedText(buffer = '') {
  const { lines, rest } = splitBufferedLines(buffer)
  const tail = String(rest || '').trim()
  return tail ? [...lines, tail] : lines
}

function extractTextFromUnknownError(input, depth = 0) {
  if (!input || depth > 4) {
    return ''
  }

  if (typeof input === 'string') {
    return input.trim()
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

    const text = extractTextFromUnknownError(input[key], depth + 1)
    if (text) {
      return text
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

function extractLatestCodexEventError(stdout = '') {
  const lines = flushBufferedText(stdout)
  let latestError = ''

  for (const line of lines) {
    const event = parseJsonLine(line)
    if (!event || (event.type !== 'error' && event.type !== 'turn.failed')) {
      continue
    }

    const text = extractTextFromUnknownError(sanitizeCodexPayload(event))
    if (text) {
      latestError = text
    }
  }

  return latestError
}

function normalizeManagedSession(sessionInput) {
  if (!sessionInput || typeof sessionInput !== 'object') {
    return null
  }

  const id = String(sessionInput.id || '').trim()
  const cwd = String(sessionInput.cwd || '').trim()
  if (!id || !cwd) {
    return null
  }

  return {
    id,
    title: String(sessionInput.title || '').trim(),
    cwd,
    codexThreadId: String(sessionInput.codexThreadId || '').trim(),
  }
}

function createExecArgs(session) {
  const baseArgs = ['exec', ...CODEX_DEFAULT_ARGS, ...(session.cwd ? ['-C', session.cwd] : [])]

  if (session.codexThreadId) {
    return [...baseArgs, 'resume', session.codexThreadId, '-', '--json']
  }

  return [...baseArgs, '-', '--json']
}

function extractCodexError(stderr = '', stdout = '') {
  const eventError = extractLatestCodexEventError(stdout)
  if (eventError) {
    return eventError
  }

  const stderrText = trimOutput(stderr)
  if (stderrText) {
    const lines = stderrText.split('\n').map((line) => line.trim()).filter(Boolean)
    return lines[lines.length - 1] || stderrText
  }

  const stdoutText = trimOutput(stdout)
  if (!stdoutText) {
    return 'Codex 执行失败。'
  }

  const lines = stdoutText.split('\n').map((line) => line.trim()).filter(Boolean)
  return lines[lines.length - 1] || stdoutText
}

function trackThreadId(event, setThreadId) {
  if (event?.type === AGENT_RUN_EVENT_TYPES.THREAD_STARTED && event.thread_id) {
    setThreadId(String(event.thread_id))
  }
}

function extractCodexCompletionMessage(event = {}) {
  if (event?.type === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
    return extractTextFromUnknownError(event.result)
      || extractTextFromUnknownError(event.message)
      || extractTextFromUnknownError(event.response)
  }

  if (
    event?.type === AGENT_RUN_EVENT_TYPES.ITEM_COMPLETED
    && event?.item?.type === 'agent_message'
  ) {
    return extractTextFromUnknownError(event.item.text)
      || extractTextFromUnknownError(event.item.message)
      || extractTextFromUnknownError(event.item.content)
  }

  return ''
}

function parseThreadIdFromStdout(stdout = '') {
  const lines = String(stdout || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const event = parseJsonLine(line)
    if (event?.type === AGENT_RUN_EVENT_TYPES.THREAD_STARTED && event.thread_id) {
      return String(event.thread_id)
    }
  }

  return ''
}

function loadCodexThreads(limit = MAX_THREAD_COUNT) {
  if (!fs.existsSync(STATE_DB_PATH)) {
    return []
  }

  try {
    const sql = `select id, cwd, title, updated_at from threads order by updated_at desc limit ${Math.max(1, Number(limit) || MAX_THREAD_COUNT)};`
    const db = new SQL.Database(new Uint8Array(fs.readFileSync(STATE_DB_PATH)))

    try {
      const statement = db.prepare(sql)
      const rows = []

      try {
        while (statement.step()) {
          rows.push(statement.getAsObject())
        }
      } finally {
        statement.free()
      }

      return rows
    } finally {
      db.close()
    }
  } catch {
    return []
  }
}

export function listKnownCodexWorkspaces(limit = MAX_THREAD_COUNT) {
  const seen = new Set()
  const items = []

  loadCodexThreads(limit).forEach((thread) => {
    const cwd = String(thread.cwd || '').trim()
    if (!cwd || seen.has(cwd)) {
      return
    }
    seen.add(cwd)
    items.push(cwd)
  })

  return items
}

export function streamPromptToCodexSession(sessionInput, prompt, callbacks = {}) {
  const session = normalizeManagedSession(sessionInput)
  const normalizedPrompt = String(prompt || '').trim()

  if (!session) {
    throw new Error('缺少 PromptX 项目。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  ensureCodexHome()

  const outputFile = path.join(TMP_DIR, `promptx-codex-${Date.now()}-${process.pid}.txt`)
  const onEvent = typeof callbacks.onEvent === 'function' ? callbacks.onEvent : () => {}
  const onThreadStarted = typeof callbacks.onThreadStarted === 'function' ? callbacks.onThreadStarted : () => {}

  const child = createCodexSpawn(
    [
      ...createExecArgs(session),
      '--output-last-message',
      outputFile,
    ],
    session.cwd
  )

  let stdoutBuffer = ''
  let stderrBuffer = ''
  let stdoutRaw = ''
  let stderrRaw = ''
  let finalMessage = ''
  let finalThreadId = session.codexThreadId || ''
  let resultExitGraceTimer = null
  let settled = false
  let resolveResult = null
  let rejectResult = null

  const clearResultExitGraceTimer = () => {
    if (resultExitGraceTimer) {
      clearTimeout(resultExitGraceTimer)
      resultExitGraceTimer = null
    }
  }

  const readOutputFileMessage = () => {
    if (!fs.existsSync(outputFile)) {
      return ''
    }

    return repairPossibleMojibake(fs.readFileSync(outputFile, 'utf8').trim())
  }

  const refreshFinalMessageFromOutputFile = () => {
    finalMessage = readOutputFileMessage() || finalMessage
  }

  const settleCompleted = (options = {}) => {
    if (settled) {
      return
    }

    settled = true
    clearResultExitGraceTimer()
    refreshFinalMessageFromOutputFile()
    if (!finalThreadId) {
      finalThreadId = parseThreadIdFromStdout(stdoutRaw)
    }
    emit(createCompletedEnvelopeEvent(finalMessage))
    resolveResult?.({
      sessionId: session.id,
      message: finalMessage,
      threadId: finalThreadId,
    })

    if (options.stopChild && child.exitCode === null && child.signalCode === null) {
      forceStopChildProcess(child, { graceMs: CODEX_RESULT_FORCE_STOP_GRACE_MS })
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
    if (settled || resultExitGraceTimer || CODEX_RESULT_EXIT_GRACE_MS <= 0) {
      return
    }

    resultExitGraceTimer = setTimeout(() => {
      resultExitGraceTimer = null
      settleCompleted({ stopChild: true })
    }, CODEX_RESULT_EXIT_GRACE_MS)
    resultExitGraceTimer.unref?.()
  }

  const emit = (event) => {
    try {
      onEvent(event)
    } catch {
      // Ignore observer failures to avoid breaking the process lifecycle.
    }
  }

  const rememberThreadId = (threadId) => {
    const value = String(threadId || '').trim()
    if (!value || value === finalThreadId) {
      return
    }
    finalThreadId = value
    try {
      onThreadStarted(value)
    } catch {
      // Ignore observer failures to avoid breaking the process lifecycle.
    }
  }

  emit(createStatusEnvelopeEvent({
    stage: session.codexThreadId ? 'resuming' : 'starting',
    message: session.codexThreadId
      ? '已连接 PromptX 项目，正在继续这轮执行。'
      : '已创建 PromptX 项目，正在启动第一轮执行。',
  }))

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdoutRaw = appendOutputTail(stdoutRaw, text)
    stdoutBuffer += text
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest

    for (const line of lines) {
      const event = parseJsonLine(line)
      if (event) {
        trackThreadId(event, rememberThreadId)
        emit(createAgentEventEnvelopeEvent(sanitizeCodexPayload(event)))
        finalMessage = extractCodexCompletionMessage(event) || finalMessage
        if (event.type === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
          scheduleResultExitGrace()
        }
        continue
      }

      emit(createStdoutEnvelopeEvent(repairPossibleMojibake(line)))
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderrRaw = appendOutputTail(stderrRaw, text)
    stderrBuffer += text
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest

    for (const line of lines) {
      emit(createStderrEnvelopeEvent(repairPossibleMojibake(line)))
    }
  })

  child.stdin.write(normalizedPrompt)
  child.stdin.end()

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

      const stdoutTail = flushBufferedText(stdoutBuffer)
      const stderrTail = flushBufferedText(stderrBuffer)

      stdoutTail.forEach((line) => {
        const event = parseJsonLine(line)
        if (event) {
          trackThreadId(event, rememberThreadId)
          emit(createAgentEventEnvelopeEvent(sanitizeCodexPayload(event)))
          finalMessage = extractCodexCompletionMessage(event) || finalMessage
          if (event.type === AGENT_RUN_EVENT_TYPES.TURN_COMPLETED) {
            scheduleResultExitGrace()
          }
        } else {
          emit(createStdoutEnvelopeEvent(repairPossibleMojibake(line)))
        }
      })

      stderrTail.forEach((line) => {
        emit(createStderrEnvelopeEvent(repairPossibleMojibake(line)))
      })

      refreshFinalMessageFromOutputFile()

      if (code !== 0) {
        settleError(new Error(repairPossibleMojibake(extractCodexError(stderrRaw, stdoutRaw))))
        return
      }

      settleCompleted()
    })
  }).finally(() => {
    fs.rmSync(outputFile, { force: true })
  })

  return {
    child,
    result,
    cancel(options = {}) {
      if (child.killed || !child.pid) {
        return
      }
      forceStopChildProcess(child, options)
    },
  }
}
