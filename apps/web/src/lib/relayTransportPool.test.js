import assert from 'node:assert/strict'
import test from 'node:test'
import { createRelayTransportPool } from './relayTransportPool.js'

function fixture(t) {
  let offer = {}
  const connections = []
  const pool = createRelayTransportPool({ getOffer: () => offer, idleMs: 100, createConnection: () => {
    const connection = { closed: false, requests: [], close() { this.closed = true }, async request(path) {
      this.requests.push(path)
      if (path.includes('stall')) return new Response(new ReadableStream({ cancel() { connection.canceled = true } }))
      return new Response('media-data', { status: 206, headers: { 'Content-Range': 'bytes 0-9/10' } })
    } }
    connections.push(connection)
    return connection
  } })
  t.after(() => pool.close())
  t.mock.timers.enable({ apis: ['setTimeout'] })
  return { pool, connections, changeOffer() { offer = {} } }
}

test('媒体复用独立连接，普通请求继续走控制连接，空闲后仅回收媒体', async t => {
  const { pool, connections } = fixture(t)
  const control = pool.getControl()
  const a = await pool.request('/api/v2/projects/p/file/content?path=movie.mp4')
  const b = await pool.request('/api/v2/assets/a/content')
  await pool.request('/api/v2/health')
  assert.equal(connections.length, 2)
  assert.deepEqual(control.requests, ['/api/v2/health'])
  assert.equal(a.status, 206)
  assert.equal(a.headers.get('content-range'), 'bytes 0-9/10')
  assert.equal(await a.text(), 'media-data')
  t.mock.timers.tick(101)
  assert.equal(connections[1].closed, false)
  assert.equal(await b.text(), 'media-data')
  t.mock.timers.tick(101)
  assert.equal(connections[1].closed, true)
  assert.equal(control.closed, false)
  const next = await pool.request('/api/v2/local-image/content?path=a')
  assert.equal(connections.length, 3)
  await next.body.cancel()
})

test('取消未读取的响应能释放媒体请求并回收连接', async t => {
  const { pool, connections } = fixture(t)
  const controller = new AbortController()
  const response = await pool.request('/api/v2/assets/stall/content', { signal: controller.signal })
  controller.abort()
  await assert.rejects(response.text(), { name: 'AbortError' })
  assert.equal(connections[1].canceled, true)
  t.mock.timers.tick(101)
  assert.equal(connections[1].closed, true)
})

test('更换配对后旧响应的清理不影响新连接的活动计数', async t => {
  const { pool, connections, changeOffer } = fixture(t)
  const old = await pool.request('/api/v2/assets/stall/content')
  changeOffer()
  const current = await pool.request('/api/v2/assets/stall/content')
  assert.equal(connections[1].closed, true)
  await old.body.cancel()
  t.mock.timers.tick(101)
  assert.equal(connections[3].closed, false)
  await current.body.cancel()
  t.mock.timers.tick(101)
  assert.equal(connections[3].closed, true)
})

test('媒体请求失败后回收，控制连接保持可用', async t => {
  const { pool, connections } = fixture(t)
  await (await pool.request('/api/v2/assets/a/content')).body.cancel()
  connections[1].request = async () => { throw new Error('offline') }
  await assert.rejects(pool.request('/api/v2/assets/a/content'), /offline/)
  t.mock.timers.tick(101)
  assert.equal(connections[1].closed, true)
  assert.equal((await pool.request('/api/v2/health')).status, 206)
})
