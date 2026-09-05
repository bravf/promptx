import { execFileSync, spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'

const DEFAULT_DAEMON_PORT = 3001
const DEFAULT_WEB_PORT = 5174
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
  for (let port = preferredPort; port < preferredPort + 100; port += 1) {
    if (await canListen(host, port)) return port
  }
  throw new Error(`找不到可用的 Web 端口（${preferredPort}-${preferredPort + 99}）。`)
}

const host = String(process.env.HOST || process.env.PROMPTX_DEV_HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
const daemonPort = Math.max(1, Number(process.env.PORT || process.env.PROMPTX_DAEMON_PORT) || DEFAULT_DAEMON_PORT)
const preferredWebPort = Math.max(1, Number(process.env.WEB_PORT || process.env.PROMPTX_WEB_PORT) || DEFAULT_WEB_PORT)
const webPort = await findAvailablePort(host, preferredWebPort)
const pnpm = resolvePnpmCommand()
const webOrigin = `http://${host}:${webPort}`
const allowedOrigins = [process.env.PROMPTX_ALLOWED_ORIGINS, webOrigin].filter(Boolean).join(',')

console.log(`[promptx-dev] Web:   http://${host}:${webPort}`)
console.log(`[promptx-dev] Daemon: http://${host}:${daemonPort}`)
console.log('[promptx-dev] 按 Ctrl+C 可同时停止服务。')

const daemon = spawnChild(pnpm, ['--filter', '@promptx/daemon', 'dev'], {
  HOST: host,
  PORT: String(daemonPort),
  PROMPTX_DAEMON_PORT: String(daemonPort),
  PROMPTX_ALLOWED_ORIGINS: allowedOrigins,
})
const web = spawnChild(pnpm, ['--filter', '@promptx/web', 'exec', 'vite', '--host', host, '--port', String(webPort), '--strictPort'], {
  VITE_API_PORT: String(daemonPort),
  PROMPTX_WEB_PORT: String(webPort),
})
const children = [daemon, web]
let stopping = false

function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const child of children) if (!child.killed) child.kill('SIGTERM')
  setTimeout(() => process.exit(code), 100).unref()
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))
for (const [label, child] of [['Daemon', daemon], ['Web', web]]) {
  child.on('exit', (code, signal) => {
    if (stopping) return
    console.error(`[promptx-dev] ${label} 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })
}
