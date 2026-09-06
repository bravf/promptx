import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { addWorktree, removeWorktree, repositoryContext, repositoryRoot } from './worktreeService.js'

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('重复的 Worktree 名称和分支自动使用递增后缀', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-worktree-name-'))
  const repository = path.join(root, 'repository')
  const previousWorktreesDir = process.env.PROMPTX_WORKTREES_DIR
  let first
  let second
  fs.mkdirSync(repository)
  process.env.PROMPTX_WORKTREES_DIR = path.join(root, 'worktrees')
  try {
    git(repository, ['init'])
    git(repository, ['config', 'user.email', 'promptx@example.test'])
    git(repository, ['config', 'user.name', 'PromptX Test'])
    fs.writeFileSync(path.join(repository, 'README.md'), '# PromptX\n')
    git(repository, ['add', 'README.md'])
    git(repository, ['commit', '-m', 'initial'])

    first = await addWorktree({ repositoryRoot: repository, baseRef: 'HEAD', branchName: 'codex/task', slug: 'task' })
    second = await addWorktree({ repositoryRoot: repository, baseRef: 'HEAD', branchName: 'codex/task', slug: 'task' })

    assert.equal(path.basename(first.path), 'task')
    assert.equal(first.branchName, 'codex/task')
    assert.equal(path.basename(second.path), 'task-2')
    assert.equal(second.branchName, 'codex/task-2')
  } finally {
    if (second?.path) await removeWorktree(repository, second.path, true).catch(() => {})
    if (first?.path) await removeWorktree(repository, first.path, true).catch(() => {})
    if (previousWorktreesDir === undefined) delete process.env.PROMPTX_WORKTREES_DIR
    else process.env.PROMPTX_WORKTREES_DIR = previousWorktreesDir
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('从 linked worktree 解析到主仓库及当前 checkout', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-worktree-context-'))
  const repository = path.join(root, 'repository')
  const linked = path.join(root, 'linked')
  fs.mkdirSync(repository)
  try {
    git(repository, ['init'])
    git(repository, ['config', 'user.email', 'promptx@example.test'])
    git(repository, ['config', 'user.name', 'PromptX Test'])
    fs.writeFileSync(path.join(repository, 'README.md'), '# PromptX\n')
    git(repository, ['add', 'README.md'])
    git(repository, ['commit', '-m', 'initial'])
    git(repository, ['worktree', 'add', '-b', 'codex/imported', linked, 'HEAD'])

    const context = await repositoryContext(linked)
    assert.equal(context.repositoryRoot, fs.realpathSync(repository))
    assert.equal(context.checkoutRoot, fs.realpathSync(linked))
    assert.equal(context.isWorktree, true)
    assert.equal(context.branchName, 'codex/imported')
    assert.equal(await repositoryRoot(linked), fs.realpathSync(repository))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
