import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSseHeaders } from './routes.js'

test('SSE 手动响应保留跨域访问头', () => {
  const headers = createSseHeaders('http://127.0.0.1:5174', () => true)
  assert.equal(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5174')
  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(headers.Vary, 'Origin')
})

test('没有 Origin 时 SSE 走同源或透明 Relay，不开放跨域响应', () => {
  assert.equal(createSseHeaders()['Access-Control-Allow-Origin'], undefined)
})

test('SSE 不反射未授权 Origin', () => {
  assert.equal(createSseHeaders('https://evil.example', () => false)['Access-Control-Allow-Origin'], undefined)
})
