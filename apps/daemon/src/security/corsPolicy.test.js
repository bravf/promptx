import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createCorsPolicy } from './corsPolicy.js'

test('CORS 随实际监听端口放行本地网页', () => {
  let port = null
  const policy = createCorsPolicy([], () => port)
  assert.equal(policy.allows('http://127.0.0.1:31871'), false)
  port = 31871
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(policy.allows(`http://${host}:31871`), true)
  }
  port = 31872
  assert.equal(policy.allows('http://127.0.0.1:31871'), false)
  assert.equal(policy.allows('http://127.0.0.1:31872'), true)
})

test('CORS 不因为端口匹配而信任外部来源或畸形 Origin', () => {
  const policy = createCorsPolicy([], () => 31871)
  for (const origin of [
    'http://evil.example:31871', 'http://localhost.evil.example:31871',
    'http://192.168.1.2:31871', 'http://127.0.0.1:31872',
    'https://127.0.0.1:31871', 'null', 'http://user@127.0.0.1:31871',
    'http://127.0.0.1:31871/path', 'http://127.0.0.1:31871?query=1',
  ]) assert.equal(policy.allows(origin), false, origin)
  assert.equal(policy.allows(''), true)
  assert.equal(policy.allows('http://127.0.0.1:5174'), true)
  assert.equal(createCorsPolicy(['https://configured.example'], () => 31871).allows('https://configured.example'), true)
})
