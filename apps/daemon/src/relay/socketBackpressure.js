// 大响应让出发送队列；控制帧不经过此等待，取消可立即生效。
export async function waitForSocketCapacity(socket, signal, { high = 256 * 1024, low = 64 * 1024, timeout = 30000 } = {}) {
  if (signal?.aborted) throw new DOMException('请求已取消', 'AbortError')
  if (socket.readyState !== 1) throw new Error('Relay 连接已断开。')
  if (socket.bufferedAmount <= high) return
  await new Promise((resolve, reject) => {
    const started = Date.now()
    let timer
    const finish = error => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      error ? reject(error) : resolve()
    }
    const onAbort = () => finish(new DOMException('请求已取消', 'AbortError'))
    const check = () => {
      if (socket.readyState !== 1) return finish(new Error('Relay 连接已断开。'))
      if (socket.bufferedAmount <= low) return finish()
      if (Date.now() - started >= timeout) return finish(new Error('Relay 发送超时，请重试。'))
      timer = setTimeout(check, 10)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    check()
  })
}
