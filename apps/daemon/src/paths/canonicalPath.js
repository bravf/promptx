import fs from 'node:fs'
import path from 'node:path'

function isWindowsPath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(value)
}

function pathApi(value, platform) {
  return platform === 'win32' || isWindowsPath(value) ? path.win32 : path
}

function stripTrailingSeparators(value, api) {
  const root = api.parse(value).root
  return value === root ? value : value.replace(/[\\/]+$/, '')
}

export function canonicalPath(value, options = {}) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  const platform = options.platform || process.platform
  const api = pathApi(raw, platform)
  let resolved = api.resolve(raw)
  if (options.realpath !== false && platform === process.platform && fs.existsSync(resolved)) {
    resolved = fs.realpathSync.native(resolved)
  }
  return stripTrailingSeparators(api.normalize(resolved), api)
}

export function canonicalPathKey(value, options = {}) {
  const platform = options.platform || process.platform
  const raw = String(value || '').trim()
  const windows = platform === 'win32' || isWindowsPath(raw)
  const resolved = canonicalPath(raw, options)
  return windows ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

export function resolveExistingDirectory(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (!raw) {
    const error = new Error('请提供有效的目录路径。')
    error.statusCode = 400
    throw error
  }
  let resolved
  try {
    resolved = canonicalPath(raw)
    if (!fs.statSync(resolved).isDirectory()) {
      const error = new Error('工作区路径不是目录。')
      error.statusCode = 400
      throw error
    }
  } catch (error) {
    if (error.statusCode === 400) throw error
    const invalid = new Error('工作区路径不存在或无法访问。')
    invalid.statusCode = 400
    throw invalid
  }
  return resolved
}
