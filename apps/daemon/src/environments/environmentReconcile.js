import fs from 'node:fs'
import { listWorktrees, runGit } from './worktreeService.js'
import { canonicalPathKey } from '../paths/canonicalPath.js'

export function environmentPathKey(value) {
  return canonicalPathKey(value)
}

export function includesWorktree(porcelain, expectedPath) {
  const expectedKey = environmentPathKey(expectedPath)
  return String(porcelain || '')
    .split(/\r?\n(?=worktree )/)
    .some((entry) => {
      const firstLine = entry.split(/\r?\n/, 1)[0]
      if (!firstLine.startsWith('worktree ')) return false
      return environmentPathKey(firstLine.slice('worktree '.length)) === expectedKey
    })
}

export async function reconcileEnvironment(environment) {
  if (!environment) return null
  if (environment.status === 'removed') return environment
  if (!fs.existsSync(environment.cwd)) return { ...environment, status: 'missing' }
  if (environment.kind !== 'worktree') {
    try {
      const status = await runGit(environment.cwd, ['status', '--porcelain'])
      return { ...environment, status: status ? 'dirty' : 'clean' }
    } catch {
      // 本地执行目录可以不是 Git 仓库，只要目录仍然存在就可以继续运行 Agent。
      return { ...environment, status: 'ready' }
    }
  }
  try {
    const porcelain = await listWorktrees(environment.repositoryRoot)
    const present = includesWorktree(porcelain, environment.worktreePath || environment.cwd)
    if (!present) return { ...environment, status: 'missing' }
    const status = await runGit(environment.cwd, ['status', '--porcelain'])
    return { ...environment, status: status ? 'dirty' : 'clean' }
  } catch { return { ...environment, status: 'missing' } }
}
