import fs from 'node:fs'
import path from 'node:path'
import { listWorktrees, runGit } from './worktreeService.js'

export function environmentPathKey(value) {
  const raw = String(value || '').trim()
  const isWindowsPath = /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}/.test(raw)
  const resolved = isWindowsPath ? path.win32.resolve(raw) : path.resolve(raw)
  return (isWindowsPath || process.platform === 'win32')
    ? resolved.replace(/\\/g, '/').toLowerCase()
    : resolved
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
  if (!fs.existsSync(environment.cwd)) return { ...environment, status: 'missing' }
  if (environment.kind !== 'worktree') {
    try {
      const status = await runGit(environment.cwd, ['status', '--porcelain'])
      return { ...environment, status: status ? 'dirty' : 'clean' }
    } catch { return { ...environment, status: 'unavailable' } }
  }
  try {
    const porcelain = await listWorktrees(environment.repositoryRoot)
    const present = includesWorktree(porcelain, environment.worktreePath || environment.cwd)
    if (!present) return { ...environment, status: 'missing' }
    const status = await runGit(environment.cwd, ['status', '--porcelain'])
    return { ...environment, status: status ? 'dirty' : 'clean' }
  } catch { return { ...environment, status: 'missing' } }
}
