import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { searchDirectories } from './directorySearch.js'

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-directory-search-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  fs.mkdirSync(path.join(root, 'code', 'promptx'), { recursive: true })
  fs.mkdirSync(path.join(root, 'code', 'prompt-lab'), { recursive: true })
  fs.mkdirSync(path.join(root, 'notes'), { recursive: true })
  fs.mkdirSync(path.join(root, 'node_modules', 'prompt-hidden'), { recursive: true })
  return root
}

test('普通关键词递归搜索目录并忽略依赖目录', async (t) => {
  const root = createFixture(t)
  const result = await searchDirectories({ query: 'prompt', rootPath: root, homePath: root })

  assert.deepEqual(result.items.map((item) => item.name), ['promptx', 'prompt-lab'])
  assert.equal(result.items.some((item) => item.path.includes('node_modules')), false)
})

test('绝对路径片段从最近存在的父目录补全', async (t) => {
  const root = createFixture(t)
  const result = await searchDirectories({ query: path.join(root, 'code', 'prom'), rootPath: root, homePath: root })

  assert.deepEqual(new Set(result.items.map((item) => item.name)), new Set(['promptx', 'prompt-lab']))
})

test('已存在目录返回自身和可选子目录', async (t) => {
  const root = createFixture(t)
  const codePath = path.join(root, 'code')
  const result = await searchDirectories({ query: codePath, rootPath: root, homePath: root })

  assert.equal(result.items[0].path, codePath)
  assert.equal(result.items.some((item) => item.path === path.join(codePath, 'promptx')), true)
})
