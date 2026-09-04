import assert from 'node:assert/strict'
import test from 'node:test'
import { workspaceLinkForHref, workspaceLinksForTool } from './timelineWorkspaceLinks.js'

test('将 Timeline Markdown 中的工作区文件链接转换为抽屉目标', () => {
  assert.deepEqual(workspaceLinkForHref('/code/demo/src/App.vue#L12', '/code/demo'), {
    path: 'src/App.vue',
    intent: 'file',
    line: 12,
  })
  assert.deepEqual(workspaceLinkForHref('docs/My%20File.md', '/code/demo'), {
    path: 'docs/My File.md',
    intent: 'file',
    line: null,
  })
  assert.deepEqual(workspaceLinkForHref('/code/demo/src/App.vue:1065', '/code/demo'), {
    path: 'src/App.vue',
    intent: 'file',
    line: 1065,
  })
  assert.deepEqual(workspaceLinkForHref('src/App.vue:27:4', '/code/demo'), {
    path: 'src/App.vue',
    intent: 'file',
    line: 27,
  })
})

test('Timeline Markdown 外链和工作区外路径不进入抽屉', () => {
  assert.equal(workspaceLinkForHref('https://example.com/docs', '/code/demo'), null)
  assert.equal(workspaceLinkForHref('/api/health', '/code/demo'), null)
  assert.equal(workspaceLinkForHref('../secret.txt', '/code/demo'), null)
})

test('提取 Codex fileChange 的多个文件路径并标记为 Diff', () => {
  const links = workspaceLinksForTool({
    type: 'tool_call',
    name: '文件修改',
    detail: { type: 'fileChange', changes: [{ path: 'src/App.vue' }, { path: 'src/api.js' }] },
  })
  assert.deepEqual(links, [
    { path: 'src/App.vue', intent: 'diff', line: null },
    { path: 'src/api.js', intent: 'diff', line: null },
  ])
})

test('提取 Claude input 和行号并标记为文件预览', () => {
  const links = workspaceLinksForTool({
    type: 'tool_call',
    name: 'Read',
    detail: { type: 'claude_tool', input: { file_path: 'src/index.js', start_line: 12 } },
  })
  assert.deepEqual(links, [{ path: 'src/index.js', intent: 'file', line: 12 }])
})

test('解析 ACP JSON rawInput 并将工作区绝对路径转为相对路径', () => {
  const links = workspaceLinksForTool({
    type: 'tool_call',
    name: 'edit_file',
    detail: { type: 'acp_tool', rawInput: '{"filePath":"/code/demo/README.md"}' },
  }, '/code/demo')
  assert.deepEqual(links, [{ path: 'README.md', intent: 'diff', line: null }])
})

test('不从命令文本猜测文件，并拒绝工作区外路径', () => {
  assert.deepEqual(workspaceLinksForTool({
    type: 'tool_call',
    name: 'shell',
    detail: { type: 'commandExecution', command: 'cat src/secret.txt', path: '/outside/secret.txt' },
  }, '/code/demo'), [])
})
