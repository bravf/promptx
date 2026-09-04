import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const CODEX_BIN = process.env.CODEX_BIN || 'codex'
export const MIN_PAGINATED_RESUME_VERSION = '0.153.2'

export function parseCodexCliVersion(output = '') {
  return String(output).match(/\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/)?.[1] || ''
}

export async function readCodexCliVersion(command = CODEX_BIN) {
  try {
    const { stdout, stderr } = await execFileAsync(command, ['--version'], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    })
    return parseCodexCliVersion(stdout || stderr)
  } catch {
    return ''
  }
}

export async function createPaginatedResumeError() {
  const version = await readCodexCliVersion()
  const current = version ? `当前安装的是 ${version}` : '无法读取当前安装版本'
  const error = new Error(
    `该会话使用 Codex Desktop 的分页历史，${current}，无法继续运行。请将 Codex CLI 升级到 ${MIN_PAGINATED_RESUME_VERSION} 或更高版本。`,
  )
  error.code = 'codex_paginated_resume_unsupported'
  error.statusCode = 409
  return error
}
