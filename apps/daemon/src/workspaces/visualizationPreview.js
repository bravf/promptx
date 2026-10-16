import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WorkspaceInspectionError } from './workspaceInspection.js'

export const MAX_VISUALIZATION_BYTES = 1024 * 1024
const fail = (code, message, status = 400) => { throw new WorkspaceInspectionError(code, message, status) }
const within = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

export function readVisualization(cwd, input, { codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), authorizeExternal = () => false } = {}) {
  if (typeof input !== 'string' || !input.trim() || input.length > 4096 || /[\u0000-\u001f]/.test(input)) fail('invalid_path', '图表路径无效。')
  if (!/\.html?$/i.test(input)) fail('unsupported_visualization', '仅支持 HTML 图表文件。')
  try {
    const root = fs.realpathSync(cwd)
    const candidate = path.resolve(root, input)
    let allowedRoot = root
    if (!within(root, candidate)) {
      const externalRoot = path.resolve(codexHome, 'visualizations')
      if (!path.isAbsolute(input) || !within(externalRoot, candidate) || !authorizeExternal(input)) fail('visualization_forbidden', '只能预览工作区内或当前会话引用的 Codex 图表。', 403)
      allowedRoot = fs.realpathSync(externalRoot)
    }
    const target = fs.realpathSync(candidate)
    if (!within(allowedRoot, target) || !/\.html?$/i.test(target)) fail('visualization_forbidden', '图表真实路径超出了允许范围。', 403)
    const fd = fs.openSync(target, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK)
    try {
      const stat = fs.fstatSync(fd)
      if (!stat.isFile()) fail('unsupported_visualization', '图表路径必须是普通文件。')
      if (stat.size > MAX_VISUALIZATION_BYTES) fail('visualization_too_large', '图表文件超过 1 MiB，无法预览。', 413)
      // 有界读取也覆盖读取期间文件增长的情况，避免大文件占满 Relay。
      const bytes = Buffer.alloc(MAX_VISUALIZATION_BYTES + 1)
      let size = 0
      while (size < bytes.length) {
        const count = fs.readSync(fd, bytes, size, bytes.length - size, null)
        if (!count) break
        size += count
      }
      if (size > MAX_VISUALIZATION_BYTES) fail('visualization_too_large', '图表文件超过 1 MiB，无法预览。', 413)
      let html
      try { html = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) } catch { fail('invalid_visualization', '图表文件不是有效的 UTF-8 文本。') }
      if (!html.trim() || html.includes('\0')) fail('invalid_visualization', '图表文件为空或包含无效内容。')
      return { path: input, name: path.basename(target), html, size }
    } finally { fs.closeSync(fd) }
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) fail('visualization_not_found', '图表文件不存在或已被清理。', 404)
    if (['EACCES', 'EPERM', 'ELOOP'].includes(error.code)) fail('visualization_forbidden', '没有权限读取这个图表。', 403)
    throw error
  }
}
