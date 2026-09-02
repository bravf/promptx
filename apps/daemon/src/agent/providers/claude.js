import { EventEmitter } from 'node:events'
import { query } from '@anthropic-ai/claude-agent-sdk'

export class ClaudeRuntime extends EventEmitter {
  constructor({ cwd, nativeHandle = {}, modelId = '' }) {
    super()
    this.cwd = cwd
    this.sessionId = nativeHandle.sessionId || ''
    this.modelId = modelId
    this.controller = null
    this.runningQuery = null
  }

  async startTurn(content) {
    const prompt = content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
    this.controller = new AbortController()
    this.runningQuery = query({
      prompt,
      options: {
        cwd: this.cwd,
        ...(this.sessionId ? { resume: this.sessionId } : {}),
        ...(this.modelId ? { model: this.modelId } : {}),
        abortController: this.controller,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })
    this.consume(this.runningQuery)
    return { nativeTurnId: '' }
  }

  async consume(stream) {
    try {
      for await (const message of stream) {
        if (message.session_id && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id
          this.emit('handle', { sessionId: this.sessionId })
        }
        if (message.type === 'assistant') this.consumeAssistant(message)
        if (message.type === 'result') {
          if (message.subtype === 'success' && !message.is_error) this.emit('turnCompleted', { usage: message.usage || {} })
          else this.emit('turnFailed', new Error(message.errors?.join('\n') || message.result || 'Claude Turn 失败'))
        }
      }
    } catch (error) {
      if (this.controller?.signal.aborted) this.emit('turnCanceled')
      else this.emit('turnFailed', error)
    } finally {
      this.runningQuery = null
      this.controller = null
    }
  }

  consumeAssistant(message) {
    for (const block of message.message?.content || []) {
      if (block.type === 'text') {
        this.emit('timeline', { type: 'assistant_message', messageId: message.message.id, text: block.text || '' })
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
    this.controller?.abort()
  }

  close() {
    this.controller?.abort()
    this.runningQuery?.close?.()
  }
}

export const claudeProvider = {
  id: 'claude',
  label: 'Claude',
  capabilities: { resume: true, cancel: true, images: false },
  createRuntime(options) {
    return new ClaudeRuntime(options)
  },
}
