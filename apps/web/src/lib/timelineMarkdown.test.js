import assert from 'node:assert/strict'
import test from 'node:test'

import { capTimelineMarkdown, splitTimelineMarkdownBlocks } from './timelineMarkdown.js'

test('按空行拆分独立 Markdown 块', () => {
  assert.deepEqual(splitTimelineMarkdownBlocks('第一段\n\n## 第二段\n内容'), [
    '第一段',
    '## 第二段\n内容',
  ])
})

test('保留代码围栏内部的空行', () => {
  assert.deepEqual(splitTimelineMarkdownBlocks('```js\nconst first = 1\n\nconst second = 2\n```\n\n结尾'), [
    '```js\nconst first = 1\n\nconst second = 2\n```',
    '结尾',
  ])
})

test('截断超长消息时不会切开代理对', () => {
  const result = capTimelineMarkdown(`1234😀结尾`, 5)
  assert.equal(result.text, '1234')
  assert.equal(result.capped, true)
})
