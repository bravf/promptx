import assert from 'node:assert/strict'
import test from 'node:test'
import { isToolExpanded, toolExpansionKey } from './toolExpansion.js'
import { toolContentPreview } from './toolContentPreview.js'

test('本地默认展开遵循设置，手动选择优先，Relay 不自动展开', () => {
  const options = { enabled: true, remote: false }
  assert.equal(isToolExpanded(options), true)
  assert.equal(isToolExpanded({ ...options, enabled: false }), false)
  assert.equal(isToolExpanded({ ...options, remote: true }), false)
  assert.equal(isToolExpanded({ ...options, manual: false }), false)
  assert.equal(isToolExpanded({ enabled: false, remote: false, manual: true }), true)
  assert.equal(isToolExpanded({ ...options, remote: true, manual: true }), true)
  assert.notEqual(toolExpansionKey('epoch', 'turn', 'call'), toolExpansionKey('epoch', 'other', 'call'))
})

test('长内容按本地显示窗口逐步展开，不改变正文且不拆 emoji', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n')
  assert.equal(toolContentPreview(text).text.split('\n').length, 31)
  assert.equal(toolContentPreview(text).hidden, true)
  assert.ok(toolContentPreview(text, 2).text.length > toolContentPreview(text).text.length)
  assert.deepEqual(toolContentPreview(text, 4), { text, hidden: false })
  const long = 'a'.repeat(5999) + '😀more'
  assert.equal(toolContentPreview(long).text, 'a'.repeat(5999))
  assert.equal(toolContentPreview('').hidden, false)
})
