import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveExistingDirectory } from '../paths/canonicalPath.js'

const execFileAsync = promisify(execFile)
const PICKER_TITLE = '选择工作区目录'

const MACOS_SCRIPT = `
set initialPath to system attribute "PROMPTX_PICKER_INITIAL_PATH"
try
  if initialPath is "" then
    set selectedFolder to choose folder with prompt "${PICKER_TITLE}"
  else
    set selectedFolder to choose folder with prompt "${PICKER_TITLE}" default location POSIX file initialPath
  end if
  return POSIX path of selectedFolder
on error number -128
  return ""
end try
`.trim()

const WINDOWS_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${PICKER_TITLE}'
$dialog.ShowNewFolderButton = $true
if (Test-Path -LiteralPath $env:PROMPTX_PICKER_INITIAL_PATH -PathType Container) {
  $dialog.SelectedPath = $env:PROMPTX_PICKER_INITIAL_PATH
}
$result = $dialog.ShowDialog()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  Write-Output $dialog.SelectedPath
}
$dialog.Dispose()
`.trim()

function pickerUnavailable(message) {
  const error = new Error(message)
  error.code = 'directory_picker_unavailable'
  error.statusCode = 501
  return error
}

function nearestExistingDirectory(value) {
  let candidate = String(value || '').trim()
  if (!candidate) return os.homedir()
  candidate = path.resolve(candidate)
  while (candidate) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate
    } catch {
      // Continue with the nearest existing parent.
    }
    const parent = path.dirname(candidate)
    if (parent === candidate) break
    candidate = parent
  }
  return os.homedir()
}

function commandOptions(initialPath) {
  return {
    encoding: 'utf8',
    maxBuffer: 64 * 1024,
    windowsHide: true,
    env: { ...process.env, PROMPTX_PICKER_INITIAL_PATH: initialPath },
  }
}

function isMissingCommand(error) {
  return error?.code === 'ENOENT' || error?.code === 127
}

function isLinuxDisplayError(error) {
  return /cannot open display|could not connect to display|no display|qt\.qpa|display is not set/i
    .test(`${error?.stderr || ''}\n${error?.message || ''}`)
}

function isCanceled(error) {
  return error?.code === 1 || error?.code === 255
}

async function resolveSelection(command, args, initialPath, runCommand) {
  const result = await runCommand(command, args, commandOptions(initialPath))
  const selectedPath = String(result?.stdout || '').trim()
  if (!selectedPath) return { canceled: true, path: null }
  return { canceled: false, path: resolveExistingDirectory(selectedPath) }
}

export async function pickDirectory(options = {}) {
  const platform = options.platform || process.platform
  const runCommand = options.runCommand || execFileAsync
  const initialPath = nearestExistingDirectory(options.initialPath)

  try {
    if (platform === 'darwin') {
      return await resolveSelection('osascript', ['-e', MACOS_SCRIPT], initialPath, runCommand)
    }
    if (platform === 'win32') {
      return await resolveSelection('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', WINDOWS_SCRIPT,
      ], initialPath, runCommand)
    }
    if (platform === 'linux') {
      const attempts = [
        ['zenity', ['--file-selection', '--directory', `--title=${PICKER_TITLE}`, `--filename=${initialPath}${path.sep}`]],
        ['kdialog', ['--getexistingdirectory', initialPath, '--title', PICKER_TITLE]],
      ]
      for (const [command, args] of attempts) {
        try {
          return await resolveSelection(command, args, initialPath, runCommand)
        } catch (error) {
          if (isMissingCommand(error) || isLinuxDisplayError(error)) continue
          if (isCanceled(error)) return { canceled: true, path: null }
          throw error
        }
      }
      throw pickerUnavailable('Linux 桌面未安装可用的目录选择器，请安装 zenity 或 kdialog，或手动输入路径。')
    }
  } catch (error) {
    if (error?.code === 'directory_picker_unavailable') throw error
    if (isCanceled(error)) return { canceled: true, path: null }
    if (isMissingCommand(error)) {
      throw pickerUnavailable('当前系统缺少可用的目录选择器，请手动输入路径。')
    }
    throw error
  }

  throw pickerUnavailable(`当前系统不支持目录选择器：${platform}`)
}
