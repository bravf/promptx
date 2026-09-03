import assert from 'node:assert/strict'
import test from 'node:test'
import { AcpRuntime } from './acp.js'

test('ACP 命令不存在时拒绝连接，但不会触发未处理的子进程错误', async () => {
  const runtime = new AcpRuntime({
    cwd: process.cwd(),
    command: 'promptx-missing-acp-command-for-test',
    args: [],
  })

  await assert.rejects(runtime.getControlState(), (error) => error.code === 'ENOENT')
  runtime.close()
})
