import assert from 'node:assert/strict'
import test from 'node:test'
import { waitForSocketCapacity } from './socketBackpressure.js'

test('高水位暂停响应正文，下降后恢复，取消不会继续等待', async () => {
  const socket = { readyState: 1, bufferedAmount: 300000 }
  let finished = false
  const wait = waitForSocketCapacity(socket).then(() => { finished = true })
  await Promise.resolve(); assert.equal(finished, false)
  socket.bufferedAmount = 0
  await wait; assert.equal(finished, true)
  socket.bufferedAmount = 300000
  const controller = new AbortController()
  const pending = waitForSocketCapacity(socket, controller.signal)
  controller.abort()
  await assert.rejects(pending, { name: 'AbortError' })
  socket.readyState = 3
  await assert.rejects(waitForSocketCapacity(socket), /断开/)
})
