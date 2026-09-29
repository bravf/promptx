import { isRemoteTransport, transportFetch } from './transport.js'

const CHUNK_BYTES = 1024 * 1024
const sources = new Map()
let workerReady = null

export function videoRange(range = '') {
  const match = /^bytes=(\d*)-(\d*)$/.exec(range)
  if (range && (!match || (!match[1] && !match[2]))) throw new Error('视频分段请求无效。')
  if (match && !match[1]) return `bytes=-${Math.min(Number(match[2]), CHUNK_BYTES)}`
  const start = Number(match?.[1] || 0)
  const end = match?.[2] ? Math.min(Number(match[2]), start + CHUNK_BYTES - 1) : start + CHUNK_BYTES - 1
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
  port.onmessage = () => controller.abort()
  try {
    const response = await transportFetch(source.url, {
      headers: { Range: event.data.method === 'HEAD' ? 'bytes=0-0' : videoRange(event.data.range) }, signal: controller.signal,
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
    const body = await response.arrayBuffer()
    if (body.byteLength > CHUNK_BYTES) throw new Error('视频分段大小异常。')
    port.postMessage({ status: response.status, headers: Object.fromEntries(response.headers), body }, [body])
  } catch (error) {
    if (controller.signal.aborted) port.postMessage({ canceled: true })
    else {
      source.onError?.(error)
      port.postMessage({ error: error.message || '视频分段读取失败。' })
    }
  } finally {
    source.requests.delete(controller)
    port.close()
  }
}

async function readyWorker() {
  if (!navigator.serviceWorker) throw new Error('当前浏览器不支持远程视频分段播放，请使用 HTTPS 页面和新版浏览器。')
  if (!workerReady) workerReady = (async () => {
    navigator.serviceWorker.addEventListener('message', serveRange)
    let activationTimer
    try {
      await Promise.race([
        navigator.serviceWorker.register('/media-preview-sw.js', { scope: '/' }).then(() => navigator.serviceWorker.ready),
        new Promise((_, reject) => { activationTimer = setTimeout(() => reject(new Error('视频播放器初始化超时，请重试。')), 15000) }),
      ])
    } finally { clearTimeout(activationTimer) }
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve, reject) => {
        const changed = () => { clearTimeout(timer); navigator.serviceWorker.removeEventListener('controllerchange', changed); resolve() }
        const timer = setTimeout(() => { navigator.serviceWorker.removeEventListener('controllerchange', changed); reject(new Error('视频播放器初始化超时，请重试。')) }, 15000)
        navigator.serviceWorker.addEventListener('controllerchange', changed, { once: true })
        if (navigator.serviceWorker.controller) changed()
      })
    }
    return new Promise((resolve, reject) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => { channel.port1.close(); reject(new Error('视频播放器初始化超时，请重试。')) }, 15000)
      channel.port1.onmessage = event => { clearTimeout(timer); channel.port1.close(); resolve(event.data.clientId) }
      navigator.serviceWorker.controller.postMessage({ type: 'promptx-video-client' }, [channel.port2])
    })
  })().catch(error => { workerReady = null; throw error })
  return workerReady
}

export async function createVideoSource(url, { signal, onError } = {}) {
  // 本机直接使用 HTTP Range，让浏览器按需读取和拖动，不再下载完整 Blob。
  if (!isRemoteTransport()) return { url, release() {} }
  const clientId = await readyWorker()
  signal?.throwIfAborted()
  const token = crypto.randomUUID()
  const source = { url, onError, requests: new Set() }
  sources.set(token, source)
  const release = () => {
    sources.delete(token)
    for (const request of source.requests) request.abort()
    signal?.removeEventListener('abort', release)
  }
  signal?.addEventListener('abort', release, { once: true })
  return { url: `${location.origin}/__promptx_video/${encodeURIComponent(clientId)}/${token}`, release }
}
