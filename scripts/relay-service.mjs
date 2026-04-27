import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

import { resolvePromptxPaths } from '../apps/server/src/appPaths.js'
import { formatLocalLogDate } from '../packages/shared/src/dailyLogStream.js'

const DEFAULT_RELAY_PORT = 3030
const DEFAULT_RELAY_HOST = '127.0.0.1'
const STARTUP_TIMEOUT_MS = 15_000
const STOP_TIMEOUT_MS = 8_000
const POLL_INTERVAL_MS = 250

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const relayEntryPath = path.join(rootDir, 'scripts', 'relay.mjs')
const webDistDir = path.join(rootDir, 'apps', 'web', 'dist')
const webIndexPath = path.join(webDistDir, 'index.html')

function ensureRuntimeDir() {
  const { promptxHomeDir } = resolvePromptxPaths()
  const runtimeDir = path.join(promptxHomeDir, 'run')
  fs.mkdirSync(runtimeDir, { recursive: true })
  return runtimeDir
}

function getRuntimePaths() {
  const runtimeDir = ensureRuntimeDir()
  const logDir = path.join(runtimeDir, 'logs')
  fs.mkdirSync(logDir, { recursive: true })
  const logDate = formatLocalLogDate()
  return {
    runtimeDir,
    logDir,
    pidFile: path.join(runtimeDir, 'relay.pid'),
    stateFile: path.join(runtimeDir, 'relay.json'),
    logFile: path.join(logDir, `relay-${logDate}.log`),
  }
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'))
  } catch {
    return null
  }
}

function readPid(filePath) {
  try {
    const value = fs.readFileSync(filePath, 'utf8').trim()
    const pid = Number(value)
    return Number.isInteger(pid) && pid > 0 ? pid : 0
  } catch {
    return 0
  }
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function removeRuntimeFiles() {
  const { pidFile, stateFile } = getRuntimePaths()
  fs.rmSync(pidFile, { force: true })
  fs.rmSync(stateFile, { force: true })
}

function getRelayState() {
  const { pidFile, stateFile, logFile } = getRuntimePaths()
  const pid = readPid(pidFile)
  const state = readJsonFile(stateFile) || {}

  if (!isProcessAlive(pid)) {
    removeRuntimeFiles()
    return {
      running: false,
      pid: 0,
      state: null,
      logFile,
    }
  }

  return {
    running: true,
    pid,
    state,
    logFile,
  }
}

function getBaseUrl(host, port) {
  return `http://${host}:${port}`
}

async function checkHealth(baseUrl) {
  try {
    const response = await fetch(`${baseUrl}/health`)
    return response.ok
  } catch {
    return false
  }
}

async function waitForHealth(baseUrl, pid) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      throw new Error('Relay 进程启动后很快退出。')
    }

    if (await checkHealth(baseUrl)) {
      return
    }

    await delay(POLL_INTERVAL_MS)
  }

  throw new Error('等待 Relay 启动超时。')
}

function tailLog(filePath, maxLines = 30) {
  try {
    const lines = fs.readFileSync(filePath, 'utf8').trim().split(/\r?\n/)
    return lines.slice(-maxLines).join('\n').trim()
  } catch {
    return ''
  }
}

async function startRelayService() {
  if (!fs.existsSync(webIndexPath)) {
    throw new Error('没有找到前端构建产物，请先运行 `pnpm build`。')
  }

  const existing = getRelayState()
  if (existing.running) {
    const host = String(existing.state?.host || DEFAULT_RELAY_HOST)
    const port = Number(existing.state?.port || DEFAULT_RELAY_PORT)
    console.log(`[promptx-relay] 已在运行：${getBaseUrl(host, port)}（PID ${existing.pid}）`)
    return
  }

  const { pidFile, stateFile, logFile } = getRuntimePaths()
  const host = String(process.env.PROMPTX_RELAY_HOST || process.env.HOST || DEFAULT_RELAY_HOST).trim() || DEFAULT_RELAY_HOST
  const port = Math.max(1, Number(process.env.PROMPTX_RELAY_PORT || process.env.PORT) || DEFAULT_RELAY_PORT)
  const baseUrl = getBaseUrl(host, port)
  const startedAt = new Date().toISOString()

  if (await checkHealth(baseUrl)) {
    throw new Error(`检测到 ${baseUrl} 已有 Relay 在运行，请先释放端口或改用其他端口。`)
  }

  const logFd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [relayEntryPath], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    windowsHide: true,
    env: {
      ...process.env,
      PROMPTX_RELAY_HOST: host,
      PROMPTX_RELAY_PORT: String(port),
      PROMPTX_LOG_DIR: logDir,
      PROMPTX_LOG_NAME: 'relay',
    },
  })

  fs.closeSync(logFd)
  child.unref()

  fs.writeFileSync(pidFile, `${child.pid}\n`, 'utf8')
  fs.writeFileSync(stateFile, JSON.stringify({
    pid: child.pid,
    host,
    port,
    startedAt,
    logFile,
  }, null, 2))

  try {
    await waitForHealth(baseUrl, child.pid)
    await delay(300)
    if (!isProcessAlive(child.pid)) {
      throw new Error(`Relay 进程已退出，通常是端口 ${port} 被占用或启动参数冲突。`)
    }
  } catch (error) {
    if (isProcessAlive(child.pid)) {
      try {
        process.kill(child.pid, 'SIGTERM')
      } catch {
        // Ignore shutdown failure.
      }
    }

    removeRuntimeFiles()
    const recentLog = tailLog(logFile)
    throw new Error([
      error.message || 'Relay 启动失败。',
      recentLog ? `最近日志：\n${recentLog}` : '',
    ].filter(Boolean).join('\n\n'))
  }

  console.log(`[promptx-relay] 已后台启动：${baseUrl}`)
  console.log(`[promptx-relay] 日志文件：${logFile}`)
}

async function stopRelayService() {
  const current = getRelayState()
  if (!current.running) {
    console.log('[promptx-relay] 当前没有运行中的 Relay。')
    return
  }

  const pid = current.pid

  try {
    process.kill(pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') {
      throw error
    }
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      removeRuntimeFiles()
      console.log(`[promptx-relay] 已停止 Relay（PID ${pid}）。`)
      return
    }
    await delay(POLL_INTERVAL_MS)
  }

  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // Ignore when process already exited.
  }

  removeRuntimeFiles()
  console.log(`[promptx-relay] 已强制停止 Relay（PID ${pid}）。`)
}

async function restartRelayService() {
  await stopRelayService()
  await startRelayService()
}

function printRelayStatus() {
  const current = getRelayState()
  if (!current.running) {
    console.log('[promptx-relay] Relay 未运行。')
    return
  }

  const host = String(current.state?.host || DEFAULT_RELAY_HOST)
  const port = Number(current.state?.port || DEFAULT_RELAY_PORT)
  const startedAt = current.state?.startedAt || ''
  console.log(`[promptx-relay] 运行中：${getBaseUrl(host, port)}`)
  console.log(`[promptx-relay] PID：${current.pid}`)
  if (startedAt) {
    console.log(`[promptx-relay] 启动时间：${startedAt}`)
  }
  console.log(`[promptx-relay] 日志文件：${current.logFile}`)
}

async function main() {
  const command = String(process.argv[2] || 'status').trim()

  if (command === 'start') {
    await startRelayService()
    return
  }

  if (command === 'stop') {
    await stopRelayService()
    return
  }

  if (command === 'status') {
    printRelayStatus()
    return
  }

  if (command === 'restart') {
    await restartRelayService()
    return
  }

  throw new Error(`不支持的命令：${command}`)
}

main().catch((error) => {
  console.error(`[promptx-relay] ${error.message || error}`)
  process.exitCode = 1
})
