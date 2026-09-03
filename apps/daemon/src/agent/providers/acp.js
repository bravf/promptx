import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'
import { filePromptText, imageBase64 } from '../promptAttachments.js'
import { createControlState, effortLabel, flattenAcpOptions, normalizeContextUsage } from '../controlState.js'

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
  const currentModelId = requestedModelId || modelState?.currentModelId || modelConfig?.currentValue || ''
  const currentReasoningEffort = requestedReasoningEffort || thoughtConfig?.currentValue || ''
  return createControlState({
    models: modelItems.map((model) => ({ ...model, reasoningEfforts })),
    requestedModelId: currentModelId,
    requestedReasoningEffort: currentReasoningEffort,
    fallbackReasoningEfforts: reasoningEfforts,
    contextUsage,
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

function contentText(content) {
  if (!content) return ''
  if (content.type === 'text') return content.text || ''
  return ''
}

export class AcpRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '', config = {}, command = 'kimi', args = ['acp'] }) {
    super()
    this.cwd = cwd
    this.sessionId = nativeHandle.sessionId || ''
    this.command = command
    this.args = args
    this.modelId = modelId
    this.reasoningEffort = config.reasoningEffort || ''
    this.child = null
    this.connection = null
    this.connected = false
    this.connectPromise = null
    this.acceptUpdates = false
    this.hasTurnOutput = false
    this.sessionControls = config.acpSessionControls || { models: null, configOptions: [] }
    this.controlState = createControlState({ requestedModelId: modelId, requestedReasoningEffort: this.reasoningEffort })
  }

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
    const child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const childReady = new Promise((resolve, reject) => {
      child.once('spawn', resolve)
      child.once('error', reject)
    })
    this.child = child
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()))
    child.on('exit', () => {
      if (this.child !== child) return
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
      connection = new ClientSideConnection(() => ({
        requestPermission: async (params) => selectPermission(params.options),
        sessionUpdate: async (params) => {
          if (this.connection === connection && this.acceptUpdates) this.onSessionUpdate(params.update)
        },
      }), stream)
      this.connection = connection
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'promptx', title: 'PromptX', version: '2.0.0' },
        clientCapabilities: {},
      })
      const result = this.sessionId
        ? await connection.loadSession({ sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] })
        : await connection.newSession({ cwd: this.cwd, mcpServers: [] })
      this.sessionId = result.sessionId || this.sessionId
      this.emit('handle', { sessionId: this.sessionId })
      this.sessionControls = {
        models: result.models || this.sessionControls.models || null,
        configOptions: result.configOptions?.length ? result.configOptions : (this.sessionControls.configOptions || []),
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
      if (!child.killed) child.kill('SIGTERM')
      throw error
    }
  }

  async applyStoredSettings() {
    const { models, configOptions } = this.sessionControls
    const modelConfig = findConfigOption(configOptions, 'model')
    const currentModelId = models?.currentModelId || modelConfig?.currentValue || ''
    if (this.modelId && this.modelId !== currentModelId) {
      if (models?.availableModels?.some((model) => model.modelId === this.modelId)) {
        await this.connection.unstable_setSessionModel({ sessionId: this.sessionId, modelId: this.modelId })
        this.sessionControls.models = { ...models, currentModelId: this.modelId }
      } else if (modelConfig) {
        const result = await this.connection.setSessionConfigOption({ sessionId: this.sessionId, configId: modelConfig.id, value: this.modelId })
        this.sessionControls.configOptions = result.configOptions || this.sessionControls.configOptions
      }
    }
    const thoughtConfig = findConfigOption(this.sessionControls.configOptions, 'thought_level')
    if (this.reasoningEffort && thoughtConfig && this.reasoningEffort !== thoughtConfig.currentValue) {
      const result = await this.connection.setSessionConfigOption({
        sessionId: this.sessionId,
        configId: thoughtConfig.id,
        value: this.reasoningEffort,
      })
      this.sessionControls.configOptions = result.configOptions || this.sessionControls.configOptions
    }
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
    this.emit('controlState', this.controlState)
  }

  persistSessionControls() {
    this.emit('providerConfig', { acpSessionControls: this.sessionControls })
  }

  async getControlState() {
    await this.connect()
    return this.controlState
  }

  async updateSettings({ modelId = this.modelId, reasoningEffort = this.reasoningEffort } = {}) {
    await this.connect()
    this.modelId = modelId
    this.reasoningEffort = reasoningEffort
    await this.applyStoredSettings()
    this.refreshControlState()
    this.persistSessionControls()
    return this.controlState
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    this.hasTurnOutput = false
    const prompt = await buildAcpPrompt(content)
    this.emit('turnStarted', { nativeTurnId: clientMessageId })
    this.connection.prompt({ sessionId: this.sessionId, prompt, messageId: clientMessageId })
      .then((result) => {
        if (!this.hasTurnOutput) {
          this.emit('timeline', { type: 'system_notice', code: 'empty_provider_response', text: 'ACP Agent 已结束本轮，但没有返回可显示的内容。' })
        }
        if (result.stopReason === 'cancelled') this.emit('turnCanceled')
        else this.emit('turnCompleted', { usage: result.usage || {} })
      })
      .catch((error) => this.emit('turnFailed', error))
    return { nativeTurnId: clientMessageId }
  }

  onSessionUpdate(update) {
    if (update.sessionUpdate === 'usage_update') {
      this.controlState = { ...this.controlState, contextUsage: normalizeContextUsage(update.used, update.size) }
      this.emit('controlState', this.controlState)
    } else if (update.sessionUpdate === 'config_option_update') {
      this.sessionControls.configOptions = update.configOptions || []
      this.refreshControlState()
      this.persistSessionControls()
    } else if (update.sessionUpdate === 'agent_message_chunk') {
      const text = contentText(update.content)
      if (text) {
        this.hasTurnOutput = true
        this.emit('timeline', { type: 'assistant_message', phase: 'final_answer', text })
      }
    } else if (update.sessionUpdate === 'agent_thought_chunk') {
      const text = contentText(update.content)
      if (text) {
        this.hasTurnOutput = true
        this.emit('timeline', { type: 'reasoning', text })
      }
    } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
      this.hasTurnOutput = true
      const statuses = { in_progress: 'running' }
      this.emit('timeline', {
        type: 'tool_call',
        callId: update.toolCallId,
        name: update.title || '工具调用',
        status: statuses[update.status] || update.status || 'running',
        detail: { type: 'acp_tool', kind: update.kind, content: update.content, rawInput: update.rawInput, rawOutput: update.rawOutput },
      })
    } else if (update.sessionUpdate === 'plan') {
      this.emit('timeline', {
        type: 'todo',
        items: (update.entries || []).map((entry) => ({ text: entry.content, status: entry.status })),
      })
    }
  }

  async cancel() {
    if (this.connection && this.sessionId) await this.connection.cancel({ sessionId: this.sessionId })
  }

  close() {
    const child = this.child
    this.child = null
    this.connection = null
    this.connected = false
    this.acceptUpdates = false
    if (child && !child.killed) child.kill('SIGTERM')
  }
}

export const kimiProvider = {
  id: 'kimi',
  label: 'Kimi',
  capabilities: { resume: true, cancel: true, images: true, models: true, reasoningEffort: true, contextUsage: true, protocol: 'acp' },
  createRuntime(options) {
    return new AcpRuntime({ ...options, command: 'kimi', args: ['acp'] })
  },
}
