import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { StringDecoder } from 'node:string_decoder'
import { childEnvironment, terminateChild } from '../../runtime/processControl.js'
import { createControlState, effortLabel, normalizeContextUsage } from '../controlState.js'
import { filePromptText, imageBase64 } from '../promptAttachments.js'
import { readPiHistorySnapshot } from '../history/providers/piHistory.js'
import { listPiHistorySessions } from '../history/providers/piSessions.js'
import { PendingInteractions } from './pendingInteractions.js'

const modelKey = model => model ? `${model.provider}/${model.id}` : ''

export class PiRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '', config = {}, spawnProcess = spawn } = {}) {
    super()
    this.cwd = cwd
    this.sessionFile = nativeHandle.sessionFile || ''
    this.sessionId = nativeHandle.sessionId || randomUUID()
    this.modelId = modelId
    this.reasoningEffort = config.reasoningEffort || ''
    this.spawnProcess = spawnProcess
    this.pending = new Map()
    this.tools = new Map()
    this.interactions = new PendingInteractions(this)
    this.controlState = createControlState()
    this.child = null
    this.activeRunId = null
    this.connectPromise = null
  }

  async connect() {
    if (this.connectPromise) return this.connectPromise
    if (this.child) return
    this.connectPromise = this.connectInternal()
    try { await this.connectPromise } finally { this.connectPromise = null }
  }

  async connectInternal() {
    const args = ['--mode', 'rpc']
    if (this.sessionFile) args.push('--session', this.sessionFile)
    else args.push('--session-id', this.sessionId)
    if (this.modelId) args.push('--model', this.modelId)
    if (this.reasoningEffort) args.push('--thinking', this.reasoningEffort)
    const child = this.spawnProcess(process.env.PI_BIN || process.env.PI_COMMAND || 'pi', args, {
      cwd: this.cwd, env: childEnvironment(), stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32',
    })
    child.promptxProcessGroup = process.platform !== 'win32'
    this.child = child
    const decoder = new StringDecoder('utf8')
    let buffer = ''
    // 只按 LF 切分，避免正文中的 Unicode 分隔符或跨 chunk 字符破坏 JSONL。
    child.stdout.on('data', chunk => {
      if (this.child !== child) return
      buffer += decoder.write(chunk)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, '')
        buffer = buffer.slice(end + 1)
        if (!line) continue
        try { this.receive(JSON.parse(line)) } catch (error) {
          this.disconnect(child, new Error(`Pi RPC 数据处理失败：${error.message}`))
          return
        }
      }
      if (buffer.length > 16 * 1024 * 1024) this.disconnect(child, new Error('Pi RPC 消息超过大小限制。'))
    })
    child.stderr.on('data', chunk => this.emit('stderr', chunk.toString()))
    child.stdin.on('error', error => this.disconnect(child, error))
    child.once('error', error => this.disconnect(child, error))
    child.once('exit', (code, signal) => this.disconnect(child, new Error(`Pi 进程已退出（${signal || code}）。`)))
    try {
      await this.refreshControls()
    } catch (error) {
      this.disconnect(child, error)
      throw error
    }
  }

  request(type, params = {}) {
    const child = this.child
    if (!child) return Promise.reject(new Error('Pi 尚未连接。'))
    const id = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        // 超时后终止流，避免旧 prompt 在后台继续执行并污染下一轮。
        this.disconnect(child, new Error(`Pi ${type} 请求超时。`))
      }, 60_000)
      this.pending.set(id, { resolve, reject, timer })
      child.stdin.write(`${JSON.stringify({ ...params, type, id })}\n`, error => {
        if (!error) return
        const entry = this.pending.get(id)
        if (!entry) return
        this.pending.delete(id)
        clearTimeout(entry.timer)
        entry.reject(error)
      })
    })
  }

  receive(event) {
    if (event.type === 'response') {
      const entry = this.pending.get(event.id)
      if (!entry) return
      this.pending.delete(event.id)
      clearTimeout(entry.timer)
      if (event.success) entry.resolve(event.data)
      else entry.reject(new Error(event.error || `Pi ${event.command} 失败。`))
      return
    }
    if (event.type === 'extension_ui_request') { this.handleInteraction(event); return }
    if (!this.activeRunId) return
    if (event.type === 'message_update') {
      const delta = event.assistantMessageEvent
      if (delta?.type === 'text_delta' && delta.delta) this.emit('timeline', { type: 'assistant_message', phase: 'unknown', messageId: this.messageId, text: delta.delta })
      if (delta?.type === 'thinking_delta' && delta.delta) this.emit('timeline', { type: 'reasoning', messageId: this.messageId, text: delta.delta })
    } else if (event.type === 'message_start' && event.message?.role === 'assistant') {
      this.messageId = randomUUID()
    } else if (event.type === 'message_end' && event.message?.role === 'assistant') {
      this.lastAssistant = event.message
    } else if (event.type.startsWith('tool_execution_')) {
      const previous = this.tools.get(event.toolCallId)
      const item = {
        type: 'tool_call', callId: event.toolCallId, name: event.toolName || previous?.name || 'Pi 工具',
        status: event.type === 'tool_execution_end' ? (event.isError ? 'failed' : 'completed') : 'running',
        detail: { ...previous?.detail, type: 'acp_tool', ...(event.args !== undefined ? { rawInput: event.args } : {}),
          ...(event.result !== undefined || event.partialResult !== undefined ? { rawOutput: event.result ?? event.partialResult } : {}) },
        ...(event.isError ? { error: { message: 'Pi 工具执行失败，请查看输出。' } } : {}),
      }
      this.tools.set(event.toolCallId, item)
      this.emit('timeline', item)
    } else if (event.type === 'auto_retry_start') {
      this.emit('timeline', { type: 'system_notice', code: 'provider_retrying', text: event.errorMessage || 'Pi 正在重试模型请求。' })
    } else if (event.type === 'agent_settled') {
      this.finishTurn()
      void this.refreshControls().catch(error => this.emit('stderr', error.message))
    }
  }

  finishTurn(error = null) {
    const runId = this.activeRunId
    if (!runId) return
    this.activeRunId = null
    this.interactions.expire()
    if (this.cancelRequested || this.lastAssistant?.stopReason === 'aborted') this.emit('turnCanceled', { runId })
    else if (error || this.lastAssistant?.stopReason === 'error') this.emit('turnFailed', Object.assign(error || new Error(this.lastAssistant.errorMessage || 'Pi 模型请求失败。'), { runId }))
    else this.emit('turnCompleted', { runId, usage: this.lastAssistant?.usage || {} })
  }

  async refreshControls() {
    const state = await this.request('get_state')
    const { models = [] } = await this.request('get_available_models')
    const { levels = [] } = await this.request('get_available_thinking_levels')
    this.modelId = modelKey(state.model)
    this.reasoningEffort = state.thinkingLevel || ''
    this.sessionId = state.sessionId || this.sessionId
    this.sessionFile = state.sessionFile || this.sessionFile
    this.emit('handle', { sessionId: this.sessionId, ...(this.sessionFile ? { sessionFile: this.sessionFile } : {}) })
    const efforts = levels.map(id => ({ id, label: id === 'off' ? '关闭' : effortLabel(id), description: '' }))
    this.controlState = createControlState({
      models: models.map(model => ({ id: modelKey(model), label: `${model.name || model.id} · ${model.provider}`, reasoningEfforts: modelKey(model) === this.modelId ? efforts : [], description: '' })),
      requestedModelId: this.modelId, requestedReasoningEffort: this.reasoningEffort, fallbackReasoningEfforts: efforts,
    })
    const stats = await this.request('get_session_stats')
    const context = stats?.contextUsage
    this.controlState.contextUsage = context?.tokens != null ? normalizeContextUsage(context.tokens, context.contextWindow) : null
    this.emit('controlState', this.controlState)
    return this.controlState
  }

  async prepareTurn() { await this.connect() }
  async getControlState() { await this.connect(); return this.refreshControls() }
  async readHistorySnapshot(options = {}) {
    return readPiHistorySnapshot({ sessionId: this.sessionId, sessionFile: this.sessionFile, ...options })
  }

  async updateSettings({ modelId = this.modelId, reasoningEffort } = {}) {
    await this.connect()
    if (this.activeRunId) throw new Error('请等待 Pi 本轮任务结束后修改设置。')
    if (modelId && modelId !== this.modelId) {
      const separator = modelId.indexOf('/')
      if (separator < 1) throw new Error('Pi 模型标识必须包含 provider/model。')
      await this.request('set_model', { provider: modelId.slice(0, separator), modelId: modelId.slice(separator + 1) })
    }
    if (reasoningEffort) await this.request('set_thinking_level', { level: reasoningEffort })
    return this.refreshControls()
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    if (this.activeRunId) throw new Error('Pi 已有任务正在运行。')
    const message = content.filter(block => block.type !== 'image').map(block => block.type === 'file' ? filePromptText(block) : block.text).join('\n\n')
    const images = await Promise.all(content.filter(block => block.type === 'image').map(async block => ({ type: 'image', mimeType: block.mimeType, data: await imageBase64(block) })))
    this.tools.clear()
    this.lastAssistant = null
    this.messageId = randomUUID()
    this.cancelRequested = false
    this.activeRunId = clientMessageId
    this.emit('turnStarted', { nativeTurnId: clientMessageId })
    try {
      const ack = await this.request('prompt', { message, ...(images.length ? { images } : {}) })
      if (ack?.disposition === 'handled' || ack?.agentInvoked === false) this.finishTurn()
    } catch (error) { this.finishTurn(error); throw error }
    return { nativeTurnId: clientMessageId }
  }

  handleInteraction(event) {
    if (!['select', 'confirm', 'input', 'editor'].includes(event.method)) {
      if (event.method === 'notify') this.emit('timeline', { type: 'system_notice', code: 'pi_notification', text: event.message || 'Pi 通知' })
      return
    }
    const child = this.child
    const confirm = event.method === 'confirm'
    const options = confirm ? ['确认', '取消'] : (event.options || [])
    let timer
    const controller = new AbortController()
    if (event.timeout > 0) timer = setTimeout(() => controller.abort(), event.timeout)
    void this.interactions.ask({
      kind: 'question', title: event.title || 'Pi 需要你回答', description: event.message || '',
      questions: [{ id: 'answer', header: '回答', question: event.title || '请输入回答', options: options.map((label, index) => ({ id: String(index), label })), multiSelect: false, allowOther: !options.length }],
    }, { signal: controller.signal, respond: (response, answers) => {
      if (this.child !== child) return
      const value = answers.answer?.[0]
      child?.stdin.write(`${JSON.stringify({ type: 'extension_ui_response', id: event.id,
        ...(response.decision !== 'answer' ? { cancelled: true } : confirm ? { confirmed: value === '确认' } : { value }) })}\n`)
    } }).catch(error => this.emit('stderr', error.message)).finally(() => clearTimeout(timer))
  }

  async cancel() {
    if (!this.activeRunId) return
    this.cancelRequested = true
    this.interactions.expire()
    await this.request('abort')
  }

  disconnect(child, error) {
    if (this.child !== child) return
    this.child = null
    for (const entry of this.pending.values()) { clearTimeout(entry.timer); entry.reject(error) }
    this.pending.clear()
    this.finishTurn(error)
    this.interactions.expire()
    terminateChild(child)
    this.emit('runtimeExit')
  }

  close() {
    const child = this.child
    this.child = null
    this.interactions.expire('会话连接已关闭。')
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(new Error('Pi 会话已关闭。'))
    }
    this.pending.clear()
    terminateChild(child)
  }
}

export const piProvider = {
  id: 'pi', label: 'Pi',
  capabilities: { resume: true, cancel: true, images: true, models: true, reasoningEffort: true, contextUsage: true },
  listHistorySessions(projects, options) { return listPiHistorySessions(projects, options) },
  createImportOptions(session) {
    return { nativeHandle: { sessionId: session.providerHandleId, sessionFile: session.sessionFile } }
  },
  createRuntime(options) { return new PiRuntime(options) },
}
