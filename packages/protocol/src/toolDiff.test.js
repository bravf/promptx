import assert from 'node:assert/strict'
import test from 'node:test'
import { createToolPatch } from './toolDiff.js'
import { toolSections } from './toolDetails.js'

test('逐行 Diff 保留上下文、不虚构行号，空文件增删和中文换行可还原', () => {
  for (const [before, after] of [['a\n旧😀\nb\nc\n', 'a\n新😀\nb\n新增\nc\n'], ['', 'hello\n'], ['hello', ''], ['same', 'same']]) {
    const rows = createToolPatch(before, after).split('\n').filter(line => !line.startsWith('@@'))
    assert.equal(rows.filter(line => !line.startsWith('+')).map(line => line.slice(1)).join('\n'), before)
    assert.equal(rows.filter(line => !line.startsWith('-')).map(line => line.slice(1)).join('\n'), after)
  }
})

test('原生 patch 优先于前后片段，ACP 不重复展示，单边内容不伪造 Diff', () => {
  const patch = '@@ -2,1 +2,1 @@\n-old\n+new'
  const native = toolSections({ name: 'Edit', detail: { input: { old_string: 'old', new_string: 'new' }, diff: patch } })
  assert.deepEqual(native.sections.map(section => section.id), ['patch'])
  assert.equal(native.sections[0].text, patch)
  const acp = toolSections({ name: 'Edit', detail: { rawInput: { old_string: 'old', new_string: 'new', path: '/a.js' }, content: [{ type: 'diff', path: '/a.js', oldText: 'old', newText: 'new' }] } })
  assert.equal(acp.sections.filter(section => section.format === 'diff').length, 1)
  const single = toolSections({ name: 'Edit', detail: { input: { new_string: 'new', path: '/a.js' } } })
  assert.equal(single.sections[0].format, 'code')
  assert.equal(single.sections[0].filePath, '/a.js')
})

test('大块替换采用有界计算且保留全部增删文本', () => {
  const patch = createToolPatch(Array(2000).fill('旧').join('\n'), Array(2000).fill('新').join('\n'))
  assert.equal(patch.split('\n').filter(line => line.startsWith('-')).length, 2000)
  assert.equal(patch.split('\n').filter(line => line.startsWith('+')).length, 2000)
})
