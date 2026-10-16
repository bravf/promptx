import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readVisualization, MAX_VISUALIZATION_BYTES } from './visualizationPreview.js'

function setup(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-visualization-')))
  const workspace = path.join(root, 'workspace')
  const codexHome = path.join(root, 'codex')
  fs.mkdirSync(workspace)
  fs.mkdirSync(path.join(codexHome, 'visualizations'), { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const html = '<button>演示图表</button>'
  fs.writeFileSync(path.join(workspace, '图表.html'), html)
  return { root, workspace, codexHome, html }
}

test('读取工作区 HTML 绝对和相对路径，拒绝穿越和软链接逃逸', t => {
  const { root, workspace, html } = setup(t)
  assert.equal(readVisualization(workspace, '图表.html').html, html)
  assert.equal(readVisualization(workspace, path.join(workspace, '图表.html')).html, html)
  fs.writeFileSync(path.join(root, 'private.html'), 'private')
  fs.symlinkSync(path.join(root, 'private.html'), path.join(workspace, 'escape.html'))
  for (const value of ['../private.html', path.join(root, 'private.html'), 'escape.html']) {
    assert.throws(() => readVisualization(workspace, value), { statusCode: 403 })
  }
  fs.symlinkSync(path.join(workspace, '图表.html'), path.join(workspace, 'inside.html'))
  assert.equal(readVisualization(workspace, 'inside.html').html, html)
})

test('工作区外只允许已授权的 Codex 可视化目录，并校验真实路径', t => {
  const { root, workspace, codexHome } = setup(t)
  const external = path.join(codexHome, 'visualizations', 'chart.html')
  fs.writeFileSync(external, '<h1>Codex 图表</h1>')
  assert.throws(() => readVisualization(workspace, external, { codexHome }), { statusCode: 403 })
  const options = { codexHome, authorizeExternal: value => value === external }
  assert.match(readVisualization(workspace, external, options).html, /Codex/)
  const other = path.join(root, 'other.html')
  fs.writeFileSync(other, 'secret')
  assert.throws(() => readVisualization(workspace, other, { codexHome, authorizeExternal: () => true }), { statusCode: 403 })
  fs.unlinkSync(external); fs.symlinkSync(other, external)
  assert.throws(() => readVisualization(workspace, external, options), { statusCode: 403 })
})

test('拒绝过大、缺失、二进制、非 HTML、目录和空文件', t => {
  const { workspace } = setup(t)
  for (const [name, contents] of [['large.html', Buffer.alloc(MAX_VISUALIZATION_BYTES + 1, 65)], ['binary.html', Buffer.from([255])], ['null.html', '\0'], ['empty.html', '  '], ['plain.txt', 'text']]) fs.writeFileSync(path.join(workspace, name), contents)
  fs.mkdirSync(path.join(workspace, 'directory.html'))
  for (const [name, statusCode] of [['large.html', 413], ['missing.html', 404], ['binary.html', 400], ['null.html', 400], ['empty.html', 400], ['plain.txt', 400], ['directory.html', 400]]) {
    assert.throws(() => readVisualization(workspace, name), { statusCode })
  }
})
