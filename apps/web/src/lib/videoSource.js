import { isRemoteTransport, transportFetch } from './transport.js'

const CHUNK_BYTES = 1024 * 1024
const sources = new Map()
let workerReady = null

export function videoRange(range = '', chunkBytes = CHUNK_BYTES) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (range && (!match || (!match[1] && !match[2]))) throw new Error('视频分段请求无效。')
  if (match && !match[1]) return `bytes=-${Math.min(Number(match[2]), chunkBytes)}`
  const start = Number(match?.[1] || 0)
  const end = match?.[2] ? Math.min(Number(match[2]), start + chunkBytes - 1) : start + chunkBytes - 1
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error('视频分段请求无效。')
  return `bytes=${start}-${end}`
}

async function serveRange(event) {
  if (event.data?.type !== 'promptx-video-range' || !event.ports[0]) return
  const port = event.ports[0]
  const source = sources.get(event.data.token)
  if (!source) { port.postMessage({ canceled: true }); port.close(); return }
  const controller = new AbortController()
  source.requests.add(controller)
  let reader = null, pullPending = false
  const abort = () => { controller.abort(); void reader?.cancel().catch(() => {}) }
  port.onmessage = async ({ data }) => {
    if (data.cancel) { abort(); return }
    if (!data.pull || !reader || pullPending) return
    pullPending = true
    try {
      const { value, done } = await reader.read()
      if (controller.signal.aborted) return
      if (done) port.postMessage({ done: true })
      else {
        const body = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)
        port.postMessage({ chunk: body }, [body])
      }
      if (done) cleanup()
    } catch (error) { reportError(error); cleanup() }
    finally { pullPending = false }
  }
  const cleanup = () => { source.requests.delete(controller); port.close() }
  const reportError = error => {
    if (controller.signal.aborted) port.postMessage({ canceled: true })
    else { source.onError?.(error); port.postMessage({ error: error.message || '视频分段读取失败。' }) }
  }
  let streaming = false
  controller.signal.addEventListener('abort', () => {
    if (!streaming) return
    port.postMessage({ canceled: true })
    void reader?.cancel().catch(() => {})
    cleanup()
  }, { once: true })
  try {
    // 起播、seek 先取小段；连续播放再扩大窗口，最多 1 MiB。
    const start = Number(/^bytes=(\d+)-/.exec(event.data.range || '')?.[1] || 0)
    const sequential = start === source.nextOffset
    const chunkBytes = sequential ? source.chunkBytes : 256 * 1024
    const response = await transportFetch(source.url, {
      headers: { Range: event.data.method === 'HEAD' ? 'bytes=0-0' : videoRange(event.data.range, chunkBytes) }, signal: controller.signal,
    })
    if (response.status !== 206 && response.status !== 416) {
      await response.body?.cancel()
      throw new Error('视频分段读取失败，请更新本机 PromptX 后重试。')
    }
    if (event.data.method === 'HEAD' && response.status === 206) {
      const headers = Object.fromEntries(response.headers)
      headers['content-length'] = headers['content-range'].split('/')[1]
      delete headers['content-range']
      await response.body.cancel()
      port.postMessage({ status: 200, headers, body: new ArrayBuffer(0) })
      return
    }
    const headers = Object.fromEntries(response.headers)
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(headers['content-range'] || '')
    if (range && event.data.method !== 'HEAD') {
      source.nextOffset = Number(range[2]) + 1
      source.chunkBytes = Math.min(chunkBytes * 2, CHUNK_BYTES)
      headers['content-length'] = String(Number(range[2]) - Number(range[1]) + 1)
    }
    if (event.data.stream && response.status === 206 && response.body) {
      reader = response.body.getReader()
      streaming = true
      port.postMessage({ start: true, status: response.status, headers })
      return
    }
    const body = await response.arrayBuffer()
    if (body.byteLength > CHUNK_BYTES) throw new Error('视频分段大小异常。')
    port.postMessage({ status: response.status, headers: Object.fromEntries(response.headers), body }, [body])
  } catch (error) {
    reportError(error)
  } finally {
    if (!streaming) cleanup()
  }
}

async function readyWorker() {
  if (!navigator.serviceWorker) throw new Error('当前浏览器不支持远程视频分段播放，请使用 HTTPS 页面和新版浏览器。')
  if (!workerReady) workerReady = (async () => {
    navigator.serviceWorker.addEventListener('message', serveRange)
    let activationTimer
    try {
      const scriptUrl = new URL('/media-preview-sw.js', location.origin).href
      const current = await navigator.serviceWorker.getRegistration('/')
      // 已激活的播放器可立即复用，更新检查不阻塞本次播放。
      let registration
      if (current?.active?.scriptURL === scriptUrl) {
        void current.update().catch(() => {})
        registration = Promise.resolve(current)
      } else registration = navigator.serviceWorker.register('/media-preview-sw.js', { scope: '/' })
      await Promise.race([
        registration.then(() => navigator.serviceWorker.ready),
        new Promise((_, reject) => { activationTimer = setTimeout(() => reject(new Error('视频播放器注册超时，请重试。')), 45000) }),
      ])
    } finally { clearTimeout(activationTimer) }
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve() }
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('视频播放器接管页面超时，请重试。')) }, 15000)
        navigator.serviceWorker.addEventListener('controllerchange', changed, { once: true })
        if (navigator.serviceWorker.controller) changed()
      })
    }
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('视频播放器通信超时，请重试。')) }, 15000)
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data.clientId) }
      navigator.serviceWorker.controller.postMessage({ type: 'promptx-video-client' }, [channel.port2])
    })
  })().catch(error => { workerReady = null; throw error })
  return workerReady
}

export function warmVideoWorker() {
  if (isRemoteTransport() && navigator.serviceWorker) void readyWorker().catch(() => {})
}

export async function createVideoSource(url, { signal, onError } = {}) {
  // 本机直接使用 HTTP Range，让浏览器按需读取和拖动，不再下载完整 Blob。
  if (!isRemoteTransport()) return { url, release() {} }
  const clientId = await readyWorker()
  signal?.throwIfAborted()
  const token = crypto.randomUUID()
  const source = { url, onError, requests: new Set(), nextOffset: -1, chunkBytes: 256 * 1024 }
  sources.set(token, source)
  const release = () => {
    sources.delete(token)
    for (const request of source.requests) request.abort()
    signal?.removeEventListener('abort', release)
  }
  signal?.addEventListener('abort', release, { once: true })
  return { url: `${location.origin}/__promptx_video/${encodeURIComponent(clientId)}/${token}`, release }
}
