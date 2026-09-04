import { EventEmitter } from 'node:events'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { filePromptText, imageBase64 } from '../promptAttachments.js'
import { createControlState, effortLabel, normalizeContextUsage } from '../controlState.js'
import { readClaudeHistorySnapshot } from '../history/providers/claudeHistory.js'

class AsyncMessageQueue {
  constructor() {
    this.values = []
    this.waiters = []
    this.closed = false
  }

  push(value) {
    if (this.closed) throw new Error('Claude 输入流已经关闭。')
    const waiter = this.waiters.shift()
    if (waiter) waiter({ value, done: false })
    else this.values.push(value)
  }

  close() {
    this.closed = true
    while (this.waiters.length) this.waiters.shift()({ value: undefined, done: true })
  }

  next() {
    if (this.values.length) return Promise.resolve({ value: this.values.shift(), done: false })
    if (this.closed) return Promise.resolve({ value: undefined, done: true })
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  [Symbol.asyncIterator]() {
    return this
  }
}

async function* userMessage(content) {
  yield {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  }
}

export async function buildClaudePrompt(content) {
  const hasImages = content.some((block) => block.type === 'image')
  const promptBlocks = await Promise.all(content.map(async (block) => {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'file') return { type: 'text', text: filePromptText(block) }
    return {
      type: 'image',
      source: { type: 'base64', media_type: block.mimeType, data: await imageBase64(block) },
    }
  }))
  return hasImages
    ? userMessage(promptBlocks)
    : promptBlocks.map((block) => block.text).join('\n')
}

async function buildClaudeUserMessage(content, clientMessageId) {
  const prompt = await buildClaudePrompt(content)
  if (typeof prompt !== 'string') {
    const { value } = await prompt[Symbol.asyncIterator]().next()
    return { ...value, uuid: clientMessageId }
  }
  return {
    type: 'user',
    message: { role: 'user', content: prompt },
    parent_tool_use_id: null,
    uuid: clientMessageId,
  }
}

function normalizeClaudeModels(items = []) {
  return items.map((item, index) => {
    const efforts = item.supportedEffortLevels || []
    return {
      id: item.value,
      label: item.displayName || item.value,
      description: item.description || '',
      isDefault: index === 0,
      defaultReasoningEffort: efforts.includes('high') ? 'high' : (efforts[0] || ''),
      reasoningEfforts: efforts.map((effort) => ({ id: effort, label: effortLabel(effort), description: '' })),
    }
  })
}

export class ClaudeRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '', config = {} }) {
    super()
    this.cwd = cwd
    this.sessionId = nativeHandle.sessionId || ''
    this.modelId = modelId
    this.reasoningEffort = config.reasoningEffort || ''
    this.controller = null
    this.runningQuery = null
    this.inputQueue = null
    this.connected = false
    this.closing = false
    this.cancelRequested = false
    this.connectPromise = null
    this.controlState = createControlState({ requestedModelId: modelId, requestedReasoningEffort: this.reasoningEffort })
  }

  async connect() {
    if (this.runningQuery && this.connected) return
    if (this.connectPromise) return this.connectPromise
    this.connectPromise = this.connectInternal()
    try {
      await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  async connectInternal() {
    const controller = new AbortController()
    const inputQueue = new AsyncMessageQueue()
    this.controller = controller
    this.inputQueue = inputQueue
    this.closing = false
    const runningQuery = query({
      prompt: inputQueue,
      options: {
        cwd: this.cwd,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(this.modelId ? { model: this.modelId } : {}),
        ...(this.reasoningEffort ? { effort: this.reasoningEffort, thinking: { type: 'adaptive' } } : {}),
        abortController: controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })
    this.runningQuery = runningQuery
    this.consume(runningQuery, controller)
    try {
      const models = normalizeClaudeModels(await runningQuery.supportedModels())
      this.controlState = createControlState({
        models,
        requestedModelId: this.modelId,
        requestedReasoningEffort: this.reasoningEffort,
        contextUsage: this.controlState.contextUsage,
      })
      this.modelId = this.controlState.currentModelId
      this.reasoningEffort = this.controlState.currentReasoningEffort
      await this.refreshContextUsage()
      this.connected = true
      this.emit('controlState', this.controlState)
    } catch (error) {
      if (this.runningQuery === runningQuery) {
        this.runningQuery = null
        this.inputQueue = null
        this.controller = null
      }
      this.connected = false
      this.closing = true
      inputQueue.close()
      controller.abort()
      runningQuery.close?.()
      throw error
    }
  }

  async getControlState() {
    await this.connect()
    return this.controlState
  }

  async readHistorySnapshot(options = {}) {
    return readClaudeHistorySnapshot({ cwd: this.cwd, sessionId: this.sessionId, ...options })
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    this.cancelRequested = false
    this.inputQueue.push(await buildClaudeUserMessage(content, clientMessageId))
    this.emit('turnStarted', { nativeTurnId: clientMessageId })
    return { nativeTurnId: clientMessageId }
  }

  async consume(stream, controller) {
    try {
      for await (const message of stream) {
        if (message.session_id && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id
          this.emit('handle', { sessionId: this.sessionId })
        }
        if (message.type === 'assistant') this.consumeAssistant(message)
        if (message.type === 'result') {
          await this.refreshContextUsage()
          if (this.cancelRequested) {
            this.cancelRequested = false
            this.emit('turnCanceled')
          } else if (message.subtype === 'success' && !message.is_error) this.emit('turnCompleted', { usage: message.usage || {} })
          else this.emit('turnFailed', new Error(message.errors?.join('\n') || message.result || 'Claude Turn 失败'))
        }
      }
    } catch (error) {
      if (this.closing || controller.signal.aborted || this.runningQuery !== stream) return
      this.emit('turnFailed', error)
    }
  }

  async refreshContextUsage() {
    if (!this.runningQuery) return
    try {
      const usage = await this.runningQuery.getContextUsage()
      this.controlState = {
        ...this.controlState,
        contextUsage: normalizeContextUsage(usage.totalTokens, usage.maxTokens),
      }
      this.emit('controlState', this.controlState)
    } catch {}
  }

  consumeAssistant(message) {
    const blocks = message.message?.content || []
    const hasToolUse = blocks.some((block) => block.type === 'tool_use')
    const phase = message.parent_tool_use_id || hasToolUse || message.message?.stop_reason === 'tool_use'
      ? 'commentary'
      : message.message?.stop_reason === 'end_turn' ? 'final_answer' : 'unknown'
    for (const block of blocks) {
      if (block.type === 'text') {
        this.emit('timeline', { type: 'assistant_message', messageId: message.message.id, phase, text: block.text || '' })
      } else if (block.type === 'thinking') {
        this.emit('timeline', { type: 'reasoning', messageId: message.message.id, text: block.thinking || '' })
      } else if (block.type === 'tool_use') {
        this.emit('timeline', {
          type: 'tool_call', callId: block.id, name: block.name, status: 'running',
          detail: { type: 'claude_tool', input: block.input },
        })
      }
    }
  }

  async cancel() {
    if (!this.runningQuery?.interrupt) return
    this.cancelRequested = true
    try {
      await this.runningQuery.interrupt()
    } catch (error) {
      this.cancelRequested = false
      throw error
    }
  }

  close() {
    this.closing = true
    this.connected = false
    this.cancelRequested = false
    this.inputQueue?.close()
    this.controller?.abort()
    this.runningQuery?.close?.()
    this.inputQueue = null
    this.runningQuery = null
    this.controller = null
  }
}

export const claudeProvider = {
  id: 'claude',
  label: 'Claude',
  capabilities: { resume: true, cancel: true, images: true, models: true, reasoningEffort: true, contextUsage: true },
  createRuntime(options) {
    return new ClaudeRuntime(options)
  },
}
