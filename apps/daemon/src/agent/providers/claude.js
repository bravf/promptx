import { childEnvironment } from '../../runtime/processControl.js'
import { randomUUID } from 'node:crypto'
import { isClaudeNoResponsePlaceholder } from './claudeMessages.js'
import { BackgroundTasks, taskStatus } from './backgroundTasks.js'
import { PendingInteractions } from './pendingInteractions.js'
import { normalizeInteractionQuestions } from '../../../../../packages/protocol/src/interaction.js'
import { EventEmitter } from 'node:events'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { filePromptText, imageBase64 } from '../promptAttachments.js'
import { createControlState, effortLabel, normalizeContextUsage } from '../controlState.js'
import { readClaudeHistorySnapshot, listClaudeHistorySessions } from '../history/providers/claudeHistory.js'

// 只缓存工作区的选项目录，不共享会话选择或上下文用量。
const modelCatalogs = new Map()
const MODEL_CATALOG_TTL = 5 * 60 * 1000

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
  constructor({ cwd, nativeHandle = {}, modelId = '', config = {}, queryFactory = query }) {
    super()
    this.cwd = cwd
    this.queryFactory = queryFactory
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
    this.activeRunId = null
    this.backgroundTasks = new BackgroundTasks(this)
    this.interactions = new PendingInteractions(this)
    this.toolCalls = new Map()
    this.toolParents = new Map()
    this.controlState = createControlState({ requestedModelId: modelId, requestedReasoningEffort: this.reasoningEffort })
  }

  async prepareTurn() { await this.connect() }

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
    const runningQuery = this.queryFactory({
      prompt: inputQueue,
      options: {
        cwd: this.cwd,
        env: childEnvironment(),
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(this.modelId ? { model: this.modelId } : {}),
        ...(this.reasoningEffort ? { effort: this.reasoningEffort, thinking: { type: 'adaptive' } } : {}),
        abortController: controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        canUseTool: (name, input, options) => this.handleToolInteraction(name, input, options),
      },
    })
    this.runningQuery = runningQuery
    this.consume(runningQuery, controller)
    try {
      const models = normalizeClaudeModels(await runningQuery.supportedModels())
      if (this.runningQuery !== runningQuery || controller.signal.aborted) throw new Error('Claude 连接已关闭。')
      if (models.length) {
        modelCatalogs.delete(this.cwd)
        modelCatalogs.set(this.cwd, { models, expiresAt: Date.now() + MODEL_CATALOG_TTL })
        if (modelCatalogs.size > 32) modelCatalogs.delete(modelCatalogs.keys().next().value)
      }
      this.controlState = createControlState({
        models,
        requestedModelId: this.modelId,
        requestedReasoningEffort: this.reasoningEffort,
        contextUsage: this.controlState.contextUsage,
      })
      this.modelId = this.controlState.currentModelId
      this.reasoningEffort = this.controlState.currentReasoningEffort
      this.connected = true
      this.emit('controlState', this.controlState)
      void this.refreshContextUsage()
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
    if (this.connected) return this.controlState
    const cached = modelCatalogs.get(this.cwd)
    if (cached?.expiresAt > Date.now()) {
      this.controlState = createControlState({
        models: cached.models,
        requestedModelId: this.modelId,
        requestedReasoningEffort: this.reasoningEffort,
        contextUsage: this.controlState.contextUsage,
      })
      return this.controlState
    }
    await this.connect()
    return this.controlState
  }

  handleToolInteraction(name, input, { signal } = {}) {
    if (!['AskUserQuestion', 'ExitPlanMode'].includes(name)) return Promise.resolve({ behavior: 'allow', updatedInput: input })
    const question = name === 'AskUserQuestion'
    return this.interactions.ask(question ? {
      kind: 'question', title: '需要你回答',
      questions: normalizeInteractionQuestions(input.questions, { allowOther: true }),
    } : {
      kind: 'plan', title: '确认执行计划', description: String(input.plan || 'Agent 希望结束规划并开始执行。'),
      actions: [{ id: 'implement', label: '按计划执行' }],
    }, {
      signal,
      respond: (response, answers) => response.decision === 'answer' ? {
        behavior: 'allow', updatedInput: question ? { ...input, answers: Object.fromEntries(
          input.questions.map((item, index) => [item.question, answers[String(item.id || index)].join(', ')]),
        ) } : input,
      } : { behavior: 'deny', message: '用户取消了这个询问。' },
    })
  }

  async readHistorySnapshot(options = {}) {
    return readClaudeHistorySnapshot({ cwd: this.cwd, sessionId: this.sessionId, ...options })
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    this.cancelRequested = false
    if (this.toolCalls.size > 1000) this.toolCalls.clear()
    const message = await buildClaudeUserMessage(content, clientMessageId)
    if (this.activeRunId) throw new Error('Claude 已开始自动续跑，请稍后重试。')
    this.activeRunId = clientMessageId
    this.emit('turnStarted', { nativeTurnId: clientMessageId })
    this.inputQueue.push(message)
    return { nativeTurnId: clientMessageId }
  }

  async consume(stream, controller) {
    try {
      for await (const message of stream) {
        if (message.session_id && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id
          this.emit('handle', { sessionId: this.sessionId })
        }
        if (this.runningQuery !== stream || this.closing) return
        if (isClaudeNoResponsePlaceholder(message)) continue
        this.consumeToolOwnership(message)
        if (message.type === 'system') this.consumeTask(message)
        if (message.type === 'user' && !message.parent_tool_use_id && Array.isArray(message.message?.content)) {
          for (const block of message.message.content) {
            const tool = this.toolCalls.get(block.tool_use_id)
            if (block.type === 'tool_result' && tool) this.emit('timeline', { ...tool, status: block.is_error ? 'failed' : 'completed', detail: { ...tool.detail, output: block.content } })
          }
        }
        if (message.type === 'assistant' && !message.parent_tool_use_id) {
          if (!this.activeRunId && !this.cancelRequested) {
            this.activeRunId = `claude:${message.uuid || randomUUID()}`
            this.emit('turnStarted', { nativeTurnId: this.activeRunId, autonomous: true })
          }
          if (this.activeRunId) this.consumeAssistant(message)
        } else if (message.type === 'assistant' && message.parent_tool_use_id) {
          const task = [...this.backgroundTasks.tasks.values()].find(task => task.callId === message.parent_tool_use_id)
          if (task) {
            const text = (message.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('\n')
            if (text) this.backgroundTasks.update({ id: task.id, summary: text })
          }
        }
        if (message.type === 'result') {
          const nativeTurnId = this.activeRunId
          this.activeRunId = null
          if (!nativeTurnId) { this.cancelRequested = false; continue }
          void this.refreshContextUsage()
          if (this.cancelRequested) {
            this.cancelRequested = false
            this.emit('turnCanceled', { nativeTurnId })
          } else if (message.subtype === 'success' && !message.is_error) this.emit('turnCompleted', { nativeTurnId, usage: message.usage || {} })
          else this.emit('turnFailed', Object.assign(new Error(message.errors?.join('\n') || message.result || 'Claude Turn 失败'), { nativeTurnId }))
        }
      }
      if (!this.closing && this.runningQuery === stream) throw new Error('Claude 消息流意外结束。')
    } catch (error) {
      if (this.closing || controller.signal.aborted || this.runningQuery !== stream) return
      this.interactions.expire('Claude 消息流已结束。')
      this.emit('turnFailed', error)
      this.backgroundTasks.interrupt('Claude 进程退出，后台任务已中断')
      this.connected = false
      this.runningQuery = null
      this.activeRunId = null
      this.emit('runtimeExit')
    }
  }

  consumeToolOwnership(message) {
    const calls = message.type === 'assistant'
      ? (message.message?.content || []).filter(block => block.type === 'tool_use').map(block => block.id)
      : message.type === 'tool_progress' ? [message.tool_use_id] : []
    for (const callId of calls) {
      const parentCallId = message.parent_tool_use_id || null
      this.toolParents.set(callId, parentCallId)
      for (const task of this.backgroundTasks.tasks.values()) {
        if (task.callId === callId && task.parentCallId !== parentCallId) this.backgroundTasks.update({ id: task.id, parentCallId })
      }
    }
  }

  consumeTask(message) {
    const id = message.task_id
    if (message.subtype === 'task_started') {
      this.backgroundTasks.update({ id, callId: message.tool_use_id, ...(this.toolParents.has(message.tool_use_id) ? { parentCallId: this.toolParents.get(message.tool_use_id) } : {}), title: message.description || '后台任务', kind: message.task_type || 'task', status: 'running', background: Boolean(message.is_backgrounded), ambient: Boolean(message.ambient || message.skip_transcript), depth: message.spawn_depth || 1 })
    } else if (id && this.backgroundTasks.tasks.has(id)) {
      if (message.subtype === 'task_notification') this.backgroundTasks.update({ id, status: taskStatus(message.status), summary: message.summary || '', usage: message.usage })
      if (message.subtype === 'task_updated') {
        const patch = message.patch || {}
        this.backgroundTasks.update({ id, ...(patch.status ? { status: taskStatus(patch.status) } : {}), ...(patch.is_backgrounded !== undefined ? { background: patch.is_backgrounded } : {}) })
      }
      if (message.subtype === 'task_progress') this.backgroundTasks.update({ id, summary: message.summary || message.description || '', usage: message.usage })
    }
    if (message.subtype === 'background_tasks_changed') {
      // 集合事件可能先于 started；只补充声明，不根据消失猜测成功/失败。
      for (const task of message.tasks || []) if (!this.backgroundTasks.tasks.has(task.task_id)) {
        this.backgroundTasks.update({ id: task.task_id, title: task.description || '后台任务', kind: task.task_type, status: 'running', background: true, ambient: Boolean(task.ambient) })
      }
    }
  }

  async stopBackgroundTasks() {
    const results = await Promise.allSettled(this.backgroundTasks.running.map(task => this.runningQuery.stopTask(task.id)))
    const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
    if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('；'))
  }

  async refreshContextUsage() {
    const runningQuery = this.runningQuery
    if (!runningQuery) return
    try {
      const usage = await runningQuery.getContextUsage()
      if (this.runningQuery !== runningQuery || this.closing) return
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
        const item = { type: 'tool_call', callId: block.id, name: block.name, status: 'running', detail: { type: 'claude_tool', input: block.input } }
        this.toolCalls.set(block.id, item)
        this.emit('timeline', item)
      }
    }
  }

  async cancel() {
    if (!this.runningQuery?.interrupt) return
    this.cancelRequested = true
    this.interactions.expire('任务已取消。')
    try {
      await this.runningQuery.interrupt()
    } catch (error) {
      this.cancelRequested = false
      throw error
    }
  }

  close() {
    this.interactions.expire('会话连接已关闭。')
    this.backgroundTasks.interrupt()
    this.activeRunId = null
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
  listHistorySessions: listClaudeHistorySessions,
  label: 'Claude',
  capabilities: { backgroundTasks: true, backgroundTaskDetails: true, stopBackgroundTasks: true, autonomousTurns: true, resume: true, cancel: true, images: true, models: true, reasoningEffort: true, contextUsage: true },
  createRuntime(options) {
    return new ClaudeRuntime(options)
  },
}
