import { execFileSync } from 'node:child_process'

// Daemon 的监听配置不能污染 Agent 启动的开发服务。
export function childEnvironment(overrides = {}) {
  const env = { ...process.env, ...overrides }
  delete env.HOST
  delete env.PORT
  return env
}

export async function withTimeout(operation, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error(`${label}超时，请重试。`), { code: 'operation_timeout' })), timeoutMs)
      }),
    ])
  } finally { clearTimeout(timer) }
}

export function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode) return
  const send = signal => {
    try {
      if (child.promptxProcessGroup && child.pid) process.kill(-child.pid, signal)
      else child.kill(signal)
    } catch {
      // 进程组可能已退出，或当前平台不允许发组信号；回退到本进程。
      try { child.kill(signal) } catch {}
    }
  }
  send('SIGTERM')
  const timer = setTimeout(() => {
    if (child.promptxProcessGroup || (child.exitCode === null && !child.signalCode)) send('SIGKILL')
  }, 2_000)
  timer.unref?.()
  if (!child.promptxProcessGroup) child.once('exit', () => clearTimeout(timer))
}

export function processGroupIdentity(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return ''
  try { return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim() }
  catch { return '' }
}

export function isProcessGroupAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || process.platform === 'win32') return false
  try { process.kill(-pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

export function isSameLiveProcessGroup(pid, identity) {
  if (!identity || !isProcessGroupAlive(pid)) return false
  return processGroupIdentity(pid) === identity
}
