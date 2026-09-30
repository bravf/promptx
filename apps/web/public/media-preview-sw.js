// 仅桥接视频分段请求。解密仍在页面中完成，不缓存视频、配对信息或业务响应。
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('message', event => {
  if (event.data?.type === 'promptx-video-client') event.ports[0]?.postMessage({ clientId: event.source.id })
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__promptx_video/')) return
  let finishLifetime
  event.waitUntil(new Promise(resolve => { finishLifetime = resolve }))
  event.respondWith(readVideo(event.request, url, finishLifetime).catch(error => { finishLifetime(); throw error }))
})

async function readVideo(request, url, finishLifetime) {
  const [, , clientId, token] = url.pathname.split('/')
  const client = clientId && await self.clients.get(decodeURIComponent(clientId))
  if (!client || !token || !['GET', 'HEAD'].includes(request.method)) { finishLifetime(); return new Response(null, { status: 404 }) }
  return new Promise(resolve => {
    const channel = new MessageChannel()
    let settled = false, completed = false, controller = null, waitingPull = null, timer
    const cleanup = () => {
      completed = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      channel.port1.close()
      waitingPull?.()
      waitingPull = null
      finishLifetime()
    }
    const finish = response => {
      if (settled) return
      settled = true
      cleanup()
      resolve(response)
    }
    const cancel = () => {
      if (completed) return
      channel.port1.postMessage({ cancel: true })
      if (settled) { controller?.error(new Error('视频分段读取已取消或超时。')); cleanup() }
      else finish(new Response(null, { status: request.signal.aborted ? 204 : 504 }))
    }
    const touch = () => {
      clearTimeout(timer)
      timer = setTimeout(cancel, 45000)
    }
    touch()
    request.signal.addEventListener('abort', cancel, { once: true })
    channel.port1.onmessage = ({ data }) => {
      if (completed) return
      if (data.canceled || data.error) {
        if (settled) { controller?.error(new Error(data.error || '视频读取已取消。')); cleanup() }
        else finish(new Response(data.error || null, { status: data.error ? 502 : 204 }))
        return
      }
      if (data.chunk) {
        clearTimeout(timer)
        controller.enqueue(new Uint8Array(data.chunk))
        waitingPull?.()
        waitingPull = null
        return
      }
      if (data.done) { controller.close(); cleanup(); return }
      const headers = new Headers(data.headers)
      headers.delete('content-encoding')
      headers.set('cache-control', 'no-store')
      if (data.start) {
        settled = true
        clearTimeout(timer)
        const stream = new ReadableStream({
          start(value) { controller = value },
          pull() {
            if (completed) return
            touch()
            return new Promise(resolve => { waitingPull = resolve; channel.port1.postMessage({ pull: true }) })
          },
          cancel() { channel.port1.postMessage({ cancel: true }); cleanup() },
        }, { highWaterMark: 0 })
        resolve(new Response(stream, { status: data.status, headers }))
        return
      }
      // 兼容更新前仍打开的页面，其返回完整分段。
      if (request.method !== 'HEAD') headers.set('content-length', String(data.body.byteLength))
      finish(new Response(request.method === 'HEAD' ? null : data.body, { status: data.status, headers }))
    }
    if (request.signal.aborted) { cancel(); return }
    client.postMessage({ type: 'promptx-video-range', stream: true, token, method: request.method, range: request.headers.get('range') || '' }, [channel.port2])
  })
}
