import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const IGNORED_DIRECTORY_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.cache',
  '.next',
  '.nuxt',
  '.output',
  '.turbo',
  'build',
  'coverage',
  'dist',
  'Library',
  'node_modules',
  'tmp',
])

function clampLimit(value) {
  const limit = Number(value)
  if (!Number.isFinite(limit) || limit <= 0) return 20
  return Math.min(Math.floor(limit), 50)
}

function expandHome(value, homePath) {
  if (value === '~') return homePath
  if (value.startsWith(`~${path.sep}`) || value.startsWith('~/')) return path.join(homePath, value.slice(2))
  return value
}

async function isDirectory(directoryPath) {
  try {
    return (await fs.stat(directoryPath)).isDirectory()
  } catch {
    return false
  }
}

async function findClosestDirectory(input, fallback) {
  let candidate = path.resolve(input || fallback)
  while (!(await isDirectory(candidate))) {
    const parent = path.dirname(candidate)
    if (parent === candidate) return fallback
    candidate = parent
  }
  return candidate
}

function shouldIgnore(entry) {
  return !entry.isDirectory() || entry.name.startsWith('.') || IGNORED_DIRECTORY_NAMES.has(entry.name)
}

function scoreMatch(candidatePath, scanRoot, query) {
  if (!query) return 1
  const normalizedQuery = query.toLowerCase()
  const name = path.basename(candidatePath).toLowerCase()
  const relative = path.relative(scanRoot, candidatePath).replaceAll(path.sep, '/').toLowerCase()
  if (name === normalizedQuery) return 10000
  if (name.startsWith(normalizedQuery)) return 9000 - name.length
  if (relative.startsWith(normalizedQuery)) return 8000 - relative.length
  if (name.includes(normalizedQuery)) return 7000 - name.indexOf(normalizedQuery)
  if (relative.includes(normalizedQuery)) return 6000 - relative.indexOf(normalizedQuery)
  return 0
}

function toItem(directoryPath) {
  return {
    name: path.basename(directoryPath) || directoryPath,
    path: directoryPath,
  }
}

export async function searchDirectories(options = {}) {
  const homePath = path.resolve(options.homePath || os.homedir())
  const rootPath = await findClosestDirectory(options.rootPath || homePath, homePath)
  const rawQuery = String(options.query || '').trim()
  const expandedQuery = expandHome(rawQuery, homePath)
  const pathQuery = Boolean(expandedQuery && path.isAbsolute(expandedQuery))
  const requestedPath = pathQuery ? path.resolve(expandedQuery) : ''
  const exactDirectory = Boolean(requestedPath && await isDirectory(requestedPath))
  const limit = clampLimit(options.limit)
  const maxVisits = Math.max(limit, Number(options.maxVisits) || 12000)
  const maxDepth = Math.max(1, Number(options.maxDepth) || (pathQuery ? 3 : rawQuery ? 6 : 1))

  let scanRoot = rootPath
  let matchQuery = rawQuery
  const matches = []

  if (pathQuery) {
    if (exactDirectory) {
      scanRoot = requestedPath
      matchQuery = ''
      matches.push({ ...toItem(requestedPath), score: Number.MAX_SAFE_INTEGER })
    } else {
      scanRoot = await findClosestDirectory(path.dirname(requestedPath), rootPath)
      matchQuery = path.relative(scanRoot, requestedPath).replaceAll(path.sep, '/')
    }
  }

  const queue = [{ directoryPath: scanRoot, depth: 0 }]
  let visited = 0
  let truncated = false

  while (queue.length) {
    const current = queue.shift()
    let entries
    try {
      entries = await fs.readdir(current.directoryPath, { withFileTypes: true })
    } catch {
      continue
    }

    entries.sort((left, right) => left.name.localeCompare(right.name, 'zh-CN'))
    for (const entry of entries) {
      if (shouldIgnore(entry)) continue
      visited += 1
      if (visited > maxVisits) {
        truncated = true
        queue.length = 0
        break
      }

      const directoryPath = path.join(current.directoryPath, entry.name)
      const score = scoreMatch(directoryPath, scanRoot, matchQuery)
      if (score > 0) matches.push({ ...toItem(directoryPath), score })
      if (current.depth + 1 < maxDepth) queue.push({ directoryPath, depth: current.depth + 1 })
    }
  }

  matches.sort((left, right) => right.score - left.score || left.path.length - right.path.length || left.path.localeCompare(right.path, 'zh-CN'))
  const uniqueMatches = [...new Map(matches.map((item) => [item.path, item])).values()]

  return {
    query: rawQuery,
    root: scanRoot,
    items: uniqueMatches.slice(0, limit).map(({ score, ...item }) => item),
    truncated: truncated || uniqueMatches.length > limit,
  }
}
