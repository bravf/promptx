import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { CodexRuntime } from './codex.js'
import { ClaudeRuntime } from './claude.js'
import { AcpRuntime } from './acp.js'
import { grokProvider } from './grok.js'
import { PendingInteractions } from './pendingInteractions.js'
import { normalizeInteractionQuestions } from '../../../../../packages/protocol/src/interaction.js'
import { mapCodexHistoryItem } from '../history/providers/codexHistory.js'
import { codexAsyncInteraction, codexAsyncAnswerText } from '../../../../../packages/protocol/src/codexAsyncQuestions.js'

const questions = [{ id: 'format', header: '格式', question: '使用哪种格式？', options: [{ label: 'JSON' }, { label: 'Markdown' }] }]

test('Codex 问答保留请求，答案按问题 ID 回到原 RPC，不启动新 Turn', async () => {
  const runtime = new CodexRuntime({ cwd: '/tmp' })
  const responses = []
  runtime.rpc = { respond: (id, result) => responses.push({ id, result }), respondError: () => assert.fail('不应失败') }
  runtime.onRequest({ id: 7, method: 'item/tool/requestUserInput', params: { questions } })
  assert.equal(responses.length, 0)
  const request = runtime.interactions.requests[0]
  runtime.interactions.answer(request.id, { decision: 'answer', answers: { format: { optionIds: ['1'] } } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(responses, [{ id: 7, result: { answers: { format: { answers: ['Markdown'] } } } }])
  assert.equal(runtime.interactions.requests.length, 0)
})

test('Claude 完全访问仍接收 AskUserQuestion，按完整问题文本回填并保留工具输入', async () => {
  const runtime = new ClaudeRuntime({ cwd: '/tmp' })
  const input = { questions: questions.map(({ id, ...rest }) => rest), extra: '保留输入' }
  const promise = runtime.handleToolInteraction('AskUserQuestion', input)
  const request = runtime.interactions.requests[0]
  assert.equal(request.questions[0].allowOther, true)
  runtime.interactions.answer(request.id, { decision: 'answer', answers: { 0: { text: 'CSV' } } })
  assert.deepEqual(await promise, { behavior: 'allow', updatedInput: { ...input, answers: { '使用哪种格式？': 'CSV' } } })
  assert.deepEqual(await runtime.handleToolInteraction('Bash', { command: 'pwd' }), { behavior: 'allow', updatedInput: { command: 'pwd' } })
})

test('Codex 自动结束原请求时同步失效；新权限审批使用专用响应结构', async () => {
  const runtime = new CodexRuntime({ cwd: '/tmp' })
  const responses = []
  runtime.rpc = { respond: (id, result) => responses.push({ id, result }), respondError: () => {} }
  runtime.onRequest({ id: 7, method: 'item/tool/requestUserInput', params: { questions } })
  const requestId = runtime.interactions.requests[0].id
  runtime.onNotification({ method: 'serverRequest/resolved', params: { requestId: 7 } })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(runtime.interactions.requests.length, 0)
  assert.equal(responses.length, 0)
  assert.throws(() => runtime.interactions.answer(requestId, { decision: 'dismiss' }), error => error.statusCode === 409)
  runtime.onRequest({ id: 8, method: 'item/permissions/requestApproval', params: { permissions: { network: { enabled: true } } } })
  assert.deepEqual(responses, [{ id: 8, result: { permissions: { network: { enabled: true } }, scope: 'turn' } }])
})

test('Claude SDK 确实注册了问答回调，ExitPlanMode 有明确执行和取消路径', async () => {
  let options
  let done
  const stream = {
    async *[Symbol.asyncIterator]() { await new Promise(resolve => { done = resolve }) },
    supportedModels: async () => [], close: () => done?.(),
  }
  const runtime = new ClaudeRuntime({ cwd: '/tmp', queryFactory: input => { options = input.options; return stream } })
  try {
    await runtime.connect()
    assert.equal(options.permissionMode, 'bypassPermissions')
    const promise = options.canUseTool('ExitPlanMode', { plan: '修改并测试' }, {})
    runtime.interactions.answer(runtime.interactions.requests[0].id, { decision: 'dismiss' })
    assert.equal((await promise).behavior, 'deny')
  } finally { runtime.close() }
})

test('ACP 自动放行普通权限，但同 kind 的多个选择保留原始 optionId，Kimi/Grok 共用', async () => {
  const runtime = new AcpRuntime()
  runtime.sessionId = 's'
  runtime.connection = {}
  const delegate = runtime.createClientDelegate({ connection: runtime.connection })
  const input = { sessionId: 's', toolCall: { toolCallId: 'tool', title: '选择方案' }, options: [
    { optionId: 'once', name: '本次允许', kind: 'allow_once' },
    { optionId: 'always', name: '总是允许', kind: 'allow_always' },
  ] }
  assert.deepEqual(await delegate.requestPermission(input), { outcome: { outcome: 'selected', optionId: 'always' } })
  const promise = delegate.requestPermission({ ...input, options: [
    { optionId: 'fast', name: '快速方案', kind: 'allow_once' },
    { optionId: 'thorough', name: '完整方案', kind: 'allow_once' },
  ] })
  const request = runtime.interactions.requests[0]
  assert.deepEqual(request.actions.map(action => action.id), ['fast', 'thorough'])
  assert.throws(() => runtime.interactions.answer(request.id, { decision: 'answer', actionId: 'bad' }), error => error.statusCode === 400)
  runtime.interactions.answer(request.id, { decision: 'answer', actionId: 'thorough' })
  assert.deepEqual(await promise, { outcome: { outcome: 'selected', optionId: 'thorough' } })
  assert.deepEqual(await delegate.requestPermission({ ...input, sessionId: 'other' }), { outcome: { outcome: 'cancelled' } })
})

test('Grok 原生问答扩展按问题文本回传单选、多选和自由答案，取消及过期不会挂起', async () => {
  const runtime = grokProvider.createRuntime({ cwd: '/tmp' })
  runtime.sessionId = 'grok-question'
  const abort = new AbortController()
  runtime.connection = { signal: abort.signal }
  const delegate = runtime.createClientDelegate({ connection: runtime.connection })
  const params = { sessionId: runtime.sessionId, toolCallId: 'call', mode: 'default', questions: [
    { question: '报告格式？', options: [{ label: 'Markdown', description: '便于阅读' }, { label: 'JSON', description: '便于解析' }], multiSelect: null },
    { question: '检查范围？', options: [{ label: '前端' }, { label: 'Relay' }], multiSelect: true },
    { question: '补充要求？', options: [] },
  ] }
  const pending = delegate.extMethod('_x.ai/ask_user_question', params)
  const request = runtime.interactions.requests[0]
  assert.equal(request.questions[1].multiSelect, true)
  assert.equal(request.questions[0].options[0].description, '便于阅读')
  runtime.interactions.answer(request.id, { decision: 'answer', answers: { 0: { optionIds: ['0'] }, 1: { optionIds: ['0', '1'] }, 2: { text: '中文' } } })
  assert.deepEqual(await pending, { outcome: 'accepted', answers: { '报告格式？': ['Markdown'], '检查范围？': ['前端', 'Relay'], '补充要求？': ['中文'] }, annotations: {} })
  const dismissed = delegate.extMethod('_x.ai/ask_user_question', params)
  runtime.interactions.answer(runtime.interactions.requests[0].id, { decision: 'dismiss' })
  assert.deepEqual(await dismissed, { outcome: 'declined' })
  const expired = delegate.extMethod('_x.ai/ask_user_question', params)
  abort.abort()
  assert.deepEqual(await expired, { outcome: 'declined' })
  await assert.rejects(delegate.extMethod('_x.ai/ask_user_question', { ...params, sessionId: 'other' }), error => error.code === -32602)
  await assert.rejects(delegate.extMethod('_x.ai/unknown', params), error => error.code === -32601)
})

test('无效回答不会取走问题；多端重复回答被拒绝；秘密答案不写 Timeline', async () => {
  const runtime = new EventEmitter()
  const interactions = new PendingInteractions(runtime)
  const events = []
  runtime.on('interaction', event => events.push(event))
  const promise = interactions.ask({ kind: 'question', title: '问题', questions: normalizeInteractionQuestions([
    { ...questions[0], isSecret: true, isOther: true },
  ]) }, { respond: (_response, answers) => answers })
  const request = interactions.requests[0]
  assert.throws(() => interactions.answer(request.id, { decision: 'answer', answers: { format: { optionIds: ['0', '1'] } } }), /只能选择/)
  assert.equal(interactions.requests.length, 1)
  interactions.answer(request.id, { decision: 'answer', answers: { format: { text: '秘密文字' } } })
  assert.deepEqual(await promise, { format: ['秘密文字'] })
  assert.equal(JSON.stringify(events).includes('秘密文字'), false)
  assert.throws(() => interactions.answer(request.id, { decision: 'dismiss' }), error => error.statusCode === 409)
})

test('中断、取消、关闭会话会唤醒等待中的 Provider，问题只失效一次', async () => {
  const runtime = new EventEmitter()
  const interactions = new PendingInteractions(runtime)
  const controller = new AbortController()
  const statuses = []
  runtime.on('interaction', event => statuses.push(event.status))
  const promise = interactions.ask({ kind: 'question', title: '问题', questions: normalizeInteractionQuestions(questions) }, {
    signal: controller.signal, respond: response => response.decision,
  })
  controller.abort()
  interactions.expire()
  assert.equal(await promise, 'dismiss')
  assert.deepEqual(statuses, ['pending', 'expired'])
})

test('Codex 启动启用默认模式问答；异步问题实时与历史采用相同结构，纯文本不生成卡片', async () => {
  let args
  const rpc = new EventEmitter()
  rpc.request = async method => method === 'model/list' ? { data: [] } : {}
  rpc.notify = () => {}
  rpc.close = () => {}
  const runtime = new CodexRuntime({ cwd: '/tmp', rpcFactory: (_command, value) => { args = value; return rpc } })
  await runtime.connect()
  assert.deepEqual(args, ['--enable', 'default_mode_request_user_input', 'app-server', '--stdio'])
  const item = { type: 'agentMessage', id: 'call-async', delivery: 'async', text: '请选择报告格式。', phase: 'final_answer', questions: [{ title: '请选择报告格式。', options: ['Markdown', 'JSON'] }] }
  let actual
  const messages = []
  runtime.on('asyncInteraction', request => { actual = request })
  runtime.on('timeline', message => messages.push(message))
  runtime.onNotification({ method: 'item/completed', params: { item } })
  assert.deepEqual(actual, codexAsyncInteraction(item))
  assert.deepEqual(mapCodexHistoryItem(item)[0].item, actual)
  assert.equal(messages.length, 0)
  runtime.onNotification({ method: 'item/completed', params: { item: { ...item, id: 'plain', delivery: null } } })
  assert.equal(messages[0].type, 'assistant_message')
  assert.equal(codexAsyncInteraction({ ...item, delivery: null }), null)
  assert.match(codexAsyncAnswerText(actual, { 0: ['Markdown'] }), /request_user_input_async.*call-async/)
  runtime.close()
})
