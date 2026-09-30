import assert from 'node:assert/strict'
import test from 'node:test'
import { videoRange } from './videoSource.js'

test('远程视频将每次传输限制为 1 MiB，支持任意进度及文件尾读取', () => {
  assert.equal(videoRange(''), 'bytes=0-1048575')
  assert.equal(videoRange('bytes=0-1'), 'bytes=0-1')
  assert.equal(videoRange('bytes=50000000-'), 'bytes=50000000-51048575')
  assert.equal(videoRange('bytes=50000000-90000000'), 'bytes=50000000-51048575')
  assert.equal(videoRange('bytes=-50'), 'bytes=-50')
  assert.equal(videoRange('', 256 * 1024), 'bytes=0-262143')
  assert.equal(videoRange('bytes=50000000-', 256 * 1024), 'bytes=50000000-50262143')
  for (const range of ['bytes=-', 'bytes=5-3', 'bytes=0-1,5-6', 'invalid']) assert.throws(() => videoRange(range))
})
