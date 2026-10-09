import { childEnvironment, terminateChild } from '../../runtime/processControl.js'
import { spawn } from 'node:child_process'
import { BackgroundTasks } from './backgroundTasks.js'
import { PendingInteractions } from './pendingInteractions.js'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, RequestError, ndJsonStream } from '@agentclientprotocol/sdk'
import { filePromptText, imageBase64 } from '../promptAttachments.js'
import { createControlState, effortLabel, flattenAcpOptions, normalizeContextUsage } from '../controlState.js'
import { acpContentText, mergeAcpToolCall } from './acpEvents.js'

export const ACP_CAPABILITIES = Object.freeze({
  resume: false,
  cancel: true,
  images: false,
  models: false,
  reasoningEffort: false,
  contextUsage: false,
  protocol: 'acp',
})

export async function buildAcpPrompt(content) {
  return Promise.all(content.map(async (block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'file') return { type: 'text', text: filePromptText(block) }
    return { type: 'image', data: await imageBase64(block), mimeType: block.mimeType }
  }))
}

function findConfigOption(options = [], category) {
  return options.find((option) => option.type === 'select' && option.category === category)
}

export function normalizeAcpControls({ models: modelState, configOptions = [] } = {}, requestedModelId = '', requestedReasoningEffort = '', contextUsage = null) {
  const modelConfig = findConfigOption(configOptions, 'model')
  const modelItems = modelState?.availableModels?.length
    ? modelState.availableModels.map((model) => ({ id: model.modelId, label: model.name || model.modelId, description: model.description || '' }))
    : flattenAcpOptions(modelConfig ? [modelConfig] : []).map((model) => ({ id: model.value, label: model.name || model.value, description: model.description || '' }))
  const thoughtConfig = findConfigOption(configOptions, 'thought_level')
  const reasoningEfforts = flattenAcpOptions(thoughtConfig ? [thoughtConfig] : []).map((option) => ({
    id: option.value,
    label: option.name || effortLabel(option.value),
    description: option.description || '',
  }))
  const currentModelId = modelConfig?.currentValue || modelState?.currentModelId || requestedModelId || ''
  const currentReasoningEffort = reasoningEfforts.length ? (thoughtConfig?.currentValue || requestedReasoningEffort) : ''
  return createControlState({
    models: modelItems.map((model) => ({ ...model, reasoningEfforts })),
    requestedModelId: currentModelId,
    requestedReasoningEffort: currentReasoningEffort,
    fallbackReasoningEfforts: reasoningEfforts,
    contextUsage,
  })
}

export function isAcpChooserRequest(options = []) {
  const kinds = new Set()
  return options.some(option => {
    if (!String(option.kind).startsWith('allow')) return false
    if (kinds.has(option.kind)) return true
    kinds.add(option.kind)
    return false
  })
}

function selectPermission(options = []) {
  const option = options.find((item) => item.kind === 'allow_always')
    || options.find((item) => item.kind === 'allow_once')
    || options.find((item) => String(item.kind || '').startsWith('allow'))
  return option
    ? { outcome: { outcome: 'selected', optionId: option.optionId } }
    : { outcome: { outcome: 'cancelled' } }
}

export class AcpRuntime extends EventEmitter {
  constructor({
    cwd,
    nativeHandle = {},
    modelId = '',
    config = {},
    command = '',
    args = [],
    env = process.env,
    readHistorySnapshot = null,
    capabilities = {},
    allowUndeclaredImages = false,
    extensionNotification = null,
    extensionRequest = null,
    runtimeExtension = null,
    serviceMcp,
    emptyResponseText = 'ACP Agent 已结束本轮，但没有返回可显示的内容。',
  } = {}) {
    super()
    this.cwd = cwd
    this.serviceMcp = serviceMcp
    this.interactions = new PendingInteractions(this)
    this.sessionId = nativeHandle.sessionId || ''
    this.command = command
    this.args = args
    this.env = env
    this.historyReader = readHistorySnapshot
    this.capabilities = { ...ACP_CAPABILITIES, ...capabilities }
    this.allowUndeclaredImages = allowUndeclaredImages
    this.extensionNotification = extensionNotification
    this.extensionRequest = extensionRequest
    this.runtimeExtension = runtimeExtension
    this.backgroundTasks = new BackgroundTasks(this)
    this.agentCapabilities = null
    this.emptyResponseText = emptyResponseText
    this.modelId = modelId
    this.reasoningEffort = config.reasoningEffort || ''
    this.child = null
    this.connection = null
    this.connected = false
    this.connectPromise = null
    this.acceptUpdates = false
    this.hasTurnOutput = false
    this.toolCalls = new Map()
    this.sessionControls = config.acpSessionControls || { models: null, configOptions: [] }
    this.controlState = createControlState({ requestedModelId: modelId, requestedReasoningEffort: this.reasoningEffort })
  }

  async prepareTurn() { await this.connect() }

  async connect() {
    if (this.connection && this.connected) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connectInternal()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async connectInternal() {
    if (!this.command) {
      const error = new Error('缺少 ACP 命令。')
      error.code = 'acp_command_missing'
      throw error
    }
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: childEnvironment(this.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    child.promptxProcessGroup = process.platform !== 'win32'
    const childReady = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    this.child = child
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()))
    child.on('exit', () => {
      if (this.child !== child) return
      this.interactions.expire('Agent 进程已退出。')
      this.backgroundTasks.interrupt('ACP 进程退出，后台任务已中断')
      this.connection = null
      this.child = null
      this.connected = false
      this.emit('runtimeExit')
    })
    let connection = null
    this.acceptUpdates = false
    try {
      await childReady
      const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout))
      const holder = { connection: null }
      connection = new ClientSideConnection(() => this.createClientDelegate(holder), stream)
      holder.connection = connection
      this.connection = connection
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'promptx', title: 'PromptX', version: '2.0.0' },
        clientCapabilities: {},
      })
      if (this.child !== child) throw new Error('ACP 连接已关闭。')
      this.agentCapabilities = initialized.agentCapabilities || {}
      if (this.sessionId && (!this.capabilities.resume || !this.agentCapabilities.loadSession)) {
        throw Object.assign(new Error('该 ACP Agent 不支持恢复会话。'), { code: 'acp_resume_unsupported' })
      }
      const result = this.sessionId
        ? await connection.loadSession({ sessionId: this.sessionId, cwd: this.cwd, mcpServers: this.mcpServers() })
        : await connection.newSession({ cwd: this.cwd, mcpServers: this.mcpServers() })
      if (this.child !== child) throw new Error('ACP 连接已关闭。')
      this.sessionId = result.sessionId || this.sessionId
      this.emit('handle', { sessionId: this.sessionId })
      this.sessionControls = {
        models: result.models || null,
        configOptions: result.configOptions || [],
      }
      await this.applyStoredSettings()
      this.refreshControlState()
      this.persistSessionControls()
      this.acceptUpdates = true
      this.connected = true
    } catch (error) {
      if (this.connection === connection) {
        this.connection = null
        this.child = null
      }
      this.connected = false
      this.acceptUpdates = false
      terminateChild(child)
      throw error
    }
  }

  async applyStoredSettings() {
    const requestedModelId = this.modelId
    const requestedEffort = this.reasoningEffort
    const { models, configOptions } = this.sessionControls
    const modelConfig = findConfigOption(configOptions, 'model')
    const currentModelId = modelConfig?.currentValue || models?.currentModelId || ''
    if (requestedModelId && requestedModelId !== currentModelId) {
      // 优先使用返回完整选项的配置接口，避免旧模型的强度配置残留。
      if (modelConfig) {
        const result = await this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: modelConfig.id, value: requestedModelId })
        this.sessionControls.configOptions = result.configOptions || []
      } else if (models?.availableModels?.some((model) => model.modelId === requestedModelId)) {
        this.sessionControls.configOptions = []
        await this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId: requestedModelId })
      }
      if (models) this.sessionControls.models = { ...models, currentModelId: requestedModelId }
    }
    const thoughtConfig = findConfigOption(this.sessionControls.configOptions, 'thought_level')
    const efforts = flattenAcpOptions(thoughtConfig ? [thoughtConfig] : [])
    const effort = efforts.some(option => option.value === requestedEffort)
      ? requestedEffort
      : (thoughtConfig?.currentValue || efforts[0]?.value || '')
    if (effort && thoughtConfig && effort !== thoughtConfig.currentValue) {
      const result = await this.connection.setSessionConfigOption({
        sessionId: this.sessionId,
        configId: thoughtConfig.id,
        value: effort,
      })
      this.sessionControls.configOptions = result.configOptions || this.sessionControls.configOptions
    }
    this.modelId = findConfigOption(this.sessionControls.configOptions, 'model')?.currentValue || this.sessionControls.models?.currentModelId || requestedModelId
    this.reasoningEffort = findConfigOption(this.sessionControls.configOptions, 'thought_level')?.currentValue || ''
  }

  mcpServers() {
    return this.serviceMcp ? [{ name: 'promptx_services', command: this.serviceMcp.command, args: this.serviceMcp.args,
      env: Object.entries(this.serviceMcp.env).map(([name, value]) => ({ name, value })),
    }] : []
  }

  supportsImages() {
    return this.capabilities.images && (this.allowUndeclaredImages || Boolean(this.agentCapabilities?.promptCapabilities?.image))
  }

  refreshControlState() {
    this.controlState = normalizeAcpControls(
      this.sessionControls,
      this.modelId,
      this.reasoningEffort,
      this.controlState.contextUsage,
    )
    this.modelId = this.controlState.currentModelId
    this.reasoningEffort = this.controlState.currentReasoningEffort
    if (this.agentCapabilities) {
      this.emit('capabilities', {
        ...this.capabilities,
        resume: this.capabilities.resume && Boolean(this.agentCapabilities.loadSession),
        images: this.supportsImages(),
        models: this.capabilities.models && this.controlState.models.length > 0,
        reasoningEffort: this.capabilities.reasoningEffort && this.controlState.reasoningEfforts.length > 0,
      })
    }
    this.emit('controlState', this.controlState)
  }

  persistSessionControls() {
    this.emit('providerConfig', { acpSessionControls: this.sessionControls })
  }

  async getControlState() {
    await this.connect()
    return this.controlState
  }

  async readHistorySnapshot(options) {
    if (!this.sessionId || !this.historyReader) return { status: 'unsupported' }
    return this.historyReader(this.sessionId, options)
  }

  async updateSettings({ modelId = this.modelId, reasoningEffort = this.reasoningEffort } = {}) {
    await this.connect()
    if (modelId !== this.modelId && (!this.capabilities.models || !this.controlState.models.some(model => model.id === modelId))) {
      throw new Error('该 ACP Agent 不支持所选模型。')
    }
    if (modelId === this.modelId && reasoningEffort !== this.reasoningEffort && (!this.capabilities.reasoningEffort || !this.controlState.reasoningEfforts.some(effort => effort.id === reasoningEffort))) {
      throw new Error('该 ACP Agent 不支持所选思考强度。')
    }
    this.modelId = modelId
    this.reasoningEffort = reasoningEffort
    this.updatingSettings = true
    try {
      await this.applyStoredSettings()
    } catch (error) {
      this.modelId = findConfigOption(this.sessionControls.configOptions, 'model')?.currentValue || this.sessionControls.models?.currentModelId || ''
      this.reasoningEffort = findConfigOption(this.sessionControls.configOptions, 'thought_level')?.currentValue || ''
      throw error
    } finally {
      this.updatingSettings = false
      this.refreshControlState()
      this.persistSessionControls()
    }
    return this.controlState
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    if (content.some(block => block.type === 'image') && !this.supportsImages()) {
      throw Object.assign(new Error('该 ACP Agent 不支持图片输入。'), { code: 'acp_images_unsupported' })
    }
    this.hasTurnOutput = false
    if (this.toolCalls.size > 1000) for (const [id, item] of this.toolCalls) {
      if (this.toolCalls.size <= 1000) break
      if (!['running', 'pending'].includes(item.status)) this.toolCalls.delete(id)
    }
    const prompt = await buildAcpPrompt(content)
    if (this.autonomousRun) throw new Error('Agent 已开始自动续跑，请稍后重试。')
    const connection = this.connection
    this.activeRunId = clientMessageId
    this.emit('turnStarted')
    this.connection.prompt({ sessionId: this.sessionId, prompt, messageId: clientMessageId })
      .then((result) => {
        if (this.connection !== connection || this.activeRunId !== clientMessageId) return
        this.activeRunId = null
        if (!this.hasTurnOutput && result.stopReason !== 'cancelled') {
          this.emit('timeline', { type: 'system_notice', code: 'empty_provider_response', text: this.emptyResponseText })
        }
        if (result.stopReason === 'cancelled') this.emit('turnCanceled', { runId: clientMessageId })
        else this.emit('turnCompleted', { runId: clientMessageId, usage: result.usage || {} })
      })
      .catch((error) => {
        if (this.connection !== connection || this.activeRunId !== clientMessageId) return
        this.activeRunId = null
        this.emit('turnFailed', Object.assign(error, { runId: clientMessageId }))
      })
    return {}
  }

  createClientDelegate(holder) {
    return {
      requestPermission: async (params) => {
        if (this.connection !== holder.connection || params.sessionId !== this.sessionId) return { outcome: { outcome: 'cancelled' } }
        if (!isAcpChooserRequest(params.options) && params.toolCall?.kind !== 'switch_mode') return selectPermission(params.options)
        return this.interactions.ask({
          kind: params.toolCall?.kind === 'switch_mode' ? 'plan' : 'choice',
          title: String(params.toolCall?.title || '请选择下一步'),
          description: (params.toolCall?.content || []).map(part => part.type === 'content' && part.content?.type === 'text' ? part.content.text : '').filter(Boolean).join('\n'),
          actions: params.options.map(option => ({ id: option.optionId, label: option.name })),
        }, { respond: response => ({ outcome: response.decision === 'answer'
          ? { outcome: 'selected', optionId: response.actionId } : { outcome: 'cancelled' } }) })
      },
      sessionUpdate: async (params) => {
        if (this.connection === holder.connection && this.acceptUpdates) this.onSessionNotification(params)
      },
      extNotification: async (method, params) => {
        if (this.connection === holder.connection && this.acceptUpdates) this.onExtNotification(method, params)
      },
      extMethod: async (method, params) => {
        if (this.connection !== holder.connection || params.sessionId !== this.sessionId) throw RequestError.invalidParams('会话已失效。')
        const result = this.extensionRequest?.(this, method, params)
        if (result === undefined) throw RequestError.methodNotFound(method)
        return result
      },
    }
  }

  onExtNotification(method, params = {}) {
    if (params.sessionId && params.sessionId !== this.sessionId) return
    this.runtimeExtension?.(this, method, params)
    const item = this.extensionNotification?.(method, params)
    if (item) this.emit('timeline', item)
  }

  onSessionNotification(params = {}) {
    const sessionId = params.sessionId
    if (sessionId && this.sessionId && sessionId !== this.sessionId) return
    const update = params.update || params
    if (!update?.sessionUpdate) return
    this.onSessionUpdate(update, params)
  }

  onSessionUpdate(update, params = {}) {
    this.runtimeExtension?.(this, 'session/update', { ...params, update })
    if (update.sessionUpdate === 'usage_update') {
      this.controlState = { ...this.controlState, contextUsage: normalizeContextUsage(update.used, update.size) }
      this.emit('controlState', this.controlState)
    } else if (update.sessionUpdate === 'config_option_update') {
      this.sessionControls.configOptions = update.configOptions || []
      if (this.updatingSettings) return
      this.refreshControlState()
      this.persistSessionControls()
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      const text = acpContentText(update.content)
      if (text) {
        this.hasTurnOutput = true
        this.emit('timeline', { type: 'assistant_message', phase: 'final_answer', text })
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = acpContentText(update.content)
      if (text) {
        this.hasTurnOutput = true
        this.emit('timeline', { type: 'reasoning', text })
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.hasTurnOutput = true
      const previous = this.toolCalls.get(update.toolCallId)
      const item = mergeAcpToolCall(previous, update)
      this.toolCalls.set(update.toolCallId, item)
      this.emit('timeline', item)
    } else if (update.sessionUpdate === 'plan') {
      this.emit('timeline', {
        type: 'todo',
        items: (update.entries || []).map((entry) => ({ text: entry.content, status: entry.status })),
      })
    }
  }

  async stopBackgroundTasks() {
    if (!this.backgroundTasks.running.length) return
    const operation = this.runtimeExtension?.(this, 'stopBackgroundTasks', {})
    if (!operation) throw new Error('此 Agent 未提供后台任务停止接口。')
    await operation
  }

  async cancel() {
    if (!this.capabilities.cancel) throw new Error('该 ACP Agent 不支持取消。')
    this.interactions.expire('任务已取消。')
    if (this.connection && this.sessionId) await this.connection.cancel({ sessionId: this.sessionId })
  }

  close() {
    this.interactions.expire('会话连接已关闭。')
    this.backgroundTasks.interrupt()
    this.toolCalls.clear()
    const child = this.child
    this.child = null
    this.connection = null
    this.connected = false
    this.acceptUpdates = false
    terminateChild(child)
  }
}

export function createAcpProvider({
  id,
  label,
  command,
  args = [],
  env,
  capabilities = {},
  allowUndeclaredImages = false,
  readHistorySnapshot = null,
  listHistorySessions = null,
  emptyResponseText,
  extensionNotification = null,
  extensionRequest = null,
  runtimeExtension = null,
} = {}) {
  if (!id || !label) throw new Error('ACP Provider 需要 id 和 label。')
  return {
    id,
    label,
    capabilities: { ...ACP_CAPABILITIES, ...capabilities, protocol: 'acp' },
    listHistorySessions,
    createRuntime(options = {}) {
      const runtimeOptions = {
        ...options,
        command: typeof command === 'function' ? command() : command,
        args: typeof args === 'function' ? args() : args,
        readHistorySnapshot,
        capabilities: { ...ACP_CAPABILITIES, ...capabilities },
        allowUndeclaredImages,
        extensionNotification,
        extensionRequest,
        runtimeExtension,
      }
      const resolvedEnv = typeof env === 'function' ? env() : env
      if (resolvedEnv) runtimeOptions.env = resolvedEnv
      if (emptyResponseText) runtimeOptions.emptyResponseText = emptyResponseText
      return new AcpRuntime(runtimeOptions)
    },
  }
}
