import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSseHeaders } from './routes.js'

test('SSE 手动响应保留跨域访问头', () => {
  const headers = createSseHeaders('http://127.0.0.1:5174')
  assert.equal(headers['Access-Control-Allow-Origin'], 'http://127.0.0.1:5174')
  assert.equal(headers['Content-Type'], 'text/event-stream; charset=utf-8')
  assert.equal(headers.Vary, 'Origin')
})

test('没有 Origin 时 SSE 允许同源和透明 Relay 访问', () => {
  assert.equal(createSseHeaders()['Access-Control-Allow-Origin'], '*')
})
