import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import {
  getWorkspaceGitDiff,
  getWorkspaceGitStatus,
  listWorkspaceDirectory,
  readWorkspaceFile,
  resolveWorkspaceTarget,
} from './workspaceInspection.js'

function fixture(t, prefix = 'promptx-workspace-inspection-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return result.stdout
}

test('路径解析拒绝父目录和工作区外部符号链接', (t) => {
  const root = fixture(t)
  const outside = fixture(t, 'promptx-workspace-outside-')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')
  fs.symlinkSync(outside, path.join(root, 'outside-link'))

  assert.throws(() => resolveWorkspaceTarget(root, '../outside'), { code: 'path_outside_workspace' })
  assert.throws(() => resolveWorkspaceTarget(root, 'outside-link/secret.txt'), { code: 'path_outside_workspace' })
})

test('目录按文件夹优先和自然名称排序，并隐藏 .git', (t) => {
  const root = fixture(t)
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, 'folder10'))
  fs.mkdirSync(path.join(root, 'folder2'))
  fs.writeFileSync(path.join(root, 'b.txt'), 'b')
  fs.writeFileSync(path.join(root, 'a.txt'), 'a')

  const result = listWorkspaceDirectory(root)
  assert.deepEqual(result.entries.map((entry) => entry.name), ['folder2', 'folder10', 'a.txt', 'b.txt'])
})

test('文件预览区分文本、图片、二进制和超大文件', (t) => {
  const root = fixture(t)
  fs.writeFileSync(path.join(root, 'hello.js'), 'const answer = 42\n')
  fs.writeFileSync(path.join(root, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]))
  fs.writeFileSync(path.join(root, 'binary.bin'), Buffer.from([0x00, 0x01, 0x02]))
  fs.writeFileSync(path.join(root, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))

  assert.equal(readWorkspaceFile(root, 'hello.js').kind, 'text')
  assert.equal(readWorkspaceFile(root, 'hello.js').content, 'const answer = 42\n')
  assert.equal(readWorkspaceFile(root, 'image.png').kind, 'image')
  assert.equal(readWorkspaceFile(root, 'binary.bin').kind, 'binary')
  assert.equal(readWorkspaceFile(root, 'large.txt').kind, 'too_large')
})

test('非 Git 工作区返回 available false', async (t) => {
  const root = fixture(t)
  assert.deepEqual(await getWorkspaceGitStatus(root), {
    available: false,
    branch: '',
    ahead: 0,
    behind: 0,
    files: [],
  })
})

test('Git 状态和 Diff 仅返回工作区子目录的变更', async (t) => {
  const root = fixture(t)
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(workspace)
  git(root, 'init', '-q')
  git(root, 'config', 'user.email', 'promptx@example.com')
  git(root, 'config', 'user.name', 'PromptX Test')
  fs.writeFileSync(path.join(workspace, 'modified.txt'), 'before\n')
  fs.writeFileSync(path.join(workspace, 'rename-me.txt'), 'rename\n')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside before\n')
  git(root, 'add', '.')
  git(root, 'commit', '-qm', 'initial')

  fs.writeFileSync(path.join(workspace, 'modified.txt'), 'after\n')
  fs.writeFileSync(path.join(workspace, 'staged.txt'), 'staged\n')
  fs.writeFileSync(path.join(workspace, 'untracked.txt'), 'untracked\n')
  fs.writeFileSync(path.join(root, 'outside.txt'), 'outside after\n')
  git(root, 'add', 'workspace/staged.txt')
  git(root, 'mv', 'workspace/rename-me.txt', 'workspace/renamed.txt')

  const status = await getWorkspaceGitStatus(workspace)
  assert.equal(status.available, true)
  assert.equal(status.branch, 'main')
  assert.deepEqual(new Set(status.files.map((file) => file.path)), new Set([
    'modified.txt',
    'renamed.txt',
    'staged.txt',
    'untracked.txt',
  ]))
  assert.equal(status.files.some((file) => file.path === 'outside.txt'), false)
  assert.deepEqual(status.files.find((file) => file.path === 'renamed.txt'), {
    path: 'renamed.txt',
    originalPath: 'rename-me.txt',
    status: 'renamed',
    staged: true,
    unstaged: false,
    indexStatus: 'R',
    worktreeStatus: ' ',
  })

  const modifiedDiff = await getWorkspaceGitDiff(workspace, 'modified.txt')
  assert.match(modifiedDiff.unstaged, /-before/)
  assert.match(modifiedDiff.unstaged, /\+after/)
  const stagedDiff = await getWorkspaceGitDiff(workspace, 'staged.txt')
  assert.match(stagedDiff.staged, /\+staged/)
  const untrackedDiff = await getWorkspaceGitDiff(workspace, 'untracked.txt')
  assert.match(untrackedDiff.unstaged, /\+untracked/)
})

test('超大 Diff 在子进程输出阶段截断并返回可展示内容', async (t) => {
  const root = fixture(t)
  git(root, 'init', '-q')
  fs.writeFileSync(path.join(root, 'large.txt'), 'before\n')
  git(root, 'add', 'large.txt')
  git(root, 'commit', '-qm', 'initial')
  fs.writeFileSync(path.join(root, 'large.txt'), `${'after\n'.repeat(400_000)}`)

  const result = await getWorkspaceGitDiff(root, 'large.txt')
  assert.equal(result.truncated, true)
  assert.ok(Buffer.byteLength(result.unstaged) <= 2 * 1024 * 1024)
  assert.ok(result.unstaged.split('\n').length <= 8001)
  assert.match(result.unstaged, /diff --git/)
})
