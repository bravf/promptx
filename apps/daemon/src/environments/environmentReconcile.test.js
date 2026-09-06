import assert from 'node:assert/strict'
import { test } from 'node:test'
import { environmentPathKey, includesWorktree } from './environmentReconcile.js'

test('匹配 Git 正斜杠输出与数据库反斜杠 Worktree 路径', () => {
  const porcelain = [
    'worktree C:/Users/1/.promptx/worktrees/repository/task-2',
    'HEAD 0123456789abcdef',
    'branch refs/heads/codex/task-2',
    '',
  ].join('\n')

  assert.equal(
    includesWorktree(porcelain, 'C:\\Users\\1\\.promptx\\worktrees\\repository\\task-2'),
    true,
  )
})

test('Windows Worktree 路径比较不区分大小写', () => {
  assert.equal(
    environmentPathKey('C:\\Users\\ONE\\PromptX\\Task-2'),
    environmentPathKey('c:/users/one/promptx/task-2'),
  )
})

test('Worktree 列表中没有目标路径时返回 false', () => {
  const porcelain = [
    'worktree C:/Users/1/.promptx/worktrees/repository/task-3',
    'HEAD fedcba9876543210',
    'branch refs/heads/codex/task-3',
    '',
  ].join('\r\n')

  assert.equal(
    includesWorktree(porcelain, 'C:\\Users\\1\\.promptx\\worktrees\\repository\\task-2'),
    false,
  )
})
