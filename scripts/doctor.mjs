import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { resolvePromptxPaths } from '../apps/server/src/appPaths.js'

const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_PORT = 3000
const SUPPORTED_NODE_RANGES = [
  { min: [20, 19, 0], maxExclusiveMajor: 21, label: '20.19+' },
  { min: [22, 13, 0], maxExclusiveMajor: 23, label: '22.13+' },
  { min: [24, 0, 0], maxExclusiveMajor: 25, label: '24.x' },
]
const RECOMMENDED_NODE_MAJOR = 22
const HUMAN_READABLE_NODE_SUPPORT = '推荐 Node 22 LTS，当前兼容 Node 20 / 22 / 24 稳定版本'
const CODEX_BIN = process.env.CODEX_BIN || 'codex'
const CLAUDE_CODE_BIN = process.env.CLAUDE_CODE_BIN || 'claude'
const OPENCODE_BIN = process.env.OPENCODE_BIN || 'opencode'
const KIMI_CODE_BIN = process.env.KIMI_CODE_BIN || 'kimi'
const AGENT_CLI_CONFIGS = [
  {
    key: 'codex',
    name: 'Codex CLI',
    envName: 'CODEX_BIN',
    bin: CODEX_BIN,
    versionArgs: ['--version'],
  },
  {
    key: 'claude-code',
    name: 'Claude Code CLI',
    envName: 'CLAUDE_CODE_BIN',
    bin: CLAUDE_CODE_BIN,
    versionArgs: ['--version'],
  },
  {
    key: 'opencode',
    name: 'OpenCode CLI',
    envName: 'OPENCODE_BIN',
    bin: OPENCODE_BIN,
    versionArgs: ['--version'],
  },
  {
    key: 'kimi-code',
    name: 'Kimi Code CLI',
    envName: 'KIMI_CODE_BIN',
    bin: KIMI_CODE_BIN,
    versionArgs: ['--version'],
  },
]

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const webIndexPath = path.join(rootDir, 'apps', 'web', 'dist', 'index.html')

function compareVersions(left = [], right = []) {
  const maxLength = Math.max(left.length, right.length)
  for (let index = 0; index < maxLength; index += 1) {
    const leftValue = Number(left[index] || 0)
    const rightValue = Number(right[index] || 0)
    if (leftValue > rightValue) {
      return 1
    }
    if (leftValue < rightValue) {
      return -1
    }
  }
  return 0
}

function parseNodeVersion(value = '') {
  return String(value || '')
    .replace(/^v/, '')
    .split('.')
    .map((part) => Number(part) || 0)
}

function resolveCliBinary(bin = '') {
  if (process.platform !== 'win32') {
    return bin
  }

  if (path.extname(bin)) {
    return bin
  }

  if (fs.existsSync(`${bin}.cmd`)) {
    return `${bin}.cmd`
  }

  if (fs.existsSync(`${bin}.bat`)) {
    return `${bin}.bat`
  }

  if (fs.existsSync(bin)) {
    return bin
  }

  try {
    const output = execFileSync('where.exe', [bin], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    }).trim()

    if (!output) {
      return bin
    }

    const candidates = output
      .split(/\r?\n/g)
      .map((line) => line.trim())
      .filter(Boolean)

    return candidates.find((item) => /\.(cmd|bat)$/i.test(item))
      || candidates.find((item) => /\.(exe|com)$/i.test(item))
      || candidates[0]
      || bin
  } catch {
    return bin
  }
}

function execCli(bin = '', args = []) {
  const resolvedBin = resolveCliBinary(bin)
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(resolvedBin)) {
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', resolvedBin, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
  }

  return execFileSync(resolvedBin, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
}

function resolveCodexBinary() {
  return resolveCliBinary(CODEX_BIN)
}

function execCodex(args = []) {
  return execCli(CODEX_BIN, args)
}

function createCheck(name, status, detail) {
  return { name, status, detail }
}

function printCheck(result) {
  const symbol = result.status === 'pass' ? 'OK' : result.status === 'warn' ? 'WARN' : 'FAIL'
  console.log(`[${symbol}] ${result.name}: ${result.detail}`)
}

function checkNodeVersion() {
  const current = parseNodeVersion(process.version)
  const matchedRange = SUPPORTED_NODE_RANGES.find((range) => (
    current[0] < range.maxExclusiveMajor
    && compareVersions(current, range.min) >= 0
  ))

  if (!matchedRange) {
    return createCheck(
      'Node.js',
      'fail',
      `当前 ${process.version}，${HUMAN_READABLE_NODE_SUPPORT}（详细范围：20.19+ / 22.13+ / 24.x）`
    )
  }

  const recommendation = current[0] === RECOMMENDED_NODE_MAJOR ? '，当前就是推荐版本线' : `，推荐 Node ${RECOMMENDED_NODE_MAJOR} LTS`
  return createCheck('Node.js', 'pass', `当前 ${process.version}（可用；${HUMAN_READABLE_NODE_SUPPORT}${recommendation}）`)
}

function checkStorageWritable() {
  try {
    const { promptxHomeDir, dataDir, uploadsDir, tmpDir } = resolvePromptxPaths()
    ;[promptxHomeDir, dataDir, uploadsDir, tmpDir].forEach((targetPath) => {
      fs.mkdirSync(targetPath, { recursive: true })
    })
    const probePath = path.join(tmpDir, `.doctor-${process.pid}-${Date.now()}.tmp`)
    fs.writeFileSync(probePath, 'ok')
    fs.rmSync(probePath, { force: true })
    return createCheck('数据目录', 'pass', `${promptxHomeDir} 可读写`)
  } catch (error) {
    return createCheck('数据目录', 'fail', error.message || '无法写入 ~/.promptx')
  }
}

function checkBuiltAssets() {
  if (!fs.existsSync(webIndexPath)) {
    return createCheck('前端产物', 'fail', '缺少 apps/web/dist/index.html，请先构建或确认发包内容完整')
  }
  return createCheck('前端产物', 'pass', '已包含前端构建产物')
}

function checkAgentCli(config) {
  try {
    const output = execCli(config.bin, config.versionArgs).trim()
    const resolvedBin = resolveCliBinary(config.bin)
    const detail = output ? `${resolvedBin} -> ${output}` : `${resolvedBin} 可执行`
    return createCheck(config.name, 'pass', detail)
  } catch (error) {
    return createCheck(
      config.name,
      'warn',
      `当前不可用。请先确认终端里可以运行 \`${config.bin} --version\`，或设置 \`${config.envName}\`。${error.message ? ` (${error.message})` : ''}`
    )
  }
}

function checkCodexFullModeFlags() {
  try {
    execCodex(['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--help'])
    return createCheck('Codex 满血参数', 'pass', '支持 PromptX 默认的满血参数')
  } catch (error) {
    const detail = String(error?.stderr || error?.stdout || error?.message || '').trim()
    return createCheck(
      'Codex 满血参数',
      'warn',
      detail
        ? `当前 Codex 可能不支持 PromptX 默认启动参数：${detail.split(/\r?\n/)[0]}`
        : '当前 Codex 可能不支持 PromptX 默认启动参数'
    )
  }
}

async function isPortOccupied(host, port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.unref()
    server.once('error', (error) => {
      resolve(error?.code === 'EADDRINUSE')
    })
    server.once('listening', () => {
      server.close(() => resolve(false))
    })
    server.listen(port, host)
  })
}

async function checkServicePort() {
  const host = String(process.env.HOST || DEFAULT_HOST).trim() || DEFAULT_HOST
  const port = Math.max(1, Number(process.env.PORT || process.env.PROMPTX_SERVER_PORT) || DEFAULT_PORT)
  const baseUrl = `http://${host}:${port}`

  try {
    const response = await fetch(`${baseUrl}/health`)
    if (response.ok) {
      return createCheck('服务端口', 'pass', `${baseUrl} 已有 PromptX 服务在运行`)
    }
  } catch {
    // Ignore and continue.
  }

  if (await isPortOccupied(host, port)) {
    return createCheck('服务端口', 'warn', `${baseUrl} 端口已被其他进程占用`)
  }

  return createCheck('服务端口', 'pass', `${baseUrl} 可用`)
}

async function main() {
  const agentCliChecks = AGENT_CLI_CONFIGS.map(checkAgentCli)
  const availableAgentCliChecks = agentCliChecks.filter((item) => item.status === 'pass')
  const agentSummaryCheck = availableAgentCliChecks.length > 0
    ? createCheck(
        '执行引擎',
        'pass',
        `已检测到 ${availableAgentCliChecks.map((item) => item.name.replace(/ CLI$/, '')).join(' / ')}`
      )
    : createCheck(
        '执行引擎',
        'fail',
        '至少需要安装一个可用执行引擎：Codex / Claude Code / OpenCode'
      )
  const checks = [
    checkNodeVersion(),
    checkStorageWritable(),
    checkBuiltAssets(),
    agentSummaryCheck,
    ...agentCliChecks,
    availableAgentCliChecks.some((item) => item.name === 'Codex CLI')
      ? checkCodexFullModeFlags()
      : createCheck('Codex 满血参数', 'warn', '已跳过，因为 Codex CLI 当前不可用'),
    await checkServicePort(),
  ]

  console.log('PromptX Doctor')
  console.log('')
  checks.forEach(printCheck)

  const failCount = checks.filter((item) => item.status === 'fail').length
  const warnCount = checks.filter((item) => item.status === 'warn').length

  console.log('')
  console.log(`[promptx] 检查完成：${checks.length - failCount - warnCount} 通过，${warnCount} 警告，${failCount} 失败`)

  if (failCount > 0) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`[promptx] Doctor 执行失败：${error.message || error}`)
  process.exitCode = 1
})
