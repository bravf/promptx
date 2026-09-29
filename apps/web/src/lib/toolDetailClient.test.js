import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolDetailClient } from './toolDetailClient.js'

test('Relay 限制两个并发，收起时取消排队请求且不发送', async () => {
  const pending = [], calls = []
  const client = createToolDetailClient({ remote: true, request: path => { calls.push(path); return new Promise(resolve => pending.push(resolve)) } })
  const controller = new AbortController()
  const first = client.fetch('task', { callId: '1' })
  const second = client.fetch('task', { callId: '2' })
  const third = client.fetch('task', { callId: '3' }, controller.signal)
  const canceled = assert.rejects(third, { name: 'AbortError' })
  await Promise.resolve()
  assert.equal(calls.length, 2)
  controller.abort(); await canceled
  pending.forEach(resolve => resolve({})); await Promise.all([first, second])
  assert.equal(calls.length, 2)
  assert.match(calls[0], /transport=relay/)
})

test('缓存按版本隔离并有字节上限，返回值不能污染缓存', () => {
  const client = createToolDetailClient({ maxCacheBytes: 100 })
  client.put('a:1', { text: 'a'.repeat(40) })
  const cached = client.get('a:1'); cached.text = 'wrong'
  assert.equal(client.get('a:1').text, 'a'.repeat(40))
  client.put('a:2', { text: 'b'.repeat(40) })
  assert.equal(client.get('a:1'), null)
  assert.equal(client.get('a:2').text, 'b'.repeat(40))
})
