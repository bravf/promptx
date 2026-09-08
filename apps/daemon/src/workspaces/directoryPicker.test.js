import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pickDirectory } from './directoryPicker.js'

function successfulRunner(calls) {
  return async (command, args, options) => {
    calls.push({ command, args, options })
    return { stdout: `${process.cwd()}\n`, stderr: '' }
  }
}

for (const [platform, expectedCommand] of [['darwin', 'osascript'], ['win32', 'powershell.exe'], ['linux', 'zenity']]) {
  test(`${platform} 使用系统目录选择器并返回规范路径`, async () => {
    const calls = []
    const result = await pickDirectory({ platform, initialPath: process.cwd(), runCommand: successfulRunner(calls) })
    assert.equal(result.canceled, false)
    assert.equal(result.path, process.cwd())
    assert.equal(calls[0].command, expectedCommand)
    assert.equal(calls[0].options.env.PROMPTX_PICKER_INITIAL_PATH, process.cwd())
  })
}

test('Linux 在 zenity 不存在时回退到 kdialog', async () => {
  const commands = []
  const result = await pickDirectory({
    platform: 'linux',
    runCommand: async (command) => {
      commands.push(command)
      if (command === 'zenity') {
        const error = new Error('spawn zenity ENOENT')
        error.code = 'ENOENT'
        throw error
      }
      return { stdout: process.cwd(), stderr: '' }
    },
  })
  assert.deepEqual(commands, ['zenity', 'kdialog'])
  assert.equal(result.path, process.cwd())
})

test('取消系统目录选择不会被当作错误', async () => {
  const result = await pickDirectory({
    platform: 'linux',
    runCommand: async () => {
      const error = new Error('用户取消')
      error.code = 1
      throw error
    },
  })
  assert.deepEqual(result, { canceled: true, path: null })
})

test('Linux 没有图形目录选择器时返回可操作的错误', async () => {
  await assert.rejects(() => pickDirectory({
    platform: 'linux',
    runCommand: async () => {
      const error = new Error('command not found')
      error.code = 'ENOENT'
      throw error
    },
  }), (error) => error.code === 'directory_picker_unavailable' && error.statusCode === 501)
})
