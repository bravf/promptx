import { setTimeout as delay } from 'node:timers/promises'

export async function waitForDaemon(origin, { timeoutMs = 30000, intervalMs = 100, signal } = {}) {
  const deadline = AbortSignal.timeout(timeoutMs)
  const waiting = signal ? AbortSignal.any([signal, deadline]) : deadline
  try {
    while (true) {
      waiting.throwIfAborted()
      try {
        const response = await fetch(`${origin}/api/v2/health`, {
          signal: AbortSignal.any([waiting, AbortSignal.timeout(1000)]),
        })
        if (response.ok && (await response.json()).ok === true) return
        await response.body?.cancel()
      } catch {
        waiting.throwIfAborted()
      }
      await delay(intervalMs, undefined, { signal: waiting })
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason
    throw new Error(`Daemon 在 ${timeoutMs / 1000} 秒内未就绪，请检查上方后端启动日志（${origin}）。`, { cause: error })
  }
}
