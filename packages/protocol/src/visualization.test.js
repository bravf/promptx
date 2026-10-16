import assert from 'node:assert/strict'
import test from 'node:test'
import { splitVisualizationContent, VISUALIZATION_START } from './visualization.js'
const reference = data => `${VISUALIZATION_START}${JSON.stringify(data)}`

test('可视化引用保留前后 Markdown，兼容标题和多个图表', () => {
  const first = reference({ path: '/work/图表.html', title: '趋势' })
  const parts = splitVisualizationContent(`说明\n${first}\n${reference({ path: 'second.htm' })}\n结束`)
  assert.deepEqual(parts.map(part => part.type), ['markdown', 'visualization', 'markdown', 'visualization', 'markdown'])
  assert.equal(parts[1].title, '趋势')
  assert.equal(parts[3].title, 'second.htm')
})

test('代码块、行内代码、缩进代码和转义中的示例保持原文', () => {
  const directive = reference({ path: 'demo.html' })
  for (const text of [`\`\`\`json\n${directive}\n\`\`\``, `~~~\n${directive}\n~~~`, `> \`\`\`\n> ${directive}\n> \`\`\``, `- \`\`\`\n  ${directive}\n  \`\`\``, `\`${directive}\``, `    ${directive}`, `\\${directive}`]) {
    assert.deepEqual(splitVisualizationContent(text), [{ type: 'markdown', text }])
  }
})

test('流式指令只在完整时显示，不暴露半截 JSON', () => {
  const directive = reference({ path: 'demo.html' })
  for (let end = 1; end < directive.length; end++) {
    assert.deepEqual(splitVisualizationContent(`前文${directive.slice(0, end)}`, { streaming: true }), [{ type: 'markdown', text: '前文' }])
  }
  assert.equal(splitVisualizationContent(directive, { streaming: true })[0].type, 'visualization')
  assert.equal(splitVisualizationContent(directive.slice(0, -1))[0].type, 'visualization-error')
})

test('错误引用显示提示，普通文本和其他指令不受影响', () => {
  for (const payload of ['{', '{}', 'null', '{"path":42}', '{"path":""}']) {
    assert.equal(splitVisualizationContent(`${VISUALIZATION_START}${payload}`)[0].type, 'visualization-error')
  }
  const text = '普通文本\nimagedata'
  assert.deepEqual(splitVisualizationContent(text), [{ type: 'markdown', text }])
})
