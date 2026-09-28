import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createEventSource } from './eventSource.js'
import { createTaskEventPool } from './taskEventSource.js'

test('会话共享连接，订阅变化与断线重连使用各自最新游标，关闭后停止分发', async () => {
  const connections = []
  const subscribe = createTaskEventPool({ url: () => '/api/v2/task-events', connect: (url, options) => {
    const listeners = new Map()
    const connection = {
      closed: false,
      addEventListener: (type, listener) => listeners.set(type, listener),
      close() { this.closed = true },
      body: () => JSON.parse(options.requestOptions().body),
      emit: (subscriptionId, event) => listeners.get('task-event')({ data: JSON.stringify({ subscriptionId, event }) }),
    }
    connections.push(connection)
    return connection
  } })
  const received = []
  const a = subscribe('a', 'epoch-a:2')
  const b = subscribe('b', 'epoch-b:10')
  a.addEventListener('timeline', event => received.push(['a', JSON.parse(event.data).row.seq]))
  b.addEventListener('timeline', event => received.push(['b', JSON.parse(event.data).row.seq]))
  await Promise.resolve()
  assert.equal(connections.length, 1)
  const first = connections[0]
  const [aId, bId] = first.body().subscriptions.map(item => item.id)
  first.emit(aId, { type: 'timeline', epoch: 'epoch-a', row: { seq: 3 } })
  first.emit(bId, { type: 'timeline', epoch: 'epoch-b', row: { seq: 11 } })
  assert.deepEqual(received, [['a', 3], ['b', 11]])
  assert.deepEqual(first.body().subscriptions.map(item => item.cursor), ['epoch-a:3', 'epoch-b:11'])
  first.emit(aId, { type: 'reset', timeline: { epoch: 'new-epoch', rows: [{ seq: 1 }] } })
  const diff = subscribe('a', '', { snapshot: false })
  b.close()
  await Promise.resolve()
  assert.equal(first.closed, true)
  assert.equal(connections.length, 2)
  assert.deepEqual(connections[1].body().subscriptions.map(({ taskId, cursor, snapshot }) => ({ taskId, cursor, snapshot })), [
    { taskId: 'a', cursor: 'new-epoch:1', snapshot: true },
    { taskId: 'a', cursor: '', snapshot: false },
  ])
  first.emit(aId, { type: 'timeline', epoch: 'old', row: { seq: 99 } })
  assert.equal(received.length, 2)
  a.close()
  diff.close()
  await Promise.resolve()
  assert.equal(connections[1].closed, true)
  assert.equal(connections.length, 2)
})

test('事件流断开后重新提交最新订阅游标并继续接收消息', async t => {
  const bodies = []
  const server = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    const parsed = JSON.parse(body)
    bodies.push(parsed)
    const subscription = parsed.subscriptions[0]
    response.writeHead(200, { 'Content-Type': 'text/event-stream' })
    response.write(`event: task-event\ndata: ${JSON.stringify({ subscriptionId: subscription.id, event: { type: 'timeline', epoch: 'epoch', row: { seq: bodies.length + 2 } } })}\n\n`)
    if (bodies.length === 1) response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  let subscription
  t.after(async () => {
    subscription?.close()
    await Promise.resolve()
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  })
  const subscribe = createTaskEventPool({
    url: () => `http://127.0.0.1:${server.address().port}/api/v2/task-events`,
    connect: (url, options) => createEventSource(url, { ...options, retryMs: 10 }),
  })
  const received = []
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('事件流未恢复')), 3000)
    subscription = subscribe('task', 'epoch:2')
    subscription.addEventListener('timeline', event => {
      received.push(JSON.parse(event.data).row.seq)
      if (received.length === 2) { clearTimeout(timeout); resolve() }
    })
  })
  assert.deepEqual(received, [3, 4])
  assert.deepEqual(bodies.map(body => body.subscriptions[0].cursor), ['epoch:2', 'epoch:3'])
})
