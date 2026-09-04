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
