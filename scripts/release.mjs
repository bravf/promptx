import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJsonPath = path.join(rootDir, 'package.json')

function parseArgs(argv = []) {
  const args = {
    mode: 'publish',
    skipGitCheck: false,
    skipBranchCheck: false,
    tag: '',
  }

  const first = String(argv[0] || '').trim()
  if (first === 'check' || first === 'publish') {
    args.mode = first
  }

  for (const value of argv.slice(first === 'check' || first === 'publish' ? 1 : 0)) {
    const arg = String(value || '').trim()
    if (!arg) {
      continue
    }
    if (arg === '--skip-git-check') {
      args.skipGitCheck = true
      continue
    }
    if (arg === '--skip-branch-check') {
      args.skipBranchCheck = true
      continue
    }
    if (arg.startsWith('--tag=')) {
      args.tag = arg.slice('--tag='.length).trim()
    }
  }

  return args
}

function runCommand(command, commandArgs = [], options = {}) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && ['pnpm', 'npm'].includes(String(command || '').toLowerCase())
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      stdio: 'inherit',
      windowsHide: true,
      env: {
        ...process.env,
        ...(options.env || {}),
      },
      shell: useShell,
    })

    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) {
        reject(new Error(`${command} 被信号 ${signal} 中断`))
        return
      }
      if (code !== 0) {
        reject(new Error(`${command} ${commandArgs.join(' ')} 执行失败（退出码 ${code}）`))
        return
      }
      resolve()
    })
  })
}

function execCapture(command, commandArgs = []) {
  return new Promise((resolve, reject) => {
    const useShell = process.platform === 'win32' && ['pnpm', 'npm'].includes(String(command || '').toLowerCase())
    const child = spawn(command, commandArgs, {
      cwd: rootDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      env: process.env,
      shell: useShell,
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk || '')
    })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk || '')
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `${command} 执行失败`).trim()))
        return
      }
      resolve(stdout.trim())
    })
  })
}

async function ensureGitClean() {
  const output = await execCapture('git', ['status', '--porcelain'])
  if (output.trim()) {
    throw new Error('当前工作区不干净，请先提交或暂存改动后再发布。')
  }
}

async function ensureReleaseBranch() {
  const branch = await execCapture('git', ['branch', '--show-current'])
  if (!['main', 'master'].includes(branch.trim())) {
    throw new Error(`当前分支是 ${branch || '(detached)'}，发布前请切到 main/master。`)
  }
}

async function ensureNpmLogin() {
  const whoami = await execCapture('npm', ['whoami']).catch(() => '')
  if (!whoami.trim()) {
    throw new Error('当前 npm 未登录，请先执行 `npm login`。')
  }
  console.log(`[release] npm 当前账号：${whoami.trim()}`)
}

function readPackageMeta() {
  const payload = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
  return {
    name: String(payload.name || '').trim(),
    version: String(payload.version || '').trim(),
  }
}

async function runChecks() {
  const steps = [
    ['pnpm', ['build']],
    ['pnpm', ['--filter', '@promptx/server', 'test']],
    ['node', ['scripts/check-package-runtime-imports.mjs']],
    ['node', ['bin/promptx.js', 'doctor']],
    ['npm', ['pack', '--dry-run']],
  ]

  for (const [command, args] of steps) {
    console.log(`[release] 运行检查：${command} ${args.join(' ')}`)
    await runCommand(command, args)
  }
}

async function publishPackage(tag = '') {
  const publishArgs = ['publish', '--access', 'public']
  if (tag) {
    publishArgs.push('--tag', tag)
  }
  console.log(`[release] 开始发布：npm ${publishArgs.join(' ')}`)
  await runCommand('npm', publishArgs)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const meta = readPackageMeta()

  console.log(`[release] 包：${meta.name}@${meta.version}`)

  if (!args.skipGitCheck) {
    await ensureGitClean()
  } else {
    console.log('[release] 已跳过工作区检查')
  }

  if (args.mode === 'publish' && !args.skipBranchCheck) {
    await ensureReleaseBranch()
  } else if (args.mode === 'publish') {
    console.log('[release] 已跳过分支检查')
  }

  await runChecks()

  if (args.mode === 'check') {
    console.log('[release] 发布前检查通过。')
    return
  }

  await ensureNpmLogin()
  await publishPackage(args.tag)
}

main().catch((error) => {
  console.error(`[release] ${error.message || error}`)
  process.exitCode = 1
})
