// 详情请求独立限流，避免展开多个工具挤占发送/停止请求。
export function createToolDetailClient({ request, remote = false, maxCacheBytes = 8 * 1024 * 1024 } = {}) {
  const queue = [], cache = new Map()
  let active = 0, bytes = 0
  const limit = remote ? 2 : 4
  const abort = () => new DOMException('请求已取消', 'AbortError')
  function drain() {
    while (active < limit && queue.length) {
      const job = queue.shift()
      if (job.signal?.aborted) { job.reject(abort()); continue }
      job.signal?.removeEventListener('abort', job.cancel)
      active++
      Promise.resolve().then(() => {
        if (job.signal?.aborted) throw abort()
        return request(job.path, { signal: job.signal })
      }).then(job.resolve, job.reject).finally(() => { active--; drain() })
    }
  }
  return {
    delay: remote ? 750 : 200,
    get(key) {
      const hit = cache.get(key)
      if (!hit) return null
      cache.delete(key); cache.set(key, hit)
      return JSON.parse(JSON.stringify(hit.value))
    },
    put(key, value) {
      const serialized = JSON.stringify(value)
      const size = new TextEncoder().encode(serialized).length
      if (cache.has(key)) { bytes -= cache.get(key).bytes; cache.delete(key) }
      if (size > maxCacheBytes) return
      cache.set(key, { value: JSON.parse(serialized), bytes: size }); bytes += size
      while (bytes > maxCacheBytes || cache.size > 32) {
        const oldest = cache.keys().next().value
        bytes -= cache.get(oldest).bytes; cache.delete(oldest)
      }
    },
    fetch(taskId, params, signal) {
      const query = new URLSearchParams({ ...params, transport: remote ? 'relay' : 'local' })
      const path = `/api/v2/tasks/${encodeURIComponent(taskId)}/tool-calls/detail?${query}`
      return new Promise((resolve, reject) => {
        if (signal?.aborted) { reject(abort()); return }
        const job = { path, signal, resolve, reject }
        job.cancel = () => {
          const index = queue.indexOf(job)
          if (index !== -1) queue.splice(index, 1)
          reject(abort())
        }
        signal?.addEventListener('abort', job.cancel, { once: true })
        queue.push(job); drain()
      })
    },
  }
}
