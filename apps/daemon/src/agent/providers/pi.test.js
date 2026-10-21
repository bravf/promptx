import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter, once } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { PiRuntime } from './pi.js'
import { mapPiHistorySnapshot, readPiHistorySnapshot } from '../history/providers/piHistory.js'
import { listPiHistorySessions } from '../history/providers/piSessions.js'
import { piProvider } from './pi.js'
import { TimelineItemSchema } from '../../../../../packages/protocol/src/timeline.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function fixture(overrides = {}) {
  const commands = [], launches = []
  let model = { provider: 'deepseek', id: 'test/model', name: '测试模型' }
  let effort = 'high'
  let child
  const runtime = new PiRuntime({ cwd: '/tmp', ...overrides, spawnProcess(command, args, options) {
    launches.push({ command, args, options })
    child = new EventEmitter()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.exitCode = null
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0) }
    child.stdin = new Writable({ write(chunk, _encoding, callback) {
      const frame = JSON.parse(chunk)
      commands.push(frame)
      let data = {}
      if (frame.type === 'get_state') data = { sessionId: 'session-1', sessionFile: '/tmp/pi-session.jsonl', model, thinkingLevel: effort }
      if (frame.type === 'get_available_models') data = { models: [model] }
      if (frame.type === 'get_available_thinking_levels') data = { levels: ['off', 'high'] }
      if (frame.type === 'get_session_stats') data = { contextUsage: { tokens: 100, contextWindow: 1000 } }
      if (frame.type === 'set_model') model = { provider: frame.provider, id: frame.modelId }
      if (frame.type === 'set_thinking_level') effort = frame.level
      queueMicrotask(() => child.stdout.write(`${JSON.stringify({ type: 'response', id: frame.id, success: true, data })}\n`))
      callback()
    } })
    return child
  } })
  return {
    runtime, commands, launches,
    get child() { return child },
    send: event => child.stdout.write(`${JSON.stringify(event)}\n`),
    raw: data => child.stdout.write(data),
  }
}

test('Pi 从 RPC 获取真实模型、思考档位、上下文和会话路径', async () => {
  const { runtime, launches } = fixture()
  try {
    const control = await runtime.getControlState()
    assert.equal(control.currentModelId, 'deepseek/test/model')
    assert.deepEqual(control.reasoningEfforts.map(item => item.id), ['off', 'high'])
    assert.equal(control.contextUsage.percentage, 10)
    assert.equal(runtime.sessionFile, '/tmp/pi-session.jsonl')
    assert.equal(launches[0].options.cwd, '/tmp')
    assert.ok(launches[0].args.includes('--session-id'))
  } finally { runtime.close() }
})

test('Pi 使用持久化路径恢复，模型 id 保留斜杠', async () => {
  const { runtime, launches, commands } = fixture({ nativeHandle: { sessionFile: '/tmp/old.jsonl' } })
  try {
    await runtime.updateSettings({ modelId: 'deepseek/nested/model', reasoningEffort: 'off' })
    assert.deepEqual(launches[0].args, ['--mode', 'rpc', '--session', '/tmp/old.jsonl'])
    assert.ok(commands.some(item => item.type === 'set_model' && item.modelId === 'nested/model'))
    assert.equal(runtime.controlState.currentReasoningEffort, 'off')
  } finally { runtime.close() }
})

test('Pi 接受 prompt 和 agent_end 均不提前结束，agent_settled 只结束一次', async () => {
  const { runtime, send } = fixture()
  const completed = []
  runtime.on('turnCompleted', event => completed.push(event))
  try {
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'turn-1')
    send({ type: 'agent_end', willRetry: true })
    assert.equal(completed.length, 0)
    send({ type: 'agent_settled' })
    send({ type: 'agent_settled' })
    assert.equal(completed.length, 1)
    assert.equal(completed[0].runId, 'turn-1')
  } finally { runtime.close() }
})

test('Pi 流式文本、思考、工具结果满足 Timeline 协议且不重复追加最终消息', async () => {
  const { runtime, send, raw } = fixture()
  const items = []
  runtime.on('timeline', item => items.push(TimelineItemSchema.parse(item)))
  try {
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'turn-2')
    send({ type: 'message_start', message: { role: 'assistant' } })
    const frame = Buffer.from(JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好\u2028世界' } }) + '\n')
    const cut = frame.indexOf(Buffer.from('你')) + 1
    raw(frame.subarray(0, cut)); raw(frame.subarray(cut))
    send({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '思考' } })
    send({ type: 'tool_execution_start', toolCallId: 'read-1', toolName: 'read', args: { path: 'README.md' } })
    send({ type: 'tool_execution_end', toolCallId: 'read-1', toolName: 'read', result: { content: [{ type: 'text', text: '内容' }] } })
    send({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '你好\u2028世界' }] } })
    assert.equal(items[0].text, '你好\u2028世界')
    assert.deepEqual(items.map(item => item.type), ['assistant_message', 'reasoning', 'tool_call', 'tool_call'])
    assert.equal(items[3].detail.rawInput.path, 'README.md')
    assert.equal(items[3].status, 'completed')
  } finally { runtime.close() }
})

test('Pi 取消等待最终 settled，模型错误标记失败', async () => {
  const { runtime, send } = fixture()
  try {
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'cancel')
    const canceled = once(runtime, 'turnCanceled')
    await runtime.cancel()
    assert.equal(runtime.activeRunId, 'cancel')
    send({ type: 'agent_settled' })
    assert.equal((await canceled)[0].runId, 'cancel')
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'failure')
    const failed = once(runtime, 'turnFailed')
    send({ type: 'message_end', message: { role: 'assistant', stopReason: 'error', errorMessage: '无效 API Key' } })
    send({ type: 'agent_settled' })
    assert.match((await failed)[0].message, /无效 API Key/)
  } finally { runtime.close() }
})

test('Pi 主动关闭不报告运行时崩溃，意外退出则失败当前任务', async () => {
  const intentional = fixture()
  let intentionalExits = 0
  intentional.runtime.on('runtimeExit', () => intentionalExits++)
  await intentional.runtime.prepareTurn()
  intentional.runtime.close()
  assert.equal(intentionalExits, 0)
  assert.equal(intentional.runtime.child, null)

  const unexpected = fixture()
  let unexpectedExits = 0
  unexpected.runtime.on('runtimeExit', () => unexpectedExits++)
  await unexpected.runtime.startTurn([{ type: 'text', text: '测试' }], 'crash')
  const failed = once(unexpected.runtime, 'turnFailed')
  unexpected.child.emit('exit', 1, null)
  assert.match((await failed)[0].message, /Pi 进程已退出/)
  assert.equal(unexpectedExits, 1)
  unexpected.runtime.close()
})

test('Pi JSONL 历史映射用户、思考、工具结果与终态，并支持增量快照', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-pi-history-'))
  const file = path.join(dir, 'session.jsonl')
  const rows = [
    { type: 'session', id: 'session-1', timestamp: '2026-10-21T00:00:00.000Z' },
    { type: 'message', id: 'user-1', parentId: null, timestamp: '2026-10-21T00:00:01.000Z', message: { role: 'user', content: '读取文件' } },
    { type: 'message', id: 'assistant-1', parentId: 'user-1', timestamp: '2026-10-21T00:00:02.000Z', message: { role: 'assistant', id: 'assistant-1', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: '先调用工具' }, { type: 'toolCall', id: 'call-1', name: 'read', arguments: { path: 'package.json' } }] } },
    { type: 'message', id: 'tool-1', parentId: 'assistant-1', timestamp: '2026-10-21T00:00:03.000Z', message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'read', content: [{ type: 'text', text: '内容' }], isError: false } },
    { type: 'message', id: 'assistant-2', parentId: 'tool-1', timestamp: '2026-10-21T00:00:04.000Z', message: { role: 'assistant', id: 'assistant-2', stopReason: 'stop', content: [{ type: 'text', text: '完成' }] } },
  ]
  try {
    fs.writeFileSync(file, `${rows.map(row => JSON.stringify(row)).join('\n')}\n`)
    const first = readPiHistorySnapshot({ sessionId: 'session-1', sessionFile: file })
    assert.equal(first.turns[0].status, 'completed')
    assert.deepEqual(first.turns[0].items.map(row => row.item.type), ['user_message', 'reasoning', 'tool_call', 'assistant_message'])
    assert.equal(first.turns[0].items[2].item.status, 'completed')
    for (const row of first.turns[0].items) TimelineItemSchema.parse(row.item)
    assert.equal(readPiHistorySnapshot({ sessionId: 'session-1', sessionFile: file, knownRevision: first.revision }).status, 'unchanged')
    const extra = { type: 'message', id: 'user-2', parentId: 'assistant-2', timestamp: '2026-10-21T00:00:05.000Z', message: { role: 'user', content: '第二轮' } }
    fs.appendFileSync(file, `${JSON.stringify(extra)}\n`)
    const incremental = readPiHistorySnapshot({ sessionId: 'session-1', sessionFile: file, knownRevision: first.revision, cursor: first.cursor })
    assert.equal(incremental.completeness, 'incremental')
    assert.equal(incremental.turns[0].sourceTurnId, 'user-2')
    assert.equal(mapPiHistorySnapshot('session-1', `${JSON.stringify(rows[0])}\n${JSON.stringify(rows[1])}\n`).turns[0].status, 'running')
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('Pi 导入列表扫描默认及自定义目录并保留恢复文件路径', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-pi-sessions-'))
  const home = path.join(root, 'home')
  const agentDir = path.join(home, '.pi', 'agent')
  const customDir = path.join(root, 'custom-sessions')
  const defaultSession = path.join(agentDir, 'sessions', 'default', 'session.jsonl')
  const customSession = path.join(customDir, 'session.jsonl')
  fs.mkdirSync(path.dirname(defaultSession), { recursive: true })
  fs.mkdirSync(customDir, { recursive: true })
  const records = (id, cwd, name, prompt) => [
    { type: 'session', version: 3, id, timestamp: '2026-10-21T00:00:00.000Z', cwd },
    ...(name ? [{ type: 'session_info', name }] : []),
    { type: 'message', id: `${id}-user`, timestamp: '2026-10-21T00:00:01.000Z', message: { role: 'user', content: prompt } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n'
  try {
    fs.writeFileSync(defaultSession, records('pi-default', '/workspace/default', '默认 Pi 标题', '读取 package.json'))
    fs.writeFileSync(customSession, records('pi-custom', '/workspace/custom', '', '检查自定义目录'))
    const sessions = listPiHistorySessions([], { env: { PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: customDir }, homeDir: home })
    assert.equal(sessions.length, 2)
    const standard = sessions.find(session => session.providerHandleId === 'pi-default')
    assert.equal(standard.title, '默认 Pi 标题')
    assert.equal(standard.firstPromptPreview, '读取 package.json')
    assert.equal(standard.cwd, '/workspace/default')
    assert.equal(standard.sessionFile, defaultSession)
    const custom = sessions.find(session => session.providerHandleId === 'pi-custom')
    assert.equal(custom.title, '检查自定义目录')
    assert.deepEqual(piProvider.createImportOptions(custom), {
      nativeHandle: { sessionId: 'pi-custom', sessionFile: customSession },
    })
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Pi 扩展选择请求通过现有问答界面返回原始选项', async () => {
  const { runtime, send, commands } = fixture()
  try {
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'question')
    send({ type: 'extension_ui_request', id: 'q-1', method: 'select', title: '选择', options: ['甲', '乙'] })
    const [question] = runtime.interactions.requests
    runtime.interactions.answer(question.id, { decision: 'answer', answers: { answer: { optionIds: ['1'], text: '' } } })
    assert.ok(commands.some(item => item.type === 'extension_ui_response' && item.id === 'q-1' && item.value === '乙'))
  } finally { runtime.close() }
})
