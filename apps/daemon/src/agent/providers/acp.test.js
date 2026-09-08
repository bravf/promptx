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

test('Kimi 提交只使用 clientMessageId 标识消息，不伪造 Provider Turn ID', async () => {
  const runtime = new AcpRuntime({ cwd: process.cwd() })
  const started = []
  const requests = []
  runtime.sessionId = 'session-1'
  runtime.connect = async () => {}
  runtime.connection = {
    prompt(params) {
      requests.push(params)
      return Promise.resolve({ stopReason: 'end_turn', usage: {} })
    },
  }
  runtime.on('turnStarted', (event) => started.push(event))

  const result = await runtime.startTurn([{ type: 'text', text: '你好' }], 'browser-message-1')

  assert.deepEqual(result, {})
  assert.deepEqual(started, [undefined])
  assert.equal(requests[0].messageId, 'browser-message-1')
})
