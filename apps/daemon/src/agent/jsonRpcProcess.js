import { childEnvironment, terminateChild } from '../runtime/processControl.js'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { EventEmitter } from 'node:events'

export class JsonRpcProcess extends EventEmitter {
  constructor(command, args = [], options = {}) {
    super()
    this.nextId = 1
    this.requestTimeoutMs = options.requestTimeoutMs ?? 60_000
    this.closed = false
    this.pending = new Map()
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: childEnvironment(options.env),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32',
    })
    this.child.promptxProcessGroup = process.platform !== 'win32'
    this.child.stdin.on('error', (error) => { this.failPending(error); this.close() })
    const stdout = createInterface({ input: this.child.stdout })
    stdout.on('line', (line) => this.handleLine(line))
    this.child.stderr.on('data', (chunk) => this.emit('stderr', chunk.toString()))
    this.child.on('error', (error) => this.failPending(error))
    this.child.on('exit', (code, signal) => {
      const error = new Error(`进程已退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`)
      this.failPending(error)
      this.emit('exit', { code, signal })
    })
  }

  handleLine(line) {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      this.emit('protocolError', new Error(`无法解析 JSON-RPC 消息：${line.slice(0, 200)}`))
      return
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      clearTimeout(pending.timer)
      if (message.error) pending.reject(new Error(message.error.message || 'JSON-RPC 请求失败'))
      else pending.resolve(message.result)
      return
    }
    if (message.id !== undefined && message.method) {
      this.emit('request', message)
      return
    }
    if (message.method) this.emit('notification', message)
  }

  send(message) {
    if (this.closed || !this.child.stdin.writable) throw new Error('Agent 进程不可写。')
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) { this.failPending(error); this.close() }
    })
  }

  request(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.failPending(new Error(`JSON-RPC ${method} 请求超时。`))
        this.close()
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      try { this.send({ jsonrpc: '2.0', id, method, params }) } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  notify(method, params = {}) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  respond(id, result) {
    this.send({ jsonrpc: '2.0', id, result })
  }

  respondError(id, code, message) {
    this.send({ jsonrpc: '2.0', id, error: { code, message } })
  }

  failPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
    this.pending.clear()
  }

  close() {
    this.closed = true
    this.failPending(new Error('Agent 连接已关闭。'))
    terminateChild(this.child)
  }
}
