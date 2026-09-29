import assert from 'node:assert/strict'
import test from 'node:test'
import { codexToolStatus, mergeToolDetails, toolSections, toolSummary } from './toolDetails.js'
import { presentTimelineItem } from './timelinePresentation.js'

test('Claude、Codex、Kimi、Grok 命令输入输出使用统一详情', () => {
  const cases = [
    { name: 'Bash', detail: { type: 'claude_tool', input: { command: 'echo 你好', description: '测试命令' }, output: '你好' } },
    { name: '终端命令', detail: { type: 'commandExecution', command: 'echo 你好', aggregatedOutput: '你好', exitCode: 0 } },
    { name: 'Shell', detail: { type: 'kimi_tool', arguments: '{"command":"echo 你好"}', output: '你好' } },
    { name: '运行命令', detail: { type: 'acp_tool', kind: 'execute', rawInput: { command: 'echo 你好' }, content: [{ type: 'content', content: { type: 'text', text: '你好' } }] } },
  ]
  for (const item of cases) {
    assert.equal(toolSummary(item).kind, 'shell')
    const { sections } = toolSections(item)
    assert.equal(sections.find(section => section.id === 'command').text, 'echo 你好')
    assert.equal(sections.find(section => section.id === 'output').text, '你好')
  }
})

test('修改片段、ACP diff 和未知 MCP 参数保留，二进制不混入正文', () => {
  const edit = toolSections({ name: 'Edit', detail: { input: { file_path: '/a', old_string: '旧', new_string: '新' } } })
  assert.equal(edit.sections.find(value => value.id === 'patch').text, '@@ 修改片段 @@\n-旧\n+新')
  assert.equal(edit.hasChanges, true)
  assert.equal(edit.sections.some(value => value.id === 'input'), false)
  const acp = toolSections({ name: '修改', detail: { type: 'acp_tool', kind: 'edit', content: [{ type: 'diff', path: '/a', oldText: '旧', newText: '新' }] } })
  assert.match(acp.sections.find(value => value.id === 'diffs').text, /旧/)
  const unknown = toolSections({ name: 'mcp__x', detail: { rawInput: '{bad json', rawOutput: { type: 'image', data: 'a'.repeat(10000) } } })
  assert.equal(unknown.sections[0].text, '{bad json')
  assert.ok(JSON.stringify(unknown).length < 1000)
})

test('摘要不携带大 metadata、错误、输出，空结果与缺失结果分开', () => {
  const item = presentTimelineItem({ type: 'tool_call', callId: 'x', name: 'Bash', status: 'failed', metadata: { large: 'x'.repeat(1e6) }, error: { message: '错'.repeat(10000) }, detail: { input: { command: 'a'.repeat(10000) }, output: 'b'.repeat(1e6) } })
  assert.ok(Buffer.byteLength(JSON.stringify(item)) < 2048)
  assert.equal(toolSections({ detail: { output: '' } }).resultState, 'empty')
  assert.equal(toolSections({ detail: {} }).resultState, 'missing')
})

test('命令增量保留输入，完成快照不重复输出，错误退出不伪装成功', () => {
  let item = { detail: { type: 'commandExecution', command: 'pwd' } }
  item = mergeToolDetails(item, { detail: { outputDelta: 'a' } })
  item = mergeToolDetails(item, { detail: { outputDelta: 'b' } })
  assert.equal(item.detail.aggregatedOutput, 'ab')
  item = mergeToolDetails(item, { detail: { aggregatedOutput: 'abc' } })
  assert.equal(item.detail.aggregatedOutput, 'abc')
  assert.equal(item.detail.command, 'pwd')
  assert.equal(codexToolStatus({ status: 'completed', exitCode: 1 }, 'completed'), 'failed')
  assert.equal(codexToolStatus({ status: 'declined' }, 'completed'), 'canceled')
})

test('带增量输出的合并工具事件仍保留命令摘要，纯增量不覆盖已有摘要', () => {
  const combined = presentTimelineItem({ type: 'tool_call', callId: 'x', name: '终端命令', status: 'running', detail: { type: 'commandExecution', command: 'echo hello', outputDelta: 'hello' } })
  assert.equal(combined.detail.command, 'echo hello')
  assert.equal(combined.detail.summary, 'echo hello')
  assert.equal(combined.detail.outputDelta, undefined)
  const delta = presentTimelineItem({ ...combined, detail: { type: 'commandExecution', outputDelta: 'more' } })
  assert.equal(Object.hasOwn(delta.detail, 'summary'), false)
})
