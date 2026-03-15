import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync, spawn } from 'node:child_process'
import iconv from 'iconv-lite'
import initSqlJs from 'sql.js'

const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')
const STATE_DB_PATH = path.join(CODEX_HOME, 'state_5.sqlite')
const TMP_DIR = path.join(CODEX_HOME, 'tmp')
const MAX_THREAD_COUNT = 120
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
  const options = {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }
  const normalizedCwd = String(cwd || '').trim()

  if (normalizedCwd) {
    options.cwd = normalizedCwd
  }

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
  const baseArgs = [...(session.cwd ? ['-C', session.cwd] : []), 'exec']

  if (session.codexThreadId) {
    return [...baseArgs, 'resume', session.codexThreadId, '-', '--json']
  }

  return [...baseArgs, '-', '--json']
}

function extractCodexError(stderr = '', stdout = '') {
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
  if (event?.type === 'thread.started' && event.thread_id) {
    setThreadId(String(event.thread_id))
  }
}

function parseThreadIdFromStdout(stdout = '') {
  const lines = String(stdout || '')
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)

  for (const line of lines) {
    const event = parseJsonLine(line)
    if (event?.type === 'thread.started' && event.thread_id) {
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

export async function sendPromptToCodexSession(sessionInput, prompt) {
  const session = normalizeManagedSession(sessionInput)
  const normalizedPrompt = String(prompt || '').trim()

  if (!session) {
    throw new Error('缺少 PromptX 会话。')
  }
  if (!normalizedPrompt) {
    throw new Error('没有可发送的提示词。')
  }

  ensureCodexHome()

  const outputFile = path.join(TMP_DIR, `promptx-codex-${Date.now()}-${process.pid}.txt`)

  try {
    const result = await new Promise((resolve, reject) => {
      const child = createCodexSpawn(
        [
          ...createExecArgs(session),
          '--output-last-message',
          outputFile,
        ],
        session.cwd
      )

      let stdout = ''
      let stderr = ''

      child.stdout.on('data', (chunk) => {
        stdout += chunk.toString()
      })

      child.stderr.on('data', (chunk) => {
        stderr += chunk.toString()
      })

      child.on('error', (error) => {
        reject(normalizeSpawnError(error))
      })

      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(repairPossibleMojibake(extractCodexError(stderr, stdout))))
          return
        }

        const message = fs.existsSync(outputFile)
          ? repairPossibleMojibake(fs.readFileSync(outputFile, 'utf8').trim())
          : ''

        resolve({
          message,
          stdout: repairPossibleMojibake(trimOutput(stdout)),
          stderr: repairPossibleMojibake(trimOutput(stderr)),
          threadId: parseThreadIdFromStdout(stdout),
        })
      })

      child.stdin.write(normalizedPrompt)
      child.stdin.end()
    })

    return {
      sessionId: session.id,
      message: result.message,
      rawStdout: result.stdout,
      threadId: result.threadId,
    }
  } finally {
    fs.rmSync(outputFile, { force: true })
  }
}

export function streamPromptToCodexSession(sessionInput, prompt, callbacks = {}) {
  const session = normalizeManagedSession(sessionInput)
  const normalizedPrompt = String(prompt || '').trim()

  if (!session) {
    throw new Error('缺少 PromptX 会话。')
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

  emit({
    type: 'status',
    stage: session.codexThreadId ? 'resuming' : 'starting',
    message: session.codexThreadId
      ? '已连接 PromptX 会话，正在继续这轮执行。'
      : '已创建 PromptX 会话，正在启动第一轮执行。',
  })

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString()
    stdoutRaw += text
    stdoutBuffer += text
    const { lines, rest } = splitBufferedLines(stdoutBuffer)
    stdoutBuffer = rest

    for (const line of lines) {
      const event = parseJsonLine(line)
      if (event) {
        trackThreadId(event, rememberThreadId)
        emit({
          type: 'codex',
          event: sanitizeCodexPayload(event),
        })
        continue
      }

      emit({
        type: 'stdout',
        text: repairPossibleMojibake(line),
      })
    }
  })

  child.stderr.on('data', (chunk) => {
    const text = chunk.toString()
    stderrRaw += text
    stderrBuffer += text
    const { lines, rest } = splitBufferedLines(stderrBuffer)
    stderrBuffer = rest

    for (const line of lines) {
      emit({
        type: 'stderr',
        text: repairPossibleMojibake(line),
      })
    }
  })

  child.stdin.write(normalizedPrompt)
  child.stdin.end()

  const result = new Promise((resolve, reject) => {
    child.on('error', (error) => {
      reject(normalizeSpawnError(error))
    })

    child.on('close', (code) => {
      const stdoutTail = flushBufferedText(stdoutBuffer)
      const stderrTail = flushBufferedText(stderrBuffer)

      stdoutTail.forEach((line) => {
        const event = parseJsonLine(line)
        if (event) {
          trackThreadId(event, rememberThreadId)
          emit({
            type: 'codex',
            event: sanitizeCodexPayload(event),
          })
        } else {
          emit({
            type: 'stdout',
            text: repairPossibleMojibake(line),
          })
        }
      })

      stderrTail.forEach((line) => {
        emit({
          type: 'stderr',
          text: repairPossibleMojibake(line),
        })
      })

      if (fs.existsSync(outputFile)) {
        finalMessage = repairPossibleMojibake(fs.readFileSync(outputFile, 'utf8').trim())
      }

      if (!finalThreadId) {
        finalThreadId = parseThreadIdFromStdout(stdoutRaw)
      }

      if (code !== 0) {
        reject(new Error(repairPossibleMojibake(extractCodexError(stderrRaw, stdoutRaw))))
        return
      }

      emit({
        type: 'completed',
        message: finalMessage,
      })

      resolve({
        sessionId: session.id,
        message: finalMessage,
        threadId: finalThreadId,
      })
    })
  }).finally(() => {
    fs.rmSync(outputFile, { force: true })
  })

  return {
    child,
    result,
    cancel() {
      if (child.killed) {
        return
      }

      if (process.platform === 'win32' && child.pid) {
        try {
          execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            stdio: 'ignore',
          })
          return
        } catch {
          // Fall through to the default child kill when taskkill is unavailable.
        }
      }

      if (!child.killed) {
        child.kill('SIGTERM')
      }
    },
  }
}
