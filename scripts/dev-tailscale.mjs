import { spawn, execFileSync } from 'node:child_process'
import process from 'node:process'
import path from 'node:path'

const DEFAULT_DAEMON_PORT = 3001
const DEFAULT_WEB_PORT = 5174

function resolvePnpmCommand() {
  if (process.platform !== 'win32') {
    return 'pnpm'
  }

  try {
    const output = execFileSync('where.exe', ['pnpm'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return 'pnpm'
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || 'pnpm'
  } catch {
    return 'pnpm'
  }
}

function parseArgs(argv = []) {
  const args = {
    auto: false,
    help: false,
    ip: '',
  }

  for (let index = 0; index < argv.length; index += 1) {
    const value = String(argv[index] || '').trim()
    if (!value) {
      continue
    }

    if (value === '--auto') {
      args.auto = true
      continue
    }

    if (value === '--help' || value === '-h') {
      args.help = true
      continue
    }

    if (value === '--ip') {
      args.ip = String(argv[index + 1] || '').trim()
      index += 1
      continue
    }

    if (value.startsWith('--ip=')) {
      args.ip = value.slice('--ip='.length).trim()
    }
  }

  return args
}

function isValidIpv4(value = '') {
  const parts = String(value || '')
    .trim()
    .split('.')

  if (parts.length !== 4) {
    return false
  }

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) {
      return false
    }

    const numeric = Number(part)
    return numeric >= 0 && numeric <= 255
  })
}

function printHelp() {
  console.log(`
PromptX Tailscale 开发启动脚本

用法：
  pnpm dev:tailscale -- --ip 100.x.x.x
  TAILSCALE_IP=100.x.x.x pnpm dev:tailscale
  pnpm dev:tailscale:auto

可选参数：
  --ip <ip>     手动指定 Tailscale IPv4
  --auto        自动执行 tailscale ip -4 获取地址
  -h, --help    显示帮助

可选环境变量：
  TAILSCALE_IP          Tailscale IPv4
  PROMPTX_DAEMON_PORT   Daemon 端口，默认 3001
  PROMPTX_WEB_PORT      前端端口，默认 5174
`.trim())
}

function detectTailscaleIp() {
  const output = execFileSync('tailscale', ['ip', '-4'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })

  const candidates = String(output || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)

  return candidates.find((value) => value.startsWith('100.')) || candidates[0] || ''
}

function resolveTailscaleIp(args) {
  const explicitIp = String(args.ip || process.env.TAILSCALE_IP || '').trim()
  if (explicitIp) {
    return explicitIp
  }

  if (!args.auto) {
    return ''
  }

  try {
    return detectTailscaleIp()
  } catch (error) {
    throw new Error(
      `自动获取 Tailscale IP 失败：${error.message || '请确认本机已安装并登录 Tailscale。'}`
    )
  }
}

function spawnChild(command, childArgs, options = {}) {
  const isWindowsShellScript = process.platform === 'win32' && /\.(cmd|bat)$/i.test(path.basename(command))
  const spawnCommand = isWindowsShellScript ? (process.env.ComSpec || 'cmd.exe') : command
  const spawnArgs = isWindowsShellScript ? ['/d', '/s', '/c', command, ...childArgs] : childArgs

  return spawn(spawnCommand, spawnArgs, {
    cwd: process.cwd(),
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      ...(options.env || {}),
    },
    shell: false,
  })
}

function killChild(child) {
  if (!child || child.killed) {
    return
  }

  if (process.platform === 'win32') {
    child.kill()
    return
  }

  child.kill('SIGTERM')
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  if (args.help) {
    printHelp()
    return
  }

  const tailscaleIp = resolveTailscaleIp(args)

  if (!tailscaleIp) {
    throw new Error(
      '缺少 Tailscale IP。请使用 `TAILSCALE_IP=100.x.x.x pnpm dev:tailscale`，或直接运行 `pnpm dev:tailscale:auto`。'
    )
  }

  if (!isValidIpv4(tailscaleIp)) {
    throw new Error(`Tailscale IP 不合法：${tailscaleIp}`)
  }

  const daemonPort = Math.max(1, Number(process.env.PORT || process.env.PROMPTX_DAEMON_PORT) || DEFAULT_DAEMON_PORT)
  const webPort = Math.max(1, Number(process.env.WEB_PORT || process.env.PROMPTX_WEB_PORT) || DEFAULT_WEB_PORT)
  const pnpmCommand = resolvePnpmCommand()

  console.log(`[promptx] Tailscale IP: ${tailscaleIp}`)
  console.log(`[promptx] Web:    http://${tailscaleIp}:${webPort}`)
  console.log(`[promptx] Daemon: http://${tailscaleIp}:${daemonPort}`)
  console.log('[promptx] 按 Ctrl+C 可同时停止前后端。')

  const daemonProcess = spawnChild(
    pnpmCommand,
    ['--filter', '@promptx/daemon', 'dev'],
    {
      env: {
        HOST: tailscaleIp,
        PORT: String(daemonPort),
        PROMPTX_DAEMON_PORT: String(daemonPort),
        PROMPTX_ALLOWED_ORIGINS: `http://${tailscaleIp}:${webPort}`,
      },
    }
  )

  const webProcess = spawnChild(
    pnpmCommand,
    ['--filter', '@promptx/web', 'exec', 'vite', '--host', tailscaleIp, '--port', String(webPort)],
    {
      env: {
        VITE_API_PORT: String(daemonPort),
        PROMPTX_WEB_ALLOWED_HOSTS: tailscaleIp,
      },
    }
  )

  const children = [daemonProcess, webProcess]
  let shuttingDown = false

  const shutdown = (code = 0) => {
    if (shuttingDown) {
      return
    }

    shuttingDown = true
    children.forEach(killChild)
    setTimeout(() => {
      process.exit(code)
    }, 100)
  }

  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))

  daemonProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return
    }
    console.error(`[promptx] Daemon 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })

  webProcess.on('exit', (code, signal) => {
    if (shuttingDown) {
      return
    }
    console.error(`[promptx] 前端已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(Number(code) || 1)
  })
}

main().catch((error) => {
  console.error(`[promptx] ${error.message || error}`)
  process.exitCode = 1
})
