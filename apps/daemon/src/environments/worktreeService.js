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

function normalizeGitPath(value) {
  return path.resolve(String(value || '').replace(/[\\/]+$/, ''))
}

function samePath(left, right) {
  const normalize = (value) => process.platform === 'win32' ? normalizeGitPath(value).toLowerCase() : normalizeGitPath(value)
  return normalize(left) === normalize(right)
}

export async function repositoryContext(cwd) {
  const checkoutRoot = normalizeGitPath(await runGit(cwd, ['rev-parse', '--show-toplevel']))
  const worktreeList = await runGit(checkoutRoot, ['worktree', 'list', '--porcelain'])
  const mainWorktreeLine = worktreeList.split(/\r?\n/).find((line) => line.startsWith('worktree '))
  const root = normalizeGitPath(mainWorktreeLine?.slice('worktree '.length) || checkoutRoot)
  const isWorktree = !samePath(root, checkoutRoot)
  return {
    repositoryRoot: root,
    checkoutRoot,
    isWorktree,
    branchName: await defaultBranch(checkoutRoot),
  }
}

export async function repositoryRoot(cwd) {
  return (await repositoryContext(cwd)).repositoryRoot
}

export async function defaultBranch(cwd) {
  try { return await runGit(cwd, ['symbolic-ref', '--short', 'HEAD']) } catch { return 'HEAD' }
}

function appendOrdinal(value, ordinal, maxLength) {
  if (ordinal === 1) return value
  const suffix = `-${ordinal}`
  return `${value.slice(0, maxLength - suffix.length)}${suffix}`
}

export async function addWorktree({ repositoryRoot: root, baseRef, branchName, slug }) {
  const safeSlug = validateSlug(slug)
  const safeBranchName = String(branchName || '')
  if (!/^[A-Za-z0-9_./-]{1,200}$/.test(safeBranchName)) throw new Error('分支名不合法')
  const hash = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16)
  const parent = path.join(worktreesRoot(), hash)
  fs.mkdirSync(parent, { recursive: true })
  const branches = new Set((await runGit(root, ['for-each-ref', '--format=%(refname:short)', 'refs/heads'])).split(/\r?\n/).filter(Boolean))
  for (let ordinal = 1; ordinal <= 10_000; ordinal += 1) {
    const candidateSlug = appendOrdinal(safeSlug, ordinal, 64)
    const candidateBranchName = appendOrdinal(safeBranchName, ordinal, 200)
    const target = path.join(parent, candidateSlug)
    if (fs.existsSync(target) || branches.has(candidateBranchName)) continue
    await runGit(root, ['worktree', 'add', '-b', candidateBranchName, target, baseRef])
    return { path: target, branchName: candidateBranchName, baseRef, slug: candidateSlug }
  }
  throw new Error('无法分配可用的 Worktree 名称')
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
