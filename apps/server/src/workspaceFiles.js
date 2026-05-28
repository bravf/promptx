import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createApiError } from './apiErrors.js'

const WORKSPACE_HIDDEN_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  '.cache',
  'node_modules',
])

const DIRECTORY_PICKER_IGNORED_DIRECTORY_NAMES = new Set([
  ...WORKSPACE_HIDDEN_DIRECTORY_NAMES,
  'dist',
  'build',
  'coverage',
  'tmp',
  'temp',
  'uploads',
])

const DIRECTORY_PICKER_HIDDEN_NAMES = new Set([
  'Applications',
  'Downloads',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'Public',
])

const DEFAULT_TREE_LIMIT = 200
const DEFAULT_SEARCH_LIMIT = 80
const DEFAULT_CONTENT_SEARCH_LIMIT = 80
const MAX_SEARCH_VISITS = 20000
const DIRECTORY_PICKER_LIMIT = 240
const DEFAULT_FILE_PREVIEW_LIMIT = 200 * 1024
const DEFAULT_FILE_BLAME_LINE_LIMIT = Math.max(200, Number(process.env.PROMPTX_FILE_BLAME_LINE_LIMIT) || 5000)
const DEFAULT_FILE_BLAME_TIMEOUT_MS = Math.max(500, Number(process.env.PROMPTX_FILE_BLAME_TIMEOUT_MS) || 6000)
const MAX_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024
const MAX_CONTENT_SEARCH_FILE_BYTES = 1024 * 1024
const MAX_CONTENT_MATCHES_PER_FILE = 20

const TEXT_FILE_EXTENSIONS = new Set([
  '.c',
  '.cc',
  '.conf',
  '.cpp',
  '.csh',
  '.css',
  '.csv',
  '.env',
  '.fish',
  '.gitignore',
  '.go',
  '.graphql',
  '.h',
  '.html',
  '.ini',
  '.java',
  '.js',
  '.json',
  '.jsx',
  '.less',
  '.log',
  '.md',
  '.mjs',
  '.ps1',
  '.py',
  '.rb',
  '.rs',
  '.sass',
  '.scss',
  '.sh',
  '.sql',
  '.svg',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.vue',
  '.xml',
  '.yaml',
  '.yml',
])

const IMAGE_MIME_TYPES = new Map([
  ['.avif', 'image/avif'],
  ['.bmp', 'image/bmp'],
  ['.gif', 'image/gif'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
])

const LANGUAGE_BY_EXTENSION = new Map([
  ['.bash', 'bash'],
  ['.bat', 'bash'],
  ['.c', 'c'],
  ['.cc', 'cpp'],
  ['.cpp', 'cpp'],
  ['.csh', 'bash'],
  ['.css', 'css'],
  ['.diff', 'diff'],
  ['.env', 'dotenv'],
  ['.fish', 'fish'],
  ['.go', 'go'],
  ['.h', 'c'],
  ['.html', 'html'],
  ['.ini', 'ini'],
  ['.java', 'java'],
  ['.js', 'javascript'],
  ['.json', 'json'],
  ['.jsx', 'react'],
  ['.less', 'less'],
  ['.md', 'markdown'],
  ['.mjs', 'javascript'],
  ['.ps1', 'powershell'],
  ['.py', 'python'],
  ['.rs', 'rust'],
  ['.sass', 'sass'],
  ['.scss', 'scss'],
  ['.sh', 'bash'],
  ['.sql', 'sql'],
  ['.svg', 'svg'],
  ['.toml', 'toml'],
  ['.ts', 'typescript'],
  ['.tsx', 'react'],
  ['.txt', 'text'],
  ['.vue', 'vue'],
  ['.xml', 'xml'],
  ['.yaml', 'yaml'],
  ['.yml', 'yaml'],
  ['Dockerfile', 'dockerfile'],
  ['pip', 'python'],
  ['pip3', 'python'],
])

const LANGUAGE_BY_SHEBANG_PATTERN = [
  [/python(?:\d+(?:\.\d+)*)?$/, 'python'],
  [/(?:ba|z|k|c|tc)?sh$/, 'bash'],
  [/fish$/, 'fish'],
  [/(?:pwsh|powershell)$/, 'powershell'],
  [/node$/, 'javascript'],
]

function createHttpError(message, statusCode = 400) {
  return createApiError('', message, statusCode)
}

function createWorkspaceUnavailablePayload(target, reason = '', message = '') {
  return {
    cwd: target.root,
    path: target.relativePath,
    supported: false,
    reason: String(reason || 'unavailable').trim() || 'unavailable',
    message: String(message || '').trim(),
    items: [],
  }
}

function toPosixPath(value = '') {
  return String(value || '').replace(/\\/g, '/')
}

function normalizeRelativePath(relativePath = '') {
  const value = toPosixPath(relativePath).trim()
  if (!value || value === '.') {
    return ''
  }

  if (value.includes('\0')) {
    throw createApiError('errors.invalidPath', '路径不合法。')
  }

  const cleaned = value
    .replace(/^\/+/, '')
    .replace(/^\.\/+/, '')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')

  if (!cleaned) {
    return ''
  }

  const segments = cleaned.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw createApiError('errors.invalidPath', '路径不合法。')
  }

  return cleaned
}

function ensurePathInsideWorkspace(workspacePath, targetPath) {
  const root = path.resolve(String(workspacePath || ''))
  const target = path.resolve(String(targetPath || ''))

  if (target === root) {
    return target
  }

  if (target.startsWith(`${root}${path.sep}`)) {
    return target
  }

  throw createApiError('errors.pathOutsideWorkspace', '只能访问当前工作目录内的文件。', 403)
}

function resolveWorkspaceTarget(workspacePath, relativePath = '') {
  const root = path.resolve(String(workspacePath || ''))
  const normalizedRelativePath = normalizeRelativePath(relativePath)
  const targetPath = normalizedRelativePath
    ? path.resolve(root, normalizedRelativePath)
    : root

  return {
    root,
    relativePath: normalizedRelativePath,
    absolutePath: ensurePathInsideWorkspace(root, targetPath),
  }
}

function runGit(workspacePath = '', args = [], options = {}) {
  const result = spawnSync('git', ['-C', workspacePath, ...args], {
    encoding: 'utf8',
    maxBuffer: 12 * 1024 * 1024,
    timeout: DEFAULT_FILE_BLAME_TIMEOUT_MS,
    windowsHide: true,
    ...options,
  })

  return {
    status: typeof result.status === 'number' ? result.status : 1,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    signal: String(result.signal || ''),
    errorCode: String(result.error?.code || ''),
    timedOut: String(result.error?.code || '') === 'ETIMEDOUT',
  }
}

function getPathType(absolutePath = '') {
  try {
    const stats = fs.statSync(absolutePath)
    if (stats.isDirectory()) {
      return 'directory'
    }
    if (stats.isFile()) {
      return 'file'
    }
  } catch {
    return ''
  }

  return ''
}

function getFileLineCount(absolutePath = '') {
  const content = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n')
  return content ? content.split('\n').length : 0
}

function parseGitBlamePorcelain(output = '') {
  const items = []
  const commitMeta = new Map()
  let current = null

  String(output || '').replace(/\r\n/g, '\n').split('\n').forEach((line) => {
    const headerMatch = line.match(/^([0-9a-f]{40})\s+\d+\s+(\d+)(?:\s+\d+)?$/i)
    if (headerMatch) {
      const commit = headerMatch[1]
      const lineNumber = Number(headerMatch[2]) || 0
      const cached = commitMeta.get(commit) || {}
      current = {
        line: lineNumber,
        commit,
        author: cached.author || '',
        authorMail: cached.authorMail || '',
        authorTime: cached.authorTime || '',
        summary: cached.summary || '',
      }
      return
    }

    if (!current) {
      return
    }

    if (line.startsWith('author ')) {
      current.author = line.slice('author '.length)
      return
    }
    if (line.startsWith('author-mail ')) {
      current.authorMail = line.slice('author-mail '.length).replace(/^<|>$/g, '')
      return
    }
    if (line.startsWith('author-time ')) {
      const timestamp = Number(line.slice('author-time '.length)) || 0
      current.authorTime = timestamp > 0 ? new Date(timestamp * 1000).toISOString() : ''
      return
    }
    if (line.startsWith('summary ')) {
      current.summary = line.slice('summary '.length)
      return
    }

    if (line.startsWith('\t')) {
      if (current.line > 0) {
        const meta = {
          author: current.author,
          authorMail: current.authorMail,
          authorTime: current.authorTime,
          summary: current.summary,
        }
        commitMeta.set(current.commit, meta)
        items.push({
          line: current.line,
          commit: current.commit,
          shortCommit: current.commit.slice(0, 8),
          ...meta,
        })
      }
      current = null
    }
  })

  return items.sort((left, right) => left.line - right.line)
}

function shouldIgnoreDirectory(entry) {
  return entry?.isDirectory?.() && WORKSPACE_HIDDEN_DIRECTORY_NAMES.has(entry.name)
}

function shouldIgnorePickerDirectory(entry) {
  if (!entry?.isDirectory?.()) {
    return false
  }

  const name = String(entry.name || '').trim()
  if (!name) {
    return false
  }

  return name.startsWith('.')
    || DIRECTORY_PICKER_IGNORED_DIRECTORY_NAMES.has(name)
    || DIRECTORY_PICKER_HIDDEN_NAMES.has(name)
}

function compareWorkspaceEntries(left, right) {
  const typeDiff = Number(left.type !== 'directory') - Number(right.type !== 'directory')
  if (typeDiff) {
    return typeDiff
  }

  return String(left.name || '').localeCompare(String(right.name || ''), 'zh-CN')
}

function compareDirectoryEntries(left, right) {
  return String(left.name || left.path || '').localeCompare(String(right.name || right.path || ''), 'zh-CN')
}

function buildWorkspaceItem(workspacePath, absolutePath, entry, typeOverride = '') {
  const type = typeOverride || (entry?.isDirectory?.() ? 'directory' : 'file')
  const relativePath = path.relative(workspacePath, absolutePath)

  return {
    name: entry?.name || path.basename(absolutePath),
    path: toPosixPath(relativePath),
    type,
    hasChildren: type === 'directory' ? directoryHasVisibleChildren(absolutePath) : false,
  }
}

function directoryHasVisibleChildren(directoryPath = '') {
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    return entries.some((entry) => !shouldIgnoreDirectory(entry))
  } catch {
    return false
  }
}

function directoryHasVisiblePickerChildren(directoryPath = '') {
  try {
    const entries = fs.readdirSync(directoryPath, { withFileTypes: true })
    return entries.some((entry) => entry.isDirectory() && !shouldIgnorePickerDirectory(entry))
  } catch {
    return false
  }
}

function createDirectoryPickerItem(directoryPath = '', entryName = '') {
  const normalizedPath = path.resolve(String(directoryPath || ''))
  const parsed = path.parse(normalizedPath)
  const isRoot = normalizedPath === parsed.root
  const displayPath = normalizedPath
  const displayName = entryName
    || (isRoot
      ? (process.platform === 'win32'
        ? normalizedPath.replace(/[\\/]+$/, '')
        : normalizedPath)
      : path.basename(normalizedPath))

  return {
    name: displayName || displayPath,
    path: displayPath,
    type: 'directory',
    hasChildren: directoryHasVisiblePickerChildren(normalizedPath),
    isRoot,
  }
}

function getDirectoryPickerHomePath() {
  return path.resolve(os.homedir())
}

function isReadableDirectory(directoryPath = '') {
  try {
    const stats = fs.statSync(directoryPath)
    return stats.isDirectory()
  } catch {
    return false
  }
}

function getDirectoryPickerRootItems(homePath = getDirectoryPickerHomePath()) {
  const roots = [createDirectoryPickerItem(homePath)]

  if (process.platform !== 'win32') {
    return roots
  }

  ;['c', 'd', 'e', 'f'].forEach((driveLetter) => {
    const drivePath = `${driveLetter.toUpperCase()}:\\`
    if (!isReadableDirectory(drivePath)) {
      return
    }

    const normalizedHomePath = path.resolve(homePath).toLowerCase()
    const normalizedDrivePath = path.resolve(drivePath).toLowerCase()
    if (normalizedHomePath === normalizedDrivePath) {
      return
    }

    roots.push(createDirectoryPickerItem(drivePath, `${driveLetter.toUpperCase()} 盘`))
  })

  return roots
}

function normalizeDirectoryPickerPath(input = '') {
  const value = String(input || '').trim()
  if (!value) {
    return ''
  }

  const resolved = path.resolve(value)
  if (!fs.existsSync(resolved)) {
    throw createApiError('errors.directoryNotFound', '目录不存在，请重新选择。', 404)
  }

  const stats = fs.statSync(resolved)
  if (!stats.isDirectory()) {
    throw createApiError('errors.directoryOnly', '只能选择文件夹。')
  }

  return resolved
}

function getDirectoryParentPath(directoryPath = '') {
  const resolved = path.resolve(String(directoryPath || ''))
  const parsed = path.parse(resolved)

  if (resolved === parsed.root) {
    return ''
  }

  const parentPath = path.dirname(resolved)
  return parentPath === resolved ? '' : parentPath
}

function clampLimit(value, fallback, max) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized) || normalized <= 0) {
    return fallback
  }

  return Math.min(Math.floor(normalized), max)
}

function readFileSlice(absolutePath = '', length = 0) {
  const fileHandle = fs.openSync(absolutePath, 'r')

  try {
    const buffer = Buffer.alloc(Math.max(0, length))
    const bytesRead = fs.readSync(fileHandle, buffer, 0, buffer.length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    fs.closeSync(fileHandle)
  }
}

function isLikelyBinaryBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return false
  }

  const sample = buffer.subarray(0, Math.min(buffer.length, 8000))
  let suspiciousBytes = 0

  for (const byte of sample) {
    if (byte === 0) {
      return true
    }

    const isControlChar = byte < 32 && byte !== 9 && byte !== 10 && byte !== 13
    if (isControlChar) {
      suspiciousBytes += 1
    }
  }

  return (suspiciousBytes / sample.length) > 0.1
}

function getFileLanguage(relativePath = '', absolutePath = '') {
  const relativeName = path.basename(String(relativePath || '').trim())
  const absoluteName = path.basename(String(absolutePath || '').trim())

  if (LANGUAGE_BY_EXTENSION.has(relativeName)) {
    return LANGUAGE_BY_EXTENSION.get(relativeName)
  }
  if (LANGUAGE_BY_EXTENSION.has(absoluteName)) {
    return LANGUAGE_BY_EXTENSION.get(absoluteName)
  }

  const extension = path.extname(relativeName || absoluteName).toLowerCase()
  return LANGUAGE_BY_EXTENSION.get(extension) || ''
}

function getShebangLanguage(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return ''
  }

  const firstLine = buffer.toString('utf8', 0, Math.min(buffer.length, 200)).split(/\r?\n/, 1)[0] || ''
  if (!firstLine.startsWith('#!')) {
    return ''
  }

  const command = firstLine
    .replace(/^#!\s*/, '')
    .replace(/\s+-\S+/g, ' ')
    .trim()
    .split(/\s+/)
    .pop() || ''
  const executable = path.basename(command).toLowerCase()

  for (const [pattern, language] of LANGUAGE_BY_SHEBANG_PATTERN) {
    if (pattern.test(executable)) {
      return language
    }
  }

  return ''
}

function getImageMimeType(relativePath = '', absolutePath = '') {
  const extension = path.extname(String(relativePath || absolutePath || '')).toLowerCase()
  return IMAGE_MIME_TYPES.get(extension) || ''
}

function isKnownTextFilePath(relativePath = '', absolutePath = '') {
  const targetName = path.basename(String(relativePath || absolutePath || '').trim())
  const extension = path.extname(targetName).toLowerCase()

  return TEXT_FILE_EXTENSIONS.has(targetName)
    || TEXT_FILE_EXTENSIONS.has(extension)
}

function removeExtension(value = '') {
  const normalized = String(value || '')
  const extensionIndex = normalized.lastIndexOf('.')
  if (extensionIndex <= 0) {
    return normalized
  }

  return normalized.slice(0, extensionIndex)
}

function splitSegmentWords(segment = '') {
  return removeExtension(String(segment || ''))
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-zA-Z0-9]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
}

function scoreExactPrefixSubstring(candidate = '', query = '', weights = {}) {
  const source = String(candidate || '').toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!source || !keyword) {
    return 0
  }

  if (source === keyword) {
    return weights.exact ?? 0
  }

  if (source.startsWith(keyword)) {
    return (weights.prefix ?? 0) - source.length
  }

  const substringIndex = source.indexOf(keyword)
  if (substringIndex >= 0) {
    return (weights.substring ?? 0) - substringIndex * 12 - Math.max(source.length - keyword.length, 0)
  }

  return 0
}

function scoreCompactSubsequence(candidate = '', query = '') {
  const source = String(candidate || '').toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!source || !keyword || keyword.length < 2 || keyword.length > source.length) {
    return 0
  }

  const positions = []
  let searchIndex = 0

  for (const char of keyword) {
    const matchIndex = source.indexOf(char, searchIndex)
    if (matchIndex < 0) {
      return 0
    }
    positions.push(matchIndex)
    searchIndex = matchIndex + 1
  }

  const span = positions[positions.length - 1] - positions[0] + 1
  const gap = span - keyword.length
  const maxGap = Math.max(2, Math.floor(keyword.length * 0.6))
  const coverage = keyword.length / span

  if (gap > maxGap || coverage < 0.72) {
    return 0
  }

  return 3200 - gap * 120 - Math.max(source.length - keyword.length, 0)
}

function scorePathMatch(relativePath = '', query = '') {
  const normalizedPath = toPosixPath(relativePath).toLowerCase()
  const keyword = String(query || '').trim().toLowerCase()

  if (!normalizedPath || !keyword) {
    return 0
  }

  if (normalizedPath === keyword) {
    return 16000
  }

  if (normalizedPath.startsWith(keyword)) {
    return 13200 - normalizedPath.length
  }

  const boundaryPrefixIndex = normalizedPath.indexOf(`/${keyword}`)
  if (boundaryPrefixIndex >= 0) {
    return 12000 - boundaryPrefixIndex * 8 - normalizedPath.length
  }

  const substringIndex = normalizedPath.indexOf(keyword)
  if (substringIndex >= 0) {
    return 9800 - substringIndex * 12 - Math.max(normalizedPath.length - keyword.length, 0)
  }

  return 0
}

function scoreSegmentMatch(segment = '', query = '', options = {}) {
  const keyword = String(query || '').trim().toLowerCase()
  const normalizedSegment = String(segment || '').toLowerCase()
  const bareSegment = removeExtension(normalizedSegment)

  if (!normalizedSegment || !keyword) {
    return 0
  }

  const exactWeights = options.isFileName
    ? { exact: 15000, prefix: 12600, substring: 10600 }
    : { exact: 12400, prefix: 10400, substring: 9000 }

  let bestScore = Math.max(
    scoreExactPrefixSubstring(normalizedSegment, keyword, exactWeights),
    scoreExactPrefixSubstring(bareSegment, keyword, exactWeights)
  )

  const words = splitSegmentWords(segment)
  if (words.length) {
    const initials = words.map((word) => word[0]).join('')
    const compact = words.join('')

    for (const word of words) {
      bestScore = Math.max(
        bestScore,
        scoreExactPrefixSubstring(word, keyword, {
          exact: 11600,
          prefix: 9800,
          substring: 8200,
        })
      )
    }

    if (initials && keyword.length >= 2 && initials.startsWith(keyword)) {
      bestScore = Math.max(bestScore, 6000 - initials.length * 10)
    }

    bestScore = Math.max(bestScore, scoreCompactSubsequence(compact || bareSegment, keyword))
  } else {
    bestScore = Math.max(bestScore, scoreCompactSubsequence(bareSegment || normalizedSegment, keyword))
  }

  return bestScore
}

function scoreWorkspaceMatch(relativePath = '', query = '') {
  const normalizedPath = toPosixPath(relativePath)
  const keyword = String(query || '').trim().toLowerCase()

  if (!normalizedPath || !keyword) {
    return 0
  }

  const pathScore = scorePathMatch(normalizedPath, keyword)
  if (keyword.includes('/')) {
    return pathScore
  }

  const segments = normalizedPath.split('/').filter(Boolean)
  const fileName = segments.at(-1) || normalizedPath
  const nameScore = scoreSegmentMatch(fileName, keyword, { isFileName: true })
  const segmentScore = segments.reduce((bestScore, segment, index) => Math.max(
    bestScore,
    scoreSegmentMatch(segment, keyword, { isFileName: index === segments.length - 1 })
  ), 0)

  return Math.max(pathScore, nameScore, segmentScore)
}

function isSearchableTextFile(relativePath = '', absolutePath = '', stats = null) {
  if (isKnownTextFilePath(relativePath, absolutePath)) {
    return true
  }

  const sampleSize = Math.min(Number(stats?.size || 0), 8192)
  if (sampleSize <= 0) {
    return true
  }

  try {
    const sample = readFileSlice(absolutePath, sampleSize)
    return !isLikelyBinaryBuffer(sample)
  } catch {
    return false
  }
}

function createContentSearchPreview(line = '', matchIndex = 0, matchLength = 0, maxLength = 180) {
  const source = String(line || '')
  if (!source) {
    return ''
  }

  const safeMatchIndex = Math.max(0, Number(matchIndex) || 0)
  const safeMatchLength = Math.max(1, Number(matchLength) || 1)
  if (source.length <= maxLength) {
    return source
  }

  const padding = Math.max(24, Math.floor((maxLength - safeMatchLength) / 2))
  const start = Math.max(0, safeMatchIndex - padding)
  const end = Math.min(source.length, safeMatchIndex + safeMatchLength + padding)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < source.length ? '…' : ''

  return `${prefix}${source.slice(start, end)}${suffix}`
}

export function listWorkspaceTree(workspacePath, options = {}) {
  const target = resolveWorkspaceTarget(workspacePath, options.path)
  const type = getPathType(target.absolutePath)

  if (!type) {
    throw createApiError('errors.targetPathNotFound', '目标路径不存在。', 404)
  }

  if (type !== 'directory') {
    throw createApiError('errors.directoryExpandOnly', '只能展开目录。')
  }

  const limit = clampLimit(options.limit, DEFAULT_TREE_LIMIT, 500)
  const entries = fs.readdirSync(target.absolutePath, { withFileTypes: true })
    .filter((entry) => !shouldIgnoreDirectory(entry))
    .map((entry) => buildWorkspaceItem(target.root, path.join(target.absolutePath, entry.name), entry))
    .sort(compareWorkspaceEntries)

  return {
    cwd: target.root,
    path: target.relativePath,
    parentPath: target.relativePath.includes('/')
      ? target.relativePath.slice(0, target.relativePath.lastIndexOf('/'))
      : '',
    items: entries.slice(0, limit),
    truncated: entries.length > limit,
  }
}

export function searchWorkspaceEntries(workspacePath, options = {}) {
  const root = path.resolve(String(workspacePath || ''))
  const query = String(options.query || '').trim()
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, 200)

  if (!query) {
    return {
      cwd: root,
      query: '',
      items: [],
      truncated: false,
    }
  }

  const matches = []
  let visited = 0
  let truncated = false
  const stack = ['']

  while (stack.length) {
    const currentRelativePath = stack.pop()
    const currentAbsolutePath = currentRelativePath
      ? path.join(root, currentRelativePath)
      : root

    let entries = []
    try {
      entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry)) {
        continue
      }

      visited += 1
      if (visited > MAX_SEARCH_VISITS) {
        truncated = true
        stack.length = 0
        break
      }

      const relativePath = currentRelativePath
        ? `${toPosixPath(currentRelativePath)}/${entry.name}`
        : entry.name
      const absolutePath = path.join(currentAbsolutePath, entry.name)
      const type = entry.isDirectory() ? 'directory' : 'file'
      const score = scoreWorkspaceMatch(relativePath, query)

      if (score > 0) {
        matches.push({
          ...buildWorkspaceItem(root, absolutePath, entry, type),
          score,
        })
      }

      if (entry.isDirectory()) {
        stack.push(path.join(currentRelativePath, entry.name))
      }
    }
  }

  matches.sort((left, right) => {
    const scoreDiff = right.score - left.score
    if (scoreDiff) {
      return scoreDiff
    }

    const typeDiff = Number(left.type !== 'directory') - Number(right.type !== 'directory')
    if (typeDiff) {
      return typeDiff
    }

    const pathLengthDiff = left.path.length - right.path.length
    if (pathLengthDiff) {
      return pathLengthDiff
    }

    return left.path.localeCompare(right.path, 'zh-CN')
  })

  return {
    cwd: root,
    query,
    items: matches.slice(0, limit).map(({ score, ...item }) => item),
    truncated: truncated || matches.length > limit,
  }
}

export function searchWorkspaceFileContent(workspacePath, options = {}) {
  const root = path.resolve(String(workspacePath || ''))
  const query = String(options.query || '').trim()
  const limit = clampLimit(options.limit, DEFAULT_CONTENT_SEARCH_LIMIT, 200)

  if (!query) {
    return {
      cwd: root,
      query: '',
      items: [],
      truncated: false,
    }
  }

  const normalizedQuery = query.toLowerCase()
  const matches = []
  let visited = 0
  let truncated = false
  const stack = ['']

  while (stack.length) {
    const currentRelativePath = stack.pop()
    const currentAbsolutePath = currentRelativePath
      ? path.join(root, currentRelativePath)
      : root

    let entries = []
    try {
      entries = fs.readdirSync(currentAbsolutePath, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

    for (const entry of entries) {
      if (shouldIgnoreDirectory(entry)) {
        continue
      }

      visited += 1
      if (visited > MAX_SEARCH_VISITS) {
        truncated = true
        stack.length = 0
        break
      }

      const relativePath = currentRelativePath
        ? `${toPosixPath(currentRelativePath)}/${entry.name}`
        : entry.name
      const absolutePath = path.join(currentAbsolutePath, entry.name)

      if (entry.isDirectory()) {
        stack.push(path.join(currentRelativePath, entry.name))
        continue
      }

      let stats
      try {
        stats = fs.statSync(absolutePath)
      } catch {
        continue
      }

      if (!stats.isFile() || stats.size > MAX_CONTENT_SEARCH_FILE_BYTES) {
        continue
      }

      if (!isSearchableTextFile(relativePath, absolutePath, stats)) {
        continue
      }

      let content = ''
      try {
        content = fs.readFileSync(absolutePath, 'utf8').replace(/\r\n/g, '\n')
      } catch {
        continue
      }

      const lines = content.split('\n')
      let fileMatchCount = 0

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
        const line = String(lines[lineIndex] || '')
        const normalizedLine = line.toLowerCase()
        const matchIndex = normalizedLine.indexOf(normalizedQuery)
        if (matchIndex < 0) {
          continue
        }

        matches.push({
          name: path.basename(relativePath),
          path: toPosixPath(relativePath),
          type: 'file',
          line: lineIndex + 1,
          column: matchIndex + 1,
          preview: createContentSearchPreview(line, matchIndex, normalizedQuery.length),
        })
        fileMatchCount += 1

        if (matches.length >= limit) {
          truncated = true
          stack.length = 0
          break
        }

        if (fileMatchCount >= MAX_CONTENT_MATCHES_PER_FILE) {
          truncated = true
          break
        }

        if (truncated) {
          break
        }
      }

      if (truncated) {
        break
      }
    }
  }

  matches.sort((left, right) => (
    left.path.localeCompare(right.path, 'zh-CN')
    || left.line - right.line
    || left.column - right.column
  ))

  return {
    cwd: root,
    query,
    items: matches.slice(0, limit),
    truncated: truncated || matches.length > limit,
  }
}

export function readWorkspaceFileContent(workspacePath, options = {}) {
  const target = resolveWorkspaceTarget(workspacePath, options.path)
  const previewLimit = clampLimit(options.limit, DEFAULT_FILE_PREVIEW_LIMIT, DEFAULT_FILE_PREVIEW_LIMIT)
  const fileName = path.basename(target.absolutePath)

  let stats
  try {
    stats = fs.statSync(target.absolutePath)
  } catch {
    throw createApiError('errors.fileNotFound', '文件不存在。', 404)
  }

  if (!stats.isFile()) {
    throw createApiError('errors.fileOnly', '只能读取文件内容。')
  }

  let language = getFileLanguage(target.relativePath, target.absolutePath)
  const imageMimeType = getImageMimeType(target.relativePath, target.absolutePath)
  const basePayload = {
    cwd: target.root,
    name: fileName,
    path: target.relativePath,
    type: 'file',
    language,
    size: stats.size,
    binary: false,
    truncated: false,
    tooLarge: false,
    content: '',
    mimeType: imageMimeType || '',
    previewUrl: '',
  }

  if (imageMimeType) {
    if (stats.size > MAX_IMAGE_PREVIEW_BYTES) {
      return {
        ...basePayload,
        binary: true,
        tooLarge: true,
      }
    }

    const buffer = fs.readFileSync(target.absolutePath)
    return {
      ...basePayload,
      binary: true,
      previewUrl: `data:${imageMimeType};base64,${buffer.toString('base64')}`,
    }
  }

  const sliceLength = Math.min(stats.size, previewLimit)
  const buffer = readFileSlice(target.absolutePath, sliceLength)
  const extension = path.extname(fileName).toLowerCase()
  const isKnownTextFile = TEXT_FILE_EXTENSIONS.has(extension)
  const binary = !isKnownTextFile && isLikelyBinaryBuffer(buffer)
  language = language || getShebangLanguage(buffer)

  if (binary) {
    return {
      ...basePayload,
      binary: true,
    }
  }

  return {
    ...basePayload,
    language,
    content: buffer.toString('utf8').replace(/\r\n/g, '\n'),
    truncated: stats.size > previewLimit,
    tooLarge: stats.size > previewLimit,
  }
}

export function readWorkspaceFileBlame(workspacePath, options = {}) {
  const target = resolveWorkspaceTarget(workspacePath, options.path)

  let stats
  try {
    stats = fs.statSync(target.absolutePath)
  } catch {
    throw createApiError('errors.fileNotFound', '文件不存在。', 404)
  }

  if (!stats.isFile()) {
    throw createApiError('errors.fileOnly', '只能读取文件内容。')
  }

  if (stats.size > DEFAULT_FILE_PREVIEW_LIMIT) {
    return createWorkspaceUnavailablePayload(target, 'too_large', '文件较大，暂不加载行作者信息。')
  }

  const previewBuffer = readFileSlice(target.absolutePath, Math.min(stats.size, DEFAULT_FILE_PREVIEW_LIMIT))
  const extension = path.extname(path.basename(target.absolutePath)).toLowerCase()
  const isKnownTextFile = TEXT_FILE_EXTENSIONS.has(extension)
  if (!isKnownTextFile && isLikelyBinaryBuffer(previewBuffer)) {
    return createWorkspaceUnavailablePayload(target, 'binary', '当前文件为二进制内容，暂不加载行作者信息。')
  }

  const fileLineCount = getFileLineCount(target.absolutePath)
  if (fileLineCount > DEFAULT_FILE_BLAME_LINE_LIMIT) {
    return createWorkspaceUnavailablePayload(target, 'too_many_lines', '文件行数较多，暂不加载行作者信息。')
  }

  const gitCheck = runGit(target.root, ['rev-parse', '--is-inside-work-tree'])
  if (gitCheck.status !== 0 || String(gitCheck.stdout || '').trim() !== 'true') {
    return createWorkspaceUnavailablePayload(target, 'not_git', '当前目录不是 Git 仓库。')
  }

  const blame = runGit(target.root, [
    'blame',
    '--line-porcelain',
    '--',
    target.relativePath,
  ])

  if (blame.timedOut) {
    return createWorkspaceUnavailablePayload(target, 'timeout', '行作者信息加载超时。')
  }

  if (blame.status !== 0) {
    const stderr = String(blame.stderr || '').trim()
    if (/no such path|no such file|not in HEAD|fatal: no such/i.test(stderr)) {
      return createWorkspaceUnavailablePayload(target, 'untracked', '当前文件尚未被 Git 跟踪。')
    }

    return createWorkspaceUnavailablePayload(target, 'failed', stderr || '行作者信息加载失败。')
  }

  return {
    cwd: target.root,
    path: target.relativePath,
    supported: true,
    reason: '',
    message: '',
    items: parseGitBlamePorcelain(blame.stdout),
  }
}

export function listDirectoryPickerTree(options = {}) {
  const isRootRequest = !String(options.path || '').trim()
  const targetPath = normalizeDirectoryPickerPath(options.path) || getDirectoryPickerHomePath()

  const limit = clampLimit(options.limit, DIRECTORY_PICKER_LIMIT, 600)
  const entries = fs.readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !shouldIgnorePickerDirectory(entry))
    .map((entry) => createDirectoryPickerItem(path.join(targetPath, entry.name), entry.name))
    .sort(compareDirectoryEntries)

  return {
    path: targetPath,
    parentPath: getDirectoryParentPath(targetPath),
    roots: isRootRequest ? getDirectoryPickerRootItems(targetPath) : undefined,
    items: entries.slice(0, limit),
    truncated: entries.length > limit,
  }
}

function scoreDirectoryPickerMatch(directoryPath = '', basePath = '', query = '') {
  const normalizedQuery = String(query || '').trim().toLowerCase()
  if (!directoryPath || !normalizedQuery) {
    return 0
  }

  const absoluteScore = scoreWorkspaceMatch(toPosixPath(directoryPath), normalizedQuery)
  const base = String(basePath || '').trim()
  const relativePath = base ? toPosixPath(path.relative(base, directoryPath)) : toPosixPath(directoryPath)
  const relativeScore = scoreWorkspaceMatch(relativePath, normalizedQuery)
  const nameScore = scoreSegmentMatch(path.basename(directoryPath), normalizedQuery, { isFileName: false })
  return Math.max(absoluteScore, relativeScore, nameScore)
}

export function searchDirectoryPickerEntries(options = {}) {
  const query = String(options.query || '').trim()
  const limit = clampLimit(options.limit, DEFAULT_SEARCH_LIMIT, 200)

  if (!query) {
    return {
      path: '',
      query: '',
      items: [],
      truncated: false,
    }
  }

  const targetPath = normalizeDirectoryPickerPath(options.path) || getDirectoryPickerHomePath()
  const roots = [targetPath]
  const matches = []
  let visited = 0
  let truncated = false

  for (const rootPath of roots) {
    const stack = [rootPath]

    while (stack.length) {
      const currentPath = stack.pop()
      let entries = []

      try {
        entries = fs.readdirSync(currentPath, { withFileTypes: true })
      } catch {
        continue
      }

      entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))

      for (const entry of entries) {
        if (!entry.isDirectory() || shouldIgnorePickerDirectory(entry)) {
          continue
        }

        visited += 1
        if (visited > MAX_SEARCH_VISITS) {
          truncated = true
          stack.length = 0
          break
        }

        const absolutePath = path.join(currentPath, entry.name)
        const score = scoreDirectoryPickerMatch(absolutePath, rootPath, query)
        if (score > 0) {
          matches.push({
            ...createDirectoryPickerItem(absolutePath, entry.name),
            score,
          })
        }

        stack.push(absolutePath)
      }

      if (truncated) {
        break
      }
    }

    if (truncated) {
      break
    }
  }

  matches.sort((left, right) => {
    const scoreDiff = right.score - left.score
    if (scoreDiff) {
      return scoreDiff
    }

    const depthDiff = left.path.split(path.sep).length - right.path.split(path.sep).length
    if (depthDiff) {
      return depthDiff
    }

    return String(left.path || '').localeCompare(String(right.path || ''), 'zh-CN')
  })

  return {
    path: targetPath,
    query,
    items: matches.slice(0, limit).map(({ score, ...item }) => item),
    truncated: truncated || matches.length > limit,
  }
}
