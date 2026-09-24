import assert from 'node:assert/strict'
import test from 'node:test'

import { renderCodexMarkdown, renderPlainCodexMarkdown } from './codexMarkdown.js'

test('renderCodexMarkdown renders fenced code blocks and lists', async () => {
  const html = await renderCodexMarkdown([
    '# 标题',
    '',
    '- 一',
    '- 二',
    '',
    '```js',
    'console.log(1)',
    '```',
  ].join('\n'))

  assert.match(html, /<ul>/)
  assert.match(html, /class="codex-code-block codex-code-block--labeled"/)
  assert.match(html, /class="codex-code-block__language">JavaScript</)
  assert.match(html, /class="codex-code-block__copy" data-copy-code="1"/)
  assert.match(html, /<pre><code class="language-js">/)
  assert.match(html, /style="color:[^"]+"/)
  assert.match(html.replace(/<[^>]+>/g, ''), /console\.log\(1\)/)
})

test('renderCodexMarkdown renders react language badge', async () => {
  const html = await renderCodexMarkdown([
    '```react',
    'export default function Hello() {',
    '  return <div>Hello</div>',
    '}',
    '```',
  ].join('\n'))

  assert.match(html, /class="codex-code-block__language">React</)
  assert.match(html, /<pre><code class="language-react">/)
})

test('renderCodexMarkdown renders shell variant language badges', async () => {
  const html = await renderCodexMarkdown([
    '```fish',
    'echo hello',
    '```',
    '',
    '```ps1',
    'Write-Host "hello"',
    '```',
    '',
    '```csh',
    'echo hello',
    '```',
  ].join('\n'))

  assert.match(html, /class="codex-code-block__language">Fish</)
  assert.match(html, /class="codex-code-block__language">PowerShell</)
  assert.match(html, /class="codex-code-block__language">Bash</)
})

test('renderCodexMarkdown renders common config and style language badges', async () => {
  const html = await renderCodexMarkdown([
    '```scss',
    '$color: #0f0;',
    '```',
    '',
    '```toml',
    'title = "PromptX"',
    '```',
    '',
    '```cs',
    'Console.WriteLine("hi");',
    '```',
  ].join('\n'))

  assert.match(html, /class="codex-code-block__language">SCSS</)
  assert.match(html, /class="codex-code-block__language">TOML</)
  assert.match(html, /class="codex-code-block__language">C#</)
})

test('renderCodexMarkdown renders copy button for unlabeled fenced block', async () => {
  const html = await renderCodexMarkdown([
    '```',
    'plain text block',
    '```',
  ].join('\n'), {
    copyLabel: '复制',
    copyAriaLabel: '复制代码',
  })

  assert.match(html, /class="codex-code-block__language-placeholder"/)
  assert.match(html, /class="codex-code-block__copy" data-copy-code="1" aria-label="复制代码">复制</)
})

test('renderCodexMarkdown keeps multiple fenced blocks in order', async () => {
  const html = await renderCodexMarkdown([
    '```ts',
    'const answer: number = 42',
    '```',
    '',
    '| A | B |',
    '| - | - |',
    '| 1 | 2 |',
    '',
    '```sql',
    'SELECT * FROM tasks;',
    '```',
  ].join('\n'))

  const tsIndex = html.indexOf('language-ts')
  const tableIndex = html.indexOf('<div class="codex-table-wrap">')
  const sqlIndex = html.indexOf('language-sql')

  assert.notEqual(tsIndex, -1)
  assert.notEqual(tableIndex, -1)
  assert.notEqual(sqlIndex, -1)
  assert.equal(tsIndex < tableIndex, true)
  assert.equal(tableIndex < sqlIndex, true)
})

test('renderPlainCodexMarkdown keeps fenced code plain', () => {
  const html = renderPlainCodexMarkdown([
    '```js',
    'console.log(1)',
    '```',
  ].join('\n'))

  assert.doesNotMatch(html, /codex-code-block/)
  assert.match(html, /<pre><code class="language-js">/)
  assert.match(html, /console\.log\(1\)/)
})

test('renderCodexMarkdown escapes raw html and hardens links', async () => {
  const html = await renderCodexMarkdown('<script>alert(1)</script>\n\n[link](https://example.com)')

  assert.doesNotMatch(html, /<script>/)
  assert.match(html, /target="_blank"/)
  assert.match(html, /rel="noreferrer noopener"/)
})

test('Markdown 图片路径中的转义点会还原为正常文件路径', async () => {
  const html = await renderCodexMarkdown('![玩家飞机预览](/Users/bravf/code/plane-shooter/art/player-plane-preview\\.png)')

  assert.match(html, /data-workspace-image-path="\/Users\/bravf\/code\/plane-shooter\/art\/player-plane-preview\.png"/)
  assert.match(html, /data-local-image="1"/)
  assert.doesNotMatch(html, /src="\/Users\/bravf/)
  assert.doesNotMatch(html, /preview\\\.png/)
})

test('工作区内的 Markdown 图片首次渲染为加载占位', async () => {
  const markdown = '![玩家飞机预览](/Users/bravf/code/plane-shooter/art/player-plane-preview\\.png)'
  const options = {
    workspaceCwd: '/Users/bravf/code/plane-shooter',
  }
  const html = await renderCodexMarkdown(markdown, options)
  const plainHtml = renderPlainCodexMarkdown(markdown, options)

  for (const rendered of [plainHtml, html]) {
    assert.match(rendered, /data-workspace-image-path="art\/player-plane-preview\.png"/)
    assert.match(rendered, /data-workspace-image-state="loading"/)
    assert.match(rendered, />图片加载中<\/span>/)
    assert.doesNotMatch(rendered, /src="\/Users\/bravf/)
  }
})

test('文件名不自动变成网址，显式网址和文件链接保持可点击', async () => {
  const input = 'AGENTS.md README.md index.html package.json src/main.js\n\nhttps://example.com/docs http://example.com\n\n[项目说明](AGENTS.md) [网站](https://example.com)'
  for (const render of [renderCodexMarkdown, renderPlainCodexMarkdown]) {
    const html = await render(input)
    assert.doesNotMatch(html, /href="http:\/\/(?:AGENTS|README|index|package|src)/i)
    assert.match(html, /AGENTS\.md README\.md index\.html package\.json src\/main\.js/)
    assert.match(html, /href="https:\/\/example\.com\/docs"/)
    assert.match(html, /href="http:\/\/example\.com"/)
    assert.match(html, /href="AGENTS\.md"/)
    assert.match(html, />项目说明<\/a>/)
    assert.match(html, />网站<\/a>/)
    assert.equal((html.match(/<a /g) || []).length, 4)
  }
})
