import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const daemonEntry = path.join(rootDir, 'apps', 'daemon', 'src', 'index.js')
const runtimeDir = path.join(path.resolve(process.env.PROMPTX_HOME || path.join(os.homedir(), '.promptx')), 'run')
const stateFile = path.join(runtimeDir, 'service-v2.json')
const logFile = path.join(runtimeDir, 'promptx-v2.log')
const host = String(process.env.HOST || '127.0.0.1').trim() || '127.0.0.1'
const port = Math.max(1, Number(process.env.PORT || process.env.PROMPTX_DAEMON_PORT) || 3001)
const baseUrl = `http://${host}:${port}`

function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')) } catch { return null }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

async function healthy() {
  try { return (await fetch(`${baseUrl}/api/v2/health`)).ok } catch { return false }
}

async function start() {
  const state = readState()
  if (alive(state?.pid)) {
    console.log(`[promptx] Daemon 已在运行：${state.baseUrl}（PID ${state.pid}）`)
    return
  }
  if (await healthy()) throw new Error(`${baseUrl} 已有服务在运行。`)
  fs.mkdirSync(runtimeDir, { recursive: true })
  const fd = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, [daemonEntry], {
    cwd: rootDir,
    detached: true,
    stdio: ['ignore', fd, fd],
    env: { ...process.env, HOST: host, PORT: String(port), PROMPTX_DAEMON_PORT: String(port) },
  })
  fs.closeSync(fd)
  child.unref()
  fs.writeFileSync(stateFile, `${JSON.stringify({ pid: child.pid, host, port, baseUrl, startedAt: new Date().toISOString() }, null, 2)}\n`)
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await healthy()) {
      console.log(`[promptx] 已启动：${baseUrl}（PID ${child.pid}）`)
      return
    }
    if (!alive(child.pid)) break
    await delay(250)
  }
  throw new Error(`Daemon 启动失败，请查看 ${logFile}`)
}

async function stop() {
  const state = readState()
  if (!alive(state?.pid)) {
    fs.rmSync(stateFile, { force: true })
    console.log('[promptx] Daemon 未运行。')
    return
  }
  process.kill(state.pid, 'SIGTERM')
  for (let attempt = 0; attempt < 40 && alive(state.pid); attempt += 1) await delay(200)
  if (alive(state.pid)) process.kill(state.pid, 'SIGKILL')
  fs.rmSync(stateFile, { force: true })
  console.log('[promptx] Daemon 已停止。')
}

async function status() {
  const state = readState()
  if (alive(state?.pid)) console.log(`[promptx] 运行中：${state.baseUrl}（PID ${state.pid}）`)
  else console.log('[promptx] 未运行。')
}

const command = process.argv[2] || 'status'
if (command === 'start') await start()
else if (command === 'stop') await stop()
else if (command === 'restart') { await stop(); await start() }
else if (command === 'status') await status()
else throw new Error(`未知命令：${command}`)
