import { EventEmitter } from 'node:events'
import { JsonRpcProcess } from '../jsonRpcProcess.js'
import { filePromptText } from '../promptAttachments.js'
import { createControlState, effortLabel, normalizeContextUsage } from '../controlState.js'
import { readCodexHistorySnapshot } from '../history/providers/codexHistory.js'
import { CODEX_BIN, createPaginatedResumeError } from './codexCli.js'

export function buildCodexInput(content) {
  return content.map((block) => {
    if (block.type === 'text') return { type: 'text', text: block.text, text_elements: [] }
    if (block.type === 'image') return { type: 'localImage', path: block.absolutePath }
    return { type: 'text', text: filePromptText(block), text_elements: [] }
  })
}

function normalizeMessagePhase(value) {
  return ['commentary', 'final_answer'].includes(value) ? value : 'unknown'
}

function normalizeItem(item, status = 'running') {
  if (!item) return null
  if (item.type === 'agentMessage') {
    return { type: 'assistant_message', messageId: item.id, phase: normalizeMessagePhase(item.phase), text: item.text || '' }
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

function normalizeCodexModels(items = []) {
  return items.filter((item) => !item.hidden).map((item) => ({
    id: item.model || item.id,
    label: item.displayName || item.model || item.id,
    description: item.description || '',
    isDefault: Boolean(item.isDefault),
    defaultReasoningEffort: item.defaultReasoningEffort || '',
    reasoningEfforts: (item.supportedReasoningEfforts || []).map((option) => ({
      id: option.reasoningEffort,
      label: effortLabel(option.reasoningEffort),
      description: option.description || '',
    })),
  }))
}

function isMissingThreadError(error) {
  return /no rollout found for thread id|thread[^\n]*not found/i.test(error?.message || '')
}

function isPaginatedThreadsError(error) {
  return /paginated_threads/i.test(error?.message || '')
}

function isActiveWriterError(error) {
  return /already has an active writer/i.test(error?.message || '')
}

function isArchivedThreadError(error, threadId) {
  const message = error?.message || ''
  return message.includes(`session ${threadId} is archived`)
}

function isAlreadyUnarchivedError(error, threadId) {
  return (error?.message || '').includes(`no archived rollout found for thread id ${threadId}`)
}

function createActiveWriterError() {
  const error = new Error('该 Codex 会话正在 Codex App 或另一个客户端中打开，暂时不能从 PromptX 发送。请先关闭另一端的这个会话，再重新尝试。')
  error.code = 'codex_thread_active_writer'
  error.statusCode = 409
  return error
}

function createUnarchiveError(error) {
  const detail = error?.message ? `：${error.message}` : ''
  const wrapped = new Error(`该 Codex 会话已归档，PromptX 无法自动恢复${detail}`)
  wrapped.code = 'codex_thread_unarchive_failed'
  wrapped.statusCode = 409
  wrapped.cause = error
  return wrapped
}

export class CodexRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '', config = {}, rpcFactory = null }) {
    super()
    this.cwd = cwd
    this.nativeHandle = nativeHandle
    this.modelId = modelId
    this.reasoningEffort = config.reasoningEffort || ''
    this.rpc = null
    this.rpcFactory = rpcFactory || ((command, args, options) => new JsonRpcProcess(command, args, options))
    this.connected = false
    this.connectPromise = null
    this.threadId = nativeHandle.threadId || ''
    this.threadLoaded = false
    this.turnId = ''
    this.historyOnly = false
    this.messagePhases = new Map()
    this.messageTextSeen = new Set()
    this.controlState = createControlState({ requestedModelId: modelId, requestedReasoningEffort: this.reasoningEffort })
  }

  async connect() {
    if (this.rpc && this.connected) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connectInternal()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async connectInternal() {
    const rpc = this.rpcFactory(CODEX_BIN, ['app-server', '--stdio'], { cwd: this.cwd })
    this.rpc = rpc
    rpc.on('notification', (message) => {
      if (this.rpc === rpc) this.onNotification(message)
    })
    rpc.on('request', (message) => {
      if (this.rpc === rpc) this.onRequest(message)
    })
    rpc.on('protocolError', (error) => {
      if (this.rpc === rpc) this.emit('error', error)
    })
    rpc.on('exit', () => {
      if (this.rpc !== rpc) return
      this.rpc = null
      this.connected = false
      this.emit('runtimeExit')
    })
    try {
      await rpc.request('initialize', {
        clientInfo: { name: 'promptx', title: 'PromptX', version: '2.0.0' },
        capabilities: { experimentalApi: true },
      })
      rpc.notify('initialized', {})
      const models = []
      let cursor = null
      do {
        const page = await rpc.request('model/list', { cursor, limit: 100, includeHidden: false })
        models.push(...(page.data || []))
        cursor = page.nextCursor || null
      } while (cursor)
      this.controlState = createControlState({
        models: normalizeCodexModels(models),
        requestedModelId: this.modelId,
        requestedReasoningEffort: this.reasoningEffort,
        contextUsage: this.controlState.contextUsage,
      })
      this.modelId = this.controlState.currentModelId
      this.reasoningEffort = this.controlState.currentReasoningEffort
      this.connected = true
      if (this.threadId) this.emit('handle', { threadId: this.threadId })
      this.emit('controlState', this.controlState)
    } catch (error) {
      if (this.rpc === rpc) this.rpc = null
      this.connected = false
      rpc.close()
      throw error
    }
  }

  async getControlState() {
    await this.connect()
    return this.controlState
  }

  async readHistorySnapshot(options) {
    if (!this.threadId) return { status: 'unsupported' }
    return readCodexHistorySnapshot(this, options)
  }

  async ensureThreadLoaded() {
    await this.connect()
    if (this.threadLoaded) return
    const params = {
      cwd: this.cwd,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ...(this.modelId ? { model: this.modelId } : {}),
    }
    let result
    this.historyOnly = false
    if (this.threadId) {
      try {
        result = await this.rpc.request('thread/resume', { threadId: this.threadId, ...params })
      } catch (error) {
        if (isMissingThreadError(error)) {
          result = await this.rpc.request('thread/start', params)
        } else if (isPaginatedThreadsError(error)) {
          this.historyOnly = true
          throw await createPaginatedResumeError()
        } else if (isActiveWriterError(error)) {
          throw createActiveWriterError()
        } else if (isArchivedThreadError(error, this.threadId)) {
          result = await this.unarchiveAndResumeThread(params)
        } else {
          throw error
        }
      }
    } else {
      result = await this.rpc.request('thread/start', params)
    }
    this.threadId = result.thread?.id || result.threadId || this.threadId
    this.threadLoaded = true
    this.emit('handle', { threadId: this.threadId })
  }

  async unarchiveAndResumeThread(params) {
    try {
      await this.rpc.request('thread/unarchive', { threadId: this.threadId })
    } catch (error) {
      // Another Codex client may have restored it between resume and unarchive.
      if (!isAlreadyUnarchivedError(error, this.threadId)) throw createUnarchiveError(error)
    }

    try {
      return await this.rpc.request('thread/resume', { threadId: this.threadId, ...params })
    } catch (error) {
      if (isActiveWriterError(error)) throw createActiveWriterError()
      if (isArchivedThreadError(error, this.threadId)) throw createUnarchiveError(error)
      throw error
    }
  }

  async prepareTurn() {
    await this.ensureThreadLoaded()
  }

  async startTurn(content, clientMessageId) {
    await this.prepareTurn()
    this.messagePhases.clear()
    this.messageTextSeen.clear()
    const input = buildCodexInput(content)
    const result = await this.rpc.request('turn/start', {
      threadId: this.threadId,
      input,
      clientUserMessageId: clientMessageId,
      cwd: this.cwd,
      approvalPolicy: 'never',
      ...(this.modelId ? { model: this.modelId } : {}),
      ...(this.reasoningEffort ? { effort: this.reasoningEffort } : {}),
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
    if (method === 'error') {
      if (
        (params.threadId && this.threadId && params.threadId !== this.threadId)
        || (params.turnId && this.turnId && params.turnId !== this.turnId)
      ) return
      const message = params.error?.message || 'Codex 模型服务异常'
      if (params.willRetry) {
        this.emit('timeline', {
          type: 'system_notice',
          code: 'provider_retrying',
          text: '模型服务连接异常，Codex 正在自动重试。',
        })
      } else {
        this.emit('turnFailed', new Error(message))
      }
      return
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage || {}
      this.controlState = {
        ...this.controlState,
        contextUsage: normalizeContextUsage(usage.last?.totalTokens, usage.modelContextWindow),
      }
      this.emit('controlState', this.controlState)
      return
    }
    if (method === 'item/agentMessage/delta') {
      this.messageTextSeen.add(params.itemId)
      this.emit('timeline', {
        type: 'assistant_message',
        messageId: params.itemId,
        phase: this.messagePhases.get(params.itemId) || 'unknown',
        text: params.delta || '',
      })
      return
    }
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      this.emit('timeline', { type: 'reasoning', messageId: params.itemId, text: params.delta || '' })
      return
    }
    if (method === 'item/started' || method === 'item/completed') {
      if (params.item?.type === 'agentMessage') {
        const phase = normalizeMessagePhase(params.item.phase)
        if (method === 'item/started') {
          this.messagePhases.set(params.item.id, phase)
        } else {
          if (!this.messageTextSeen.has(params.item.id) && params.item.text) {
            this.emit('timeline', { type: 'assistant_message', messageId: params.item.id, phase, text: params.item.text })
          }
          this.messagePhases.delete(params.item.id)
          this.messageTextSeen.delete(params.item.id)
        }
        return
      }
      const item = normalizeItem(params.item, method === 'item/completed' ? 'completed' : 'running')
      if (item && item.type !== 'reasoning') this.emit('timeline', item)
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
    const rpc = this.rpc
    this.rpc = null
    this.connected = false
    this.threadLoaded = false
    this.turnId = ''
    rpc?.close()
  }

  releaseThreadWriter() {
    this.close()
  }
}

export const codexProvider = {
  id: 'codex',
  label: 'Codex',
  capabilities: { resume: true, cancel: true, images: true, models: true, reasoningEffort: true, contextUsage: true },
  createRuntime(options) {
    return new CodexRuntime(options)
  },
}
