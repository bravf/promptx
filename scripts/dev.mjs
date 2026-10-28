import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { waitForDaemon } from './lib/devReadiness.mjs'

const DEFAULT_WEB_PORT = 4002
const DEFAULT_HOST = '127.0.0.1'

function resolvePnpmCommand() {
  if (process.platform !== 'win32') return 'pnpm'
  try {
    return execFileSync('where.exe', ['pnpm'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim().split(/\r?\n/).find((item) => /\.(cmd|bat|exe)$/i.test(item)) || 'pnpm'
  } catch {
    return 'pnpm'
  }
}

function spawnChild(command, args, env) {
  const useShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path.basename(command))
  return spawn(useShell ? (process.env.ComSpec || 'cmd.exe') : command, useShell ? ['/d', '/s', '/c', command, ...args] : args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, ...env },
    shell: false,
  })
}

async function canListen(host, port) {
  const server = net.createServer()
  return new Promise((resolve) => {
    server.once('error', () => resolve(false))
    server.listen(port, host, () => server.close(() => resolve(true)))
  })
}

async function findAvailablePort(host, preferredPort) {
  if (await canListen(host, preferredPort)) return preferredPort
  throw new Error(`开发入口端口 ${preferredPort} 已被占用，请停止占用实例后重试。`)
}
async function internalPort(host) {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, host, resolve) })
  const port = server.address().port
  await new Promise(resolve => server.close(resolve))
  return port
}

const host = String(process.env.PROMPTX_DEV_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
const daemonPort = Number(process.env.PROMPTX_DEV_DAEMON_PORT) || await internalPort(host)
const preferredWebPort = Math.max(1, Number(process.env.WEB_PORT || process.env.PROMPTX_WEB_PORT) || DEFAULT_WEB_PORT)
const webPort = await findAvailablePort(host, preferredWebPort)
const pnpm = resolvePnpmCommand()
const webOrigin = `http://${host}:${webPort}`
const allowedOrigins = [process.env.PROMPTX_ALLOWED_ORIGINS, webOrigin].filter(Boolean).join(',')

console.log(`[promptx-dev] Daemon: http://${host}:${daemonPort}`)
console.log('[promptx-dev] 正在等待 Daemon 就绪…')
console.log('[promptx-dev] 按 Ctrl+C 可同时停止服务。')

const daemon = spawnChild(pnpm, ['--filter', '@promptx/daemon', 'dev'], {
  PROMPTX_DAEMON_HOST: host,
  PROMPTX_DAEMON_PORT: String(daemonPort),
  PROMPTX_ALLOWED_ORIGINS: allowedOrigins,
  PROMPTX_DEV_MODE: '1',
})
const children = [daemon]
const startup = new AbortController()
let stopping = false

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  startup.abort(new Error('开发服务已停止。'))
  for (const child of children) if (!child.killed) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 100).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
function observeChild(label, child) {
  child.on('error', (error) => {
    if (stopping) return
    console.error(`[promptx-dev] ${label} 启动失败：`, error)
    shutdown(1)
  })
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.error(`[promptx-dev] ${label} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })
}
observeChild('Daemon', daemon)

try {
  await waitForDaemon(`http://${host}:${daemonPort}`, { signal: startup.signal })
  if (!stopping) {
    console.log(`[promptx-dev] Daemon 已就绪，Web: http://${host}:${webPort}`)
    const web = spawnChild(pnpm, ['--filter', '@promptx/web', 'exec', 'vite', '--host', host, '--port', String(webPort), '--strictPort'], {
      PROMPTX_DEV_API_TARGET: `http://${host}:${daemonPort}`,
      VITE_API_PORT: '',
      VITE_API_BASE_URL: '',
      PROMPTX_WEB_PORT: String(webPort),
    })
    children.push(web)
    observeChild('Web', web)
  }
} catch (error) {
  if (!stopping) {
    console.error(`[promptx-dev] ${error.message}`)
    shutdown(1)
  }
}
