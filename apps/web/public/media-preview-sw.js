// 仅桥接视频分段请求。解密仍在页面中完成，不缓存视频、配对信息或业务响应。
self.addEventListener('install', event => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()))
self.addEventListener('message', event => {
  if (event.data?.type === 'promptx-video-client') event.ports[0]?.postMessage({ clientId: event.source.id })
})
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith('/__promptx_video/')) return
  event.respondWith(readVideo(event.request, url))
})

async function readVideo(request, url) {
  const [, , clientId, token] = url.pathname.split('/')
  const client = clientId && await self.clients.get(decodeURIComponent(clientId))
  if (!client || !token || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })
  return new Promise(resolve => {
    const channel = new MessageChannel()
    let settled = false
    const finish = response => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      request.signal.removeEventListener('abort', cancel)
      channel.port1.close()
      resolve(response)
    }
    const cancel = () => {
      channel.port1.postMessage({ cancel: true })
      finish(new Response(null, { status: request.signal.aborted ? 204 : 504 }))
    }
    const timer = setTimeout(cancel, 45000)
    request.signal.addEventListener('abort', cancel, { once: true })
    channel.port1.onmessage = ({ data }) => {
      if (data.canceled) { finish(new Response(null, { status: 204 })); return }
      if (data.error) { finish(new Response(data.error, { status: 502 })); return }
      const headers = new Headers(data.headers)
      headers.delete('content-encoding')
      if (request.method !== 'HEAD') headers.set('content-length', String(data.body.byteLength))
      headers.set('cache-control', 'no-store')
      finish(new Response(request.method === 'HEAD' ? null : data.body, { status: data.status, headers }))
    }
    if (request.signal.aborted) { cancel(); return }
    client.postMessage({ type: 'promptx-video-range', token, method: request.method, range: request.headers.get('range') || '' }, [channel.port2])
  })
}
