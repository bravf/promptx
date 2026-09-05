import fs from 'node:fs'
import { listWorktrees, runGit } from './worktreeService.js'

export async function reconcileEnvironment(environment) {
  if (!environment) return null
  if (!fs.existsSync(environment.cwd)) return { ...environment, status: 'missing' }
  if (environment.kind !== 'worktree') {
    try {
      const status = await runGit(environment.cwd, ['status', '--porcelain'])
      return { ...environment, status: status ? 'dirty' : 'clean' }
    } catch { return { ...environment, status: 'unavailable' } }
  }
  try {
    const porcelain = await listWorktrees(environment.repositoryRoot)
    const present = porcelain.split(/\r?\n(?=worktree )/).some((entry) => entry.split(/\r?\n/)[0] === `worktree ${environment.worktreePath}`)
    if (!present) return { ...environment, status: 'missing' }
    const status = await runGit(environment.cwd, ['status', '--porcelain'])
    return { ...environment, status: status ? 'dirty' : 'clean' }
  } catch { return { ...environment, status: 'missing' } }
}
