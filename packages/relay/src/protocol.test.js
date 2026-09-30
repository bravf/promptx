import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeBodyFrame, decodeBodyFrame, RELAY_CHUNK_BYTES } from './protocol.js'

test('二进制正文帧往返，限制分块、帧头与请求标识', () => {
  const requestId = 'req_binary_test1234'
  for (const type of ['request.body', 'response.body']) {
    for (const size of [0, 1, RELAY_CHUNK_BYTES]) {
      const bytes = Uint8Array.from({ length: size }, (_, i) => i % 256)
      const frame = decodeBodyFrame(encodeBodyFrame(type, requestId, bytes))
      assert.equal(frame.type, type)
      assert.equal(frame.requestId, requestId)
      assert.deepEqual(frame.bytes, bytes)
    }
  }
  assert.throws(() => encodeBodyFrame('request.end', requestId, new Uint8Array()))
  assert.throws(() => encodeBodyFrame('request.body', 'invalid', new Uint8Array()))
  assert.throws(() => encodeBodyFrame('request.body', requestId, new Uint8Array(RELAY_CHUNK_BYTES + 1)))
  for (const bytes of [new Uint8Array(), new Uint8Array([0x50, 0x58, 1, 1, 90]), new Uint8Array([0x50, 0x58, 2, 1, 0])]) assert.throws(() => decodeBodyFrame(bytes))
})
