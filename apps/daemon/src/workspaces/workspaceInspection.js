import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const MAX_TEXT_BYTES = 2 * 1024 * 1024
const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MAX_DIFF_BYTES = 2 * 1024 * 1024
const MAX_DIFF_LINES = 8000
const GIT_TIMEOUT_MS = 10_000

const IMAGE_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
])

const TEXT_TYPES = new Map([
  ['.css', 'text/css'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.htm', 'text/html'],
  ['.js', 'text/javascript'],
  ['.jsx', 'text/javascript'],
  ['.json', 'application/json'],
  ['.md', 'text/markdown'],
  ['.mjs', 'text/javascript'],
  ['.svg', 'image/svg+xml'],
  ['.ts', 'text/typescript'],
  ['.tsx', 'text/typescript'],
  ['.txt', 'text/plain'],
  ['.vue', 'text/plain'],
  ['.xml', 'application/xml'],
  ['.yaml', 'application/yaml'],
  ['.yml', 'application/yaml'],
])

export class WorkspaceInspectionError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message)
    this.name = 'WorkspaceInspectionError'
    this.code = code
    this.statusCode = statusCode
  }
}

function toPosix(value) {
  return String(value || '').split(path.sep).join('/')
}

function isWithin(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

function normalizeRelativePath(input = '') {
  const value = String(input || '').trim()
  if (value.includes('\0')) throw new WorkspaceInspectionError('invalid_path', '路径包含无效字符。')
  if (path.isAbsolute(value)) throw new WorkspaceInspectionError('invalid_path', '只能访问工作区内的相对路径。')
  const normalized = path.normalize(value || '.')
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new WorkspaceInspectionError('path_outside_workspace', '不能访问工作区之外的路径。', 403)
  }
  return normalized === '.' ? '' : normalized
}

export function resolveWorkspaceTarget(cwd, input = '', options = {}) {
  let root
  try {
    root = fs.realpathSync(cwd)
  } catch {
    throw new WorkspaceInspectionError('workspace_unavailable', '工作区目录不可用。', 404)
  }
  const relativePath = normalizeRelativePath(input)
  const target = path.resolve(root, relativePath)
  if (!isWithin(root, target)) {
    throw new WorkspaceInspectionError('path_outside_workspace', '不能访问工作区之外的路径。', 403)
  }

  if (options.mustExist !== false) {
    let realTarget
    try {
      realTarget = fs.realpathSync(target)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new WorkspaceInspectionError('file_not_found', '文件或目录不存在。', 404)
      throw error
    }
    if (!isWithin(root, realTarget)) {
      throw new WorkspaceInspectionError('path_outside_workspace', '不能通过符号链接访问工作区之外的路径。', 403)
    }
    return { root, target: realTarget, relativePath: toPosix(path.relative(root, realTarget)) }
  }
  return { root, target, relativePath: toPosix(relativePath) }
}

function entryType(dirent) {
  if (dirent.isDirectory()) return 'directory'
  if (dirent.isSymbolicLink()) return 'symlink'
  return 'file'
}

export function listWorkspaceDirectory(cwd, requestedPath = '') {
  const target = resolveWorkspaceTarget(cwd, requestedPath)
  const directoryStat = fs.statSync(target.target)
  if (!directoryStat.isDirectory()) throw new WorkspaceInspectionError('not_a_directory', '目标路径不是目录。')

  const entries = fs.readdirSync(target.target, { withFileTypes: true })
    .filter((entry) => entry.name !== '.git')
    .map((entry) => {
      const entryPath = path.join(target.target, entry.name)
      let stat
      try {
        stat = fs.lstatSync(entryPath)
      } catch {
        return null
      }
      return {
        name: entry.name,
        path: toPosix(path.join(target.relativePath, entry.name)),
        type: entryType(entry),
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      }
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftRank = left.type === 'directory' ? 0 : 1
      const rightRank = right.type === 'directory' ? 0 : 1
      return leftRank - rightRank || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' })
    })

  return { path: target.relativePath, entries }
}

function looksBinary(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192))
  if (sample.includes(0)) return true
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: sample.length < buffer.length })
    return false
  } catch {
    return true
  }
}

function mimeTypeFor(filePath, fallback = 'application/octet-stream') {
  const extension = path.extname(filePath).toLowerCase()
  return IMAGE_TYPES.get(extension) || TEXT_TYPES.get(extension) || fallback
}

export function readWorkspaceFile(cwd, requestedPath) {
  const target = resolveWorkspaceTarget(cwd, requestedPath)
  const stat = fs.statSync(target.target)
  if (!stat.isFile()) throw new WorkspaceInspectionError('not_a_file', '目标路径不是文件。')
  const extension = path.extname(target.target).toLowerCase()
  const base = {
    path: target.relativePath,
    name: path.basename(target.target),
    size: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    mimeType: mimeTypeFor(target.target),
  }

  if (IMAGE_TYPES.has(extension)) {
    return { ...base, kind: stat.size <= MAX_IMAGE_BYTES ? 'image' : 'too_large' }
  }
  if (stat.size > MAX_TEXT_BYTES) return { ...base, kind: 'too_large' }

  const content = fs.readFileSync(target.target)
  if (looksBinary(content)) return { ...base, kind: 'binary' }
  return { ...base, kind: 'text', content: content.toString('utf8') }
}

export function openWorkspaceFileStream(cwd, requestedPath) {
  const target = resolveWorkspaceTarget(cwd, requestedPath)
  const stat = fs.statSync(target.target)
  if (!stat.isFile()) throw new WorkspaceInspectionError('not_a_file', '目标路径不是文件。')
  const mimeType = IMAGE_TYPES.get(path.extname(target.target).toLowerCase())
  if (!mimeType || stat.size > MAX_IMAGE_BYTES) {
    throw new WorkspaceInspectionError('preview_unavailable', '该文件不支持原始内容预览。', 415)
  }
  return { stream: fs.createReadStream(target.target), size: stat.size, mimeType }
}

async function runGit(cwd, args, options = {}) {
  return execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || MAX_DIFF_BYTES + 64 * 1024,
  })
}

function parseBranchLine(line = '') {
  const value = line.replace(/^## /, '')
  const ahead = Number(value.match(/\bahead (\d+)/)?.[1] || 0)
  const behind = Number(value.match(/\bbehind (\d+)/)?.[1] || 0)
  const branch = value
    .replace(/^No commits yet on /, '')
    .replace(/^Initial commit on /, '')
    .split('...')[0]
    .split(' [')[0]
    .trim()
  return { branch: branch === 'HEAD (no branch)' ? 'HEAD' : branch, ahead, behind }
}

function statusName(indexStatus, worktreeStatus) {
  if (indexStatus === 'U' || worktreeStatus === 'U' || (indexStatus === 'A' && worktreeStatus === 'A') || (indexStatus === 'D' && worktreeStatus === 'D')) return 'conflicted'
  if (indexStatus === '?' && worktreeStatus === '?') return 'untracked'
  if (indexStatus === 'R' || worktreeStatus === 'R') return 'renamed'
  if (indexStatus === 'D' || worktreeStatus === 'D') return 'deleted'
  if (indexStatus === 'A' || worktreeStatus === 'A') return 'added'
  return 'modified'
}

export function parseGitStatus(output = '') {
  const fields = String(output).split('\0')
  const branchInfo = parseBranchLine(fields.shift() || '')
  const files = []
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]
    if (!field) continue
    const indexStatus = field[0] || ' '
    const worktreeStatus = field[1] || ' '
    const filePath = field.slice(3)
    const renamed = indexStatus === 'R' || indexStatus === 'C' || worktreeStatus === 'R' || worktreeStatus === 'C'
    const originalPath = renamed ? fields[++index] : undefined
    files.push({
      path: toPosix(filePath),
      ...(originalPath ? { originalPath: toPosix(originalPath) } : {}),
      status: statusName(indexStatus, worktreeStatus),
      staged: ![' ', '?', '!'].includes(indexStatus),
      unstaged: ![' ', '!'].includes(worktreeStatus),
      indexStatus,
      worktreeStatus,
    })
  }
  return { ...branchInfo, files }
}

export async function getWorkspaceGitStatus(cwd) {
  const target = resolveWorkspaceTarget(cwd)
  try {
    const [{ stdout: root }, { stdout: status }] = await Promise.all([
      runGit(target.root, ['rev-parse', '--show-toplevel']),
      runGit(target.root, ['status', '--porcelain=v1', '-z', '--branch', '--untracked-files=all', '--', '.']),
    ])
    const gitRoot = String(root).trim()
    const workspacePrefix = toPosix(path.relative(gitRoot, target.root))
    const prefix = workspacePrefix ? `${workspacePrefix}/` : ''
    const parsed = parseGitStatus(status)
    const files = parsed.files.map((file) => ({
      ...file,
      path: prefix && file.path.startsWith(prefix) ? file.path.slice(prefix.length) : file.path,
      ...(file.originalPath
        ? { originalPath: prefix && file.originalPath.startsWith(prefix) ? file.originalPath.slice(prefix.length) : file.originalPath }
        : {}),
    }))
    return {
      available: true,
      root: gitRoot,
      branch: parsed.branch,
      ahead: parsed.ahead,
      behind: parsed.behind,
      files,
    }
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 128 || error?.stderr?.includes('not a git repository')) {
      return { available: false, branch: '', ahead: 0, behind: 0, files: [] }
    }
    throw new WorkspaceInspectionError('git_status_failed', `读取 Git 状态失败：${error.message}`, 500)
  }
}

function limitedChunk(chunk, remainingBytes, remainingLines) {
  let end = Math.min(chunk.length, remainingBytes)
  let lines = 0
  for (let index = 0; index < end; index += 1) {
    if (chunk[index] !== 0x0a) continue
    lines += 1
    if (lines > remainingLines) {
      end = index
      lines -= 1
      break
    }
  }
  return { value: chunk.subarray(0, end), lines, truncated: end < chunk.length }
}

function runGitDiff(cwd, args, { allowedExitCodes = [0] } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    const stdout = []
    const stderr = []
    let byteCount = 0
    let stderrByteCount = 0
    let lineCount = 0
    let truncated = false
    let timedOut = false
    let settled = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
    }, GIT_TIMEOUT_MS)

    child.stdout.on('data', (rawChunk) => {
      if (truncated) return
      const chunk = Buffer.from(rawChunk)
      const limited = limitedChunk(chunk, MAX_DIFF_BYTES - byteCount, MAX_DIFF_LINES - lineCount)
      if (limited.value.length) stdout.push(limited.value)
      byteCount += limited.value.length
      lineCount += limited.lines
      if (limited.truncated || byteCount >= MAX_DIFF_BYTES || lineCount >= MAX_DIFF_LINES) {
        truncated = true
        child.kill('SIGTERM')
      }
    })
    child.stderr.on('data', (chunk) => {
      if (stderrByteCount >= 64 * 1024) return
      const value = Buffer.from(chunk).subarray(0, 64 * 1024 - stderrByteCount)
      if (value.length) stderr.push(value)
      stderrByteCount += value.length
    })
    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (timedOut) {
        const error = new Error(`Git 命令超过 ${GIT_TIMEOUT_MS / 1000} 秒未完成。`)
        error.code = 'ETIMEDOUT'
        reject(error)
        return
      }
      const text = Buffer.concat(stdout).toString('utf8')
      if (truncated || allowedExitCodes.includes(code)) {
        resolve({ text, truncated })
        return
      }
      const error = new Error(Buffer.concat(stderr).toString('utf8').trim() || `Git 命令退出，状态码 ${code}。`)
      error.code = code
      reject(error)
    })
  })
}

async function untrackedDiff(cwd, relativePath) {
  resolveWorkspaceTarget(cwd, relativePath)
  return runGitDiff(cwd, ['diff', '--no-index', '--no-color', '--', '/dev/null', relativePath], { allowedExitCodes: [0, 1] })
}

export async function getWorkspaceGitDiff(cwd, requestedPath) {
  const normalized = resolveWorkspaceTarget(cwd, requestedPath, { mustExist: false }).relativePath
  if (!normalized) throw new WorkspaceInspectionError('invalid_path', '请选择要查看的文件。')
  const status = await getWorkspaceGitStatus(cwd)
  if (!status.available) throw new WorkspaceInspectionError('git_unavailable', '当前工作区不在 Git 仓库中。', 409)
  const file = status.files.find((item) => item.path === normalized)
  if (!file) return { path: normalized, staged: '', unstaged: '', truncated: false }

  try {
    const stagedPromise = file.staged
      ? runGitDiff(cwd, ['diff', '--cached', '--no-ext-diff', '--no-color', '--', normalized])
      : Promise.resolve({ text: '', truncated: false })
    const workingPromise = file.status === 'untracked'
      ? untrackedDiff(cwd, normalized)
      : file.unstaged
        ? runGitDiff(cwd, ['diff', '--no-ext-diff', '--no-color', '--', normalized])
        : Promise.resolve({ text: '', truncated: false })
    const [staged, working] = await Promise.all([stagedPromise, workingPromise])
    return {
      path: normalized,
      staged: staged.text,
      unstaged: working.text,
      truncated: staged.truncated || working.truncated,
    }
  } catch (error) {
    throw new WorkspaceInspectionError('git_diff_failed', `读取 Git Diff 失败：${error.message}`, 500)
  }
}
