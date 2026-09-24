import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AcpRuntime, createAcpProvider } from './acp.js'
import { grokProvider, GROK_ACP_ARGS } from './grok.js'
import { kimiProvider } from './kimi.js'
import { ProviderRegistry } from '../providerRegistry.js'
import { projectTimelineRows } from '../../../../../packages/protocol/src/timelineProjection.js'
import { mapGrokHistorySnapshot } from '../history/providers/grokHistorySnapshot.js'

test('ACP 跨模型切换先同步新选项，无强度模型清空旧值，切回后恢复并设置强度', async () => {
  const runtime = grokProvider.createRuntime()
  const options = (model, effort = 'high') => [
    { id: 'model', category: 'model', type: 'select', currentValue: model, options: ['thinking', 'build'].map(value => ({ value, name: value })) },
    ...(model === 'thinking' ? [{ id: 'effort', category: 'thought_level', type: 'select', currentValue: effort, options: ['low', 'high'].map(value => ({ value, name: value })) }] : []),
  ]
  runtime.sessionControls = {
    models: { currentModelId: 'thinking', availableModels: ['thinking', 'build'].map(modelId => ({ modelId })) },
    configOptions: options('thinking'),
  }
  runtime.refreshControlState()
  runtime.connected = true
  const requests = []
  runtime.connection = {
    unstable_setSessionModel: async () => assert.fail('有配置接口时不应使用旧版模型接口'),
    setSessionConfigOption: async ({ configId, value }) => {
      requests.push([configId, value])
      const configOptions = configId === 'model' ? options(value) : options('thinking', value)
      runtime.onSessionUpdate({ sessionUpdate: 'config_option_update', configOptions })
      return { configOptions }
    },
  }
  try {
    const build = await runtime.updateSettings({ modelId: 'build', reasoningEffort: 'low' })
    assert.equal(build.currentReasoningEffort, '')
    assert.deepEqual(build.reasoningEfforts, [])
    assert.deepEqual(requests, [['model', 'build']])
    const thinking = await runtime.updateSettings({ modelId: 'thinking', reasoningEffort: 'low' })
    assert.equal(thinking.currentModelId, 'thinking')
    assert.equal(thinking.currentReasoningEffort, 'low')
    assert.deepEqual(requests.slice(1), [['model', 'thinking'], ['effort', 'low']])
    runtime.connection.setSessionConfigOption = async () => { throw new Error('Provider 拒绝设置') }
    await assert.rejects(runtime.updateSettings({ reasoningEffort: 'high' }), /Provider 拒绝/)
    assert.equal(runtime.controlState.currentReasoningEffort, 'low')
  } finally { runtime.close() }
})

test('ACP 实时与 Grok 历史对同一工具事件序列生成相同结果', () => {
  const runtime = new AcpRuntime()
  let latest
  runtime.on('timeline', item => { latest = item })
  const updates = [
    { sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read', kind: 'read', rawInput: { path: 'a.js' }, locations: [{ path: 'a.js', line: 2 }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: '文件不可读' } }] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'read', rawInput: null },
  ]
  updates.forEach(update => runtime.onSessionUpdate(update))
  const records = [
    { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: '读取文件' } },
    ...updates,
    { sessionUpdate: 'turn_completed', stop_reason: 'end_turn' },
  ].map(update => JSON.stringify({ params: { update } })).join('\n')
  const item = mapGrokHistorySnapshot('s', records).turns[0].items.find(entry => entry.item.type === 'tool_call').item
  assert.deepEqual(item, latest)
  assert.equal(item.error.message, '文件不可读')
  assert.deepEqual(item.detail.locations, [{ path: 'a.js', line: 2 }])
  assert.equal(item.detail.rawInput, null)
  runtime.close()
})

test('ACP 默认不宣称可选能力，握手不支持恢复时不发送 loadSession', async () => {
  const provider = createAcpProvider({ id: 'minimal', label: 'Minimal', command: process.execPath })
  for (const key of ['resume', 'images', 'models', 'reasoningEffort', 'contextUsage']) assert.equal(provider.capabilities[key], false)
  const runtime = new AcpRuntime({
    command: process.execPath,
    args: ['-e', `require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result:{protocolVersion:1,agentCapabilities:{}}})+'\\n');
      else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'不应发送恢复请求'}})+'\\n');
    })`],
    nativeHandle: { sessionId: 'existing' },
    capabilities: { resume: true },
  })
  try {
    await assert.rejects(runtime.connect(), error => error.code === 'acp_resume_unsupported')
  } finally { runtime.close() }
})

test('ACP 根据握手和会话选项收窄能力，并拒绝不支持的图片和设置', async () => {
  const runtime = kimiProvider.createRuntime()
  runtime.connect = async () => {}
  runtime.agentCapabilities = { loadSession: true, promptCapabilities: {} }
  let capabilities
  runtime.on('capabilities', value => { capabilities = value })
  runtime.refreshControlState()
  assert.equal(capabilities.resume, true)
  assert.equal(capabilities.images, false)
  assert.equal(capabilities.models, false)
  assert.equal(capabilities.reasoningEffort, false)
  await assert.rejects(runtime.startTurn([{ type: 'image' }], 'm'), error => error.code === 'acp_images_unsupported')
  await assert.rejects(runtime.updateSettings({ modelId: 'unknown' }), /不支持所选模型/)
  await assert.rejects(runtime.updateSettings({ reasoningEffort: 'high' }), /不支持所选思考强度/)
  runtime.close()
})

test('Grok 即使声明不支持图片也发送图片块，能力事件与发送行为一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'promptx-grok-image-'))
  const runtime = grokProvider.createRuntime()
  try {
    const absolutePath = path.join(dir, 'test.png')
    const bytes = Buffer.from('test image bytes')
    await fs.writeFile(absolutePath, bytes)
    runtime.connect = async () => {}
    runtime.sessionId = 'image-session'
    runtime.agentCapabilities = { promptCapabilities: { image: false } }
    let capabilities
    let request
    runtime.on('capabilities', value => { capabilities = value })
    runtime.connection = { prompt: async value => { request = value; return { stopReason: 'end_turn' } } }
    runtime.refreshControlState()
    assert.equal(capabilities.images, true)
    await runtime.startTurn([{ type: 'image', absolutePath, mimeType: 'image/png' }], 'image-message')
    assert.deepEqual(request, {
      sessionId: 'image-session',
      messageId: 'image-message',
      prompt: [{ type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' }],
    })
  } finally {
    runtime.close()
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test('通用 ACP Runtime 不解释 Grok 扩展，Grok 只接受明确的方法', () => {
  const generic = new AcpRuntime()
  const grok = grokProvider.createRuntime()
  const items = []
  generic.on('timeline', item => items.push(item))
  grok.on('timeline', item => items.push(item))
  const params = { update: { sessionUpdate: 'retry_state', type: 'retrying' } }
  generic.onExtNotification('_x.ai/session/update', params)
  grok.onExtNotification('_other/session/update', params)
  assert.equal(items.length, 0)
  grok.onExtNotification('_x.ai/session/update', params)
  assert.equal(items[0].code, 'provider_retrying')
  generic.close()
  grok.close()
})

test('ACP 工具部分更新保留名称、输入和终态，且不同工具互不污染', () => {
  const runtime = new AcpRuntime()
  const rows = []
  runtime.on('timeline', item => rows.push({ seq: rows.length + 1, turnId: 'turn-1', item }))
  runtime.onSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'read', title: 'Read probe.txt', kind: 'read', rawInput: { target_file: 'probe.txt' } })
  runtime.onSessionUpdate({ sessionUpdate: 'tool_call', toolCallId: 'write', title: 'Write other.txt', rawInput: { path: 'other.txt' } })
  runtime.onSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', status: 'completed', rawOutput: 'hello-grok' })
  runtime.onSessionUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'read', content: [] })
  const entries = projectTimelineRows(rows)
  assert.equal(entries[0].item.name, 'Read probe.txt')
  assert.equal(entries[0].item.status, 'completed')
  assert.deepEqual(entries[0].item.detail.rawInput, { target_file: 'probe.txt' })
  assert.equal(entries[0].item.detail.rawOutput, 'hello-grok')
  assert.equal(entries[0].item.detail.kind, 'read')
  assert.deepEqual(entries[0].item.detail.content, [])
  assert.equal(entries[1].item.name, 'Write other.txt')
  assert.equal(rows[0].item.status, 'running')
  runtime.close()
})

test('ACP 主动取消不显示空回复提示，正常空回复仍提示，新轮次保留工具缓存用于迟到更新', async () => {
  const runtime = new AcpRuntime()
  runtime.connect = async () => {}
  const notices = []
  runtime.on('timeline', item => notices.push(item))
  for (const stopReason of ['cancelled', 'end_turn']) {
    runtime.toolCalls.set('old', { name: '旧工具' })
    runtime.connection = { prompt: async () => ({ stopReason }) }
    const done = new Promise(resolve => runtime.once(stopReason === 'cancelled' ? 'turnCanceled' : 'turnCompleted', resolve))
    await runtime.startTurn([{ type: 'text', text: '测试' }], 'message')
    await done
    assert.equal(runtime.toolCalls.size, 1)
    assert.equal(notices.length, stopReason === 'cancelled' ? 0 : 1)
  }
  assert.equal(notices[0].code, 'empty_provider_response')
  runtime.close()
})

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

test('缺少 ACP 命令时拒绝连接', async () => {
  const runtime = new AcpRuntime({ cwd: process.cwd() })
  await assert.rejects(runtime.getControlState(), (error) => error.code === 'acp_command_missing')
  runtime.close()
})

test('createAcpProvider 用命令和历史适配器注册 Agent', async () => {
  const snapshots = []
  const provider = createAcpProvider({
    id: 'demo',
    label: 'Demo',
    command: () => 'demo-acp',
    args: () => ['agent', 'stdio'],
    readHistorySnapshot: async (sessionId) => {
      snapshots.push(sessionId)
      return { sourceId: sessionId, turns: [] }
    },
    listHistorySessions: async () => [{ providerId: 'demo', providerHandleId: 'session-1' }],
  })
  const runtime = provider.createRuntime({ nativeHandle: { sessionId: 'session-1' } })
  assert.equal(provider.id, 'demo')
  assert.equal(provider.capabilities.protocol, 'acp')
  assert.equal(runtime.command, 'demo-acp')
  assert.deepEqual(runtime.args, ['agent', 'stdio'])
  assert.deepEqual(await provider.listHistorySessions(), [{ providerId: 'demo', providerHandleId: 'session-1' }])
  assert.equal((await runtime.readHistorySnapshot()).sourceId, 'session-1')
  assert.deepEqual(snapshots, ['session-1'])
  runtime.close()
})

test('Kimi 和 Grok 共用 ACP Runtime，仅注册命令和历史读取', () => {
  const kimi = kimiProvider.createRuntime({})
  const grok = grokProvider.createRuntime({})
  try {
    assert.equal(kimiProvider.capabilities.protocol, 'acp')
    assert.equal(grokProvider.capabilities.protocol, 'acp')
    assert.equal(kimi.command, process.env.KIMI_CODE_BIN || 'kimi')
    assert.deepEqual(kimi.args, ['acp'])
    assert.equal(grok.command, process.env.GROK_BIN || 'grok')
    assert.deepEqual(grok.args, [...GROK_ACP_ARGS])
    assert.equal(typeof kimi.historyReader, 'function')
    assert.equal(typeof grok.historyReader, 'function')
    assert.notEqual(kimi.historyReader, grok.historyReader)
  } finally {
    kimi.close()
    grok.close()
  }
})

test('默认 Provider 列表包含 Kimi 和 Grok', () => {
  const registry = new ProviderRegistry()
  assert.deepEqual(registry.list().map((item) => item.id), ['codex', 'claude', 'kimi', 'grok'])
  assert.equal(registry.get('kimi').capabilities.protocol, 'acp')
  assert.equal(registry.get('grok').capabilities.protocol, 'acp')
  assert.equal(typeof registry.get('grok').listHistorySessions, 'function')
  for (const { id } of registry.list()) assert.equal(typeof registry.get(id).listHistorySessions, 'function')
})
