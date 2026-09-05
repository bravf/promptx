import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

export function runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', cwd, ...args], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr.trim() || `git exited with ${code}`)))
  })
}

export function validateSlug(value) {
  const slug = String(value || '').trim()
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(slug) || slug === '.' || slug === '..') throw new Error('Worktree 名称只能包含 ASCII 字母、数字、- 和 _，长度不超过 64')
  return slug
}

export function worktreesRoot() {
  return path.resolve(process.env.PROMPTX_WORKTREES_DIR || path.join(process.env.PROMPTX_HOME || path.join(os.homedir(), '.promptx'), 'worktrees'))
}

export async function repositoryRoot(cwd) {
  return (await runGit(cwd, ['rev-parse', '--show-toplevel'])).replace(/[\\/]+$/, '')
}

export async function defaultBranch(cwd) {
  try { return await runGit(cwd, ['symbolic-ref', '--short', 'HEAD']) } catch { return 'HEAD' }
}

export async function addWorktree({ repositoryRoot: root, baseRef, branchName, slug }) {
  const safeSlug = validateSlug(slug)
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(String(branchName || ''))) throw new Error('分支名不合法')
  const hash = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
  const target = path.join(worktreesRoot(), hash, safeSlug)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  if (fs.existsSync(target)) throw new Error('Worktree 目录已存在')
  await runGit(root, ['worktree', 'add', '-b', branchName, target, baseRef])
  return { path: target, branchName, baseRef, slug: safeSlug }
}

export async function addExistingBranch({ repositoryRoot: root, branchName, slug }) {
  const safeSlug = validateSlug(slug)
  const hash = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
  const target = path.join(worktreesRoot(), hash, safeSlug)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  await runGit(root, ['worktree', 'add', target, branchName])
  return { path: target, branchName, slug: safeSlug }
}

export const listWorktrees = (root) => runGit(root, ['worktree', 'list', '--porcelain'])
export const removeWorktree = (root, target, force = false) => runGit(root, ['worktree', 'remove', ...(force ? ['--force'] : []), target])
export const listCommits = (cwd, limit = 50) => runGit(cwd, ['log', `-${Math.max(1, Math.min(200, Number(limit) || 50))}`, '--pretty=format:%H%x09%an%x09%ad%x09%s', '--date=iso']).then((text) => text ? text.split(/\r?\n/).map((line) => { const [id, author, date, ...subject] = line.split('\t'); return { id, author, date, subject: subject.join('\t') } }) : [])
