import { open } from 'node:fs/promises'
import { normalizeContextUsage } from '../../controlState.js'

// 从尾部按块读取，避免为一条用量记录加载整个长会话或巨型工具输出。
export async function readCodexContextUsage(file, knownRevision = '') {
  let handle
  try {
    handle = await open(file, 'r')
    const stat = await handle.stat()
    const revision = `${stat.size}:${stat.mtimeMs}`
    if (revision === knownRevision) return { revision }
    let position = stat.size
    let suffix = Buffer.alloc(0)
    let skipPartialLine = false
    while (position > 0) {
      const length = Math.min(position, 64 * 1024)
      position -= length
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, position)
      if (bytesRead !== length) return {}
      const chunk = Buffer.concat([buffer, suffix])
      let end = chunk.length
      for (let index = chunk.length - 1; index >= 0; index -= 1) {
        if (chunk[index] !== 10) continue
        if (!skipPartialLine) {
          const usage = parseUsage(chunk.subarray(index + 1, end))
          if (usage) return { revision, usage }
        }
        skipPartialLine = false
        end = index
      }
      // 超长行不可能是 token_count；跨块丢弃它，保持内存有界。
      if (end > 1024 * 1024 || skipPartialLine) {
        suffix = Buffer.alloc(0)
        skipPartialLine = true
      } else suffix = chunk.subarray(0, end)
    }
    return { revision, usage: skipPartialLine ? null : parseUsage(suffix) }
  } catch {
    // 文件已移走或尚未落盘时保留已有用量，不影响会话读取。
    return {}
  } finally { await handle?.close() }
}

function parseUsage(line) {
  try {
    const record = JSON.parse(line.toString('utf8'))
    if (record.type !== 'event_msg' || record.payload?.type !== 'token_count') return null
    const info = record.payload.info
    const used = info?.last_token_usage?.total_tokens
    const max = info?.model_context_window
    if (!Number.isFinite(used) || used < 0 || !Number.isFinite(max) || max <= 0) return null
    const usage = normalizeContextUsage(used, max)
    const timestamp = Date.parse(record.timestamp)
    if (!Number.isFinite(timestamp)) return null
    return { ...usage, updatedAt: new Date(timestamp).toISOString() }
  } catch { return null }
}
