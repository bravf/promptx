import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { waitForDaemon } from './devReadiness.mjs'

async function fixture(t, handler) {
  const server = http.createServer(handler)
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => {
    server.close(resolve)
    server.closeAllConnections()
  }))
  return `http://127.0.0.1:${server.address().port}`
}

test('后端健康检查就绪后才继续', async (t) => {
  let requests = 0
  const origin = await fixture(t, (request, response) => {
    assert.equal(request.url, '/api/v2/health')
    requests += 1
    response.writeHead(requests < 3 ? 503 : 200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: requests >= 3 }))
  })
  await waitForDaemon(origin, { timeoutMs: 2000, intervalMs: 5 })
  assert.equal(requests, 3)
})

test('未就绪时超时并提示检查后端日志', async (t) => {
  const origin = await fixture(t, (_, response) => response.end('{"ok":false}'))
  await assert.rejects(waitForDaemon(origin, { timeoutMs: 100, intervalMs: 5 }), /未就绪.*后端启动日志/)
})

test('退出时取消等待，不再启动前端', async (t) => {
  const controller = new AbortController()
  const reason = new Error('测试停止')
  const origin = await fixture(t, () => controller.abort(reason))
  await assert.rejects(waitForDaemon(origin, { signal: controller.signal }), error => error === reason)
})
