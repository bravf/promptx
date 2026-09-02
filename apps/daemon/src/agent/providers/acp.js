import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Readable, Writable } from 'node:stream'
import { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } from '@agentclientprotocol/sdk'

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
  constructor({ cwd, nativeHandle = {}, command = 'kimi', args = ['acp'] }) {
    super()
    this.cwd = cwd
    this.sessionId = nativeHandle.sessionId || ''
    this.command = command
    this.args = args
    this.child = null
    this.connection = null
    this.acceptUpdates = false
    this.hasTurnOutput = false
  }

  async connect() {
    if (this.connection) return
    this.child = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()))
    this.child.on('exit', () => {
      this.connection = null
      this.child = null
      this.emit('runtimeExit')
    })
    const stream = ndJsonStream(Writable.toWeb(this.child.stdin), Readable.toWeb(this.child.stdout))
    this.connection = new ClientSideConnection(() => ({
      requestPermission: async (params) => selectPermission(params.options),
      sessionUpdate: async (params) => {
        if (this.acceptUpdates) this.onSessionUpdate(params.update)
      },
    }), stream)
    await this.connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientInfo: { name: 'promptx', title: 'PromptX', version: '2.0.0' },
      clientCapabilities: {},
    })
    const result = this.sessionId
      ? await this.connection.loadSession({ sessionId: this.sessionId, cwd: this.cwd, mcpServers: [] })
      : await this.connection.newSession({ cwd: this.cwd, mcpServers: [] })
    this.sessionId = result.sessionId || this.sessionId
    this.emit('handle', { sessionId: this.sessionId })
    this.acceptUpdates = true
  }

  async startTurn(content, clientMessageId) {
    await this.connect()
    this.hasTurnOutput = false
    const prompt = content.map((block) => block.type === 'text'
      ? { type: 'text', text: block.text }
      : { type: 'image', data: block.data || '', mimeType: block.mimeType })
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
    if (update.sessionUpdate === 'agent_message_chunk') {
      const text = contentText(update.content)
      if (text) {
        this.hasTurnOutput = true
        this.emit('timeline', { type: 'assistant_message', text })
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
    if (this.child && !this.child.killed) this.child.kill('SIGTERM')
    this.child = null
    this.connection = null
  }
}

export const kimiProvider = {
  id: 'kimi',
  label: 'Kimi',
  capabilities: { resume: true, cancel: true, images: true, protocol: 'acp' },
  createRuntime(options) {
    return new AcpRuntime({ ...options, command: 'kimi', args: ['acp'] })
  },
}
