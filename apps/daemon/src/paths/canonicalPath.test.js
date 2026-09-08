import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { canonicalPath, canonicalPathKey, resolveExistingDirectory } from './canonicalPath.js'

test('Windows 盘符路径键忽略大小写和分隔符', () => {
  assert.equal(
    canonicalPathKey('C:\\Users\\Alice\\Project\\', { platform: 'win32', realpath: false }),
    canonicalPathKey('c:/users/alice/project', { platform: 'win32', realpath: false }),
  )
})

test('Windows UNC 路径键忽略大小写和分隔符', () => {
  assert.equal(
    canonicalPathKey('\\\\Server\\Share\\Repo\\', { platform: 'win32', realpath: false }),
    canonicalPathKey('//server/share/repo', { platform: 'win32', realpath: false }),
  )
})

test('Linux 路径键保留大小写差异', () => {
  assert.notEqual(
    canonicalPathKey('/srv/Repo', { platform: 'linux', realpath: false }),
    canonicalPathKey('/srv/repo', { platform: 'linux', realpath: false }),
  )
})

test('已有目录和符号链接使用相同的物理路径身份', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-path-'))
  const target = path.join(root, 'target')
  const link = path.join(root, 'link')
  fs.mkdirSync(target)
  fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  assert.equal(canonicalPathKey(link), canonicalPathKey(target))
  assert.equal(resolveExistingDirectory(link), canonicalPath(target))
})

test('不存在的历史目录仍生成稳定路径键', () => {
  const missing = path.join(os.tmpdir(), 'promptx-path-that-does-not-exist')
  assert.equal(canonicalPathKey(`${missing}${path.sep}`), canonicalPathKey(missing))
})

test('macOS 的 /var 别名与物理路径使用同一路径键', { skip: process.platform !== 'darwin' }, () => {
  assert.equal(canonicalPathKey(os.tmpdir()), canonicalPathKey(fs.realpathSync.native(os.tmpdir())))
})
