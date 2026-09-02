import { EventEmitter } from 'node:events'
import { JsonRpcProcess } from '../jsonRpcProcess.js'

function normalizeItem(item, status = 'running') {
  if (!item) return null
  if (item.type === 'agentMessage') {
    return { type: 'assistant_message', messageId: item.id, text: item.text || '' }
  }
  if (item.type === 'reasoning') {
    const text = (item.summary || []).map((part) => part.text || '').join('') || (item.content || []).map((part) => part.text || '').join('')
    return text ? { type: 'reasoning', messageId: item.id, text } : null
  }
  const toolNames = {
    commandExecution: '终端命令',
    fileChange: '文件修改',
    mcpToolCall: item.tool || item.name || 'MCP 工具',
    webSearch: '网页搜索',
  }
  if (toolNames[item.type]) {
    return {
      type: 'tool_call',
      callId: item.id,
      name: toolNames[item.type],
      status,
      detail: { type: item.type, ...item },
    }
  }
  return null
}

export class CodexRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '' }) {
    super()
    this.cwd = cwd
    this.nativeHandle = nativeHandle
    this.modelId = modelId
    this.rpc = null
    this.threadId = nativeHandle.threadId || ''
    this.turnId = ''
  }

  async connect() {
    if (this.rpc) return
    this.rpc = new JsonRpcProcess('codex', ['app-server', '--stdio'], { cwd: this.cwd })
    this.rpc.on('notification', (message) => this.onNotification(message))
    this.rpc.on('request', (message) => this.onRequest(message))
    this.rpc.on('protocolError', (error) => this.emit('error', error))
    this.rpc.on('exit', () => {
      this.rpc = null
      this.emit('runtimeExit')
    })
    await this.rpc.request('initialize', {
      clientInfo: { name: 'promptx', title: 'PromptX', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    })
    this.rpc.notify('initialized', {})
    const params = {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.modelId ? { model: this.modelId } : {}),
    }
    const result = this.threadId
      ? await this.rpc.request('thread/resume', { threadId: this.threadId, ...params })
      : await this.rpc.request('thread/start', params)
    this.threadId = result.thread?.id || result.threadId || this.threadId
    this.emit('handle', { threadId: this.threadId })
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    const input = content.map((block) => block.type === 'text'
      ? { type: 'text', text: block.text, text_elements: [] }
      : { type: 'image', url: block.url || '' })
    const result = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input,
      clientUserMessageId: clientMessageId,
      cwd: this.cwd,
      approvalPolicy: 'never',
    })
    this.turnId = result.turn?.id || result.turnId || ''
    return { nativeTurnId: this.turnId }
  }

  onRequest(message) {
    if (message.method.includes('requestApproval')) {
      this.rpc.respond(message.id, { decision: 'accept' })
      return
    }
    this.rpc.respond(message.id, {})
  }

  onNotification({ method, params = {} }) {
    if (method === 'item/agentMessage/delta') {
      this.emit('timeline', { type: 'assistant_message', messageId: params.itemId, text: params.delta || '' })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emit('timeline', { type: 'reasoning', messageId: params.itemId, text: params.delta || '' })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      const item = normalizeItem(params.item, method === 'item/completed' ? 'completed' : 'running')
      if (item && !['assistant_message', 'reasoning'].includes(item.type)) this.emit('timeline', item)
      return
    }
    if (method === 'turn/started') {
      this.turnId = params.turn?.id || this.turnId
      this.emit('turnStarted', { nativeTurnId: this.turnId })
      return
    }
    if (method === 'turn/completed') {
      const status = params.turn?.status
      if (status === 'failed') this.emit('turnFailed', new Error(params.turn?.error?.message || 'Codex Turn 失败'))
      else if (status === 'interrupted') this.emit('turnCanceled')
      else this.emit('turnCompleted', { usage: params.turn?.usage || {} })
    }
  }

  async cancel() {
    if (this.rpc && this.threadId && this.turnId) {
      await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId })
    }
  }

  close() {
    this.rpc?.close()
    this.rpc = null
  }
}

export const codexProvider = {
  id: 'codex',
  label: 'Codex',
  capabilities: { resume: true, cancel: true, images: true },
  createRuntime(options) {
    return new CodexRuntime(options)
  },
}
