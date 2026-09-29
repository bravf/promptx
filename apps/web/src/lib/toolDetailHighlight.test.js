import assert from 'node:assert/strict'
import test from 'node:test'
import { highlightToolSection, renderToolAnsi, toolDiffRows } from './toolDetailHighlight.js'

test('命令、JSON 和按路径识别的代码有高亮且安全转义 HTML', async () => {
  for (const section of [
    { id: 'command', text: 'echo "<img src=x onerror=alert(1)>"' },
    { format: 'json', text: '{"key":true}' },
    { format: 'code', filePath: 'a.vue', text: '<template><div>{{ count }}</div></template>' },
  ]) {
    const light = await highlightToolSection(section, false)
    const dark = await highlightToolSection(section, true)
    assert.match(light.html, /style="color:/)
    assert.notEqual(light.html, dark.html)
    assert.ok(!light.html.includes('<img '))
    assert.ok(!light.html.includes('<template>'))
  }
})

test('Diff 用红绿语义行和行内变化，保留 hunk 头并折叠上下文', () => {
  const text = '@@ -1,20 +1,20 @@\n-孩子咳嗽\n+孩子轻微咳嗽\n' + Array(15).fill(' context').join('\n')
  const rows = toolDiffRows(text)
  assert.equal(rows[0].kind, 'header')
  assert.equal(rows[1].kind, 'delete')
  assert.equal(rows[2].kind, 'add')
  assert.match(rows[2].html, /<mark>轻微<\/mark>/)
  assert.ok(rows.some(row => row.kind === 'fold'))
  assert.equal(toolDiffRows(text, true).map(row => row.text).join('\n'), text)
})

test('ANSI 颜色和重置正确，OSC/HTML 不变成可执行内容', () => {
  const html = renderToolAnsi('\x1b[31m失败<script>alert(1)</script>\x1b[0m正常\x1b]8;;https://example.com\x07文字\x1b]8;;\x07')
  assert.match(html, /var\(--theme-dangerText\)/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /<\/span>正常文字$/)
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('<a'))
  assert.match(renderToolAnsi('\x1b[38;2;12;34;56mcolor'), /rgb\(12,34,56\)/)
})

test('搜索结果弱化行号、标记字面匹配；普通日志不猜语言，超大内容安全降级', async () => {
  const search = await highlightToolSection({ format: 'search', text: 'a.vue:76: <div>hello</div>', matchText: 'hello' })
  assert.match(search.html, /tool-line-number/)
  assert.match(search.html, /<mark>hello<\/mark>/)
  assert.match(search.html, /&lt;div&gt;/)
  const log = await highlightToolSection({ text: 'WARN plain message' })
  assert.equal(log.html, 'WARN plain message')
  const large = await highlightToolSection({ id: 'command', text: '<script>'.repeat(20000) })
  assert.equal(large.limited, true)
  assert.ok(!large.html.includes('<script>'))
})
