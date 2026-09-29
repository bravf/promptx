import { childEnvironment } from '../runtime/processControl.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import { CreateTerminalSchema, RenameTerminalSchema, TerminalSizeSchema, TerminalInputSchema, TerminalCursorSchema } from '../../../../packages/protocol/src/terminal.js'

export const TERMINAL_HISTORY_LIMIT = 256 * 1024
const LIMIT = TERMINAL_HISTORY_LIMIT

export class TerminalService {
  constructor(repository, spawn) {
    this.repository = repository
    this.spawn = spawn
    this.sessions = new Map()
    this.closed = false
    this.counters = new Map()
  }
  context(taskId) {
    const task = this.repository.getTask(taskId)
    const environment = task && this.repository.getEnvironment(task.environmentId)
    if (!task || task.lifecycle === 'archived' || !environment || ['missing', 'removed', 'unavailable'].includes(environment.status)) {
      throw Object.assign(new Error('会话或工作目录不可用'), { statusCode: 409 })
    }
    return environment
  }
  list(taskId) {
    this.context(taskId)
    this.sweep()
    return [...this.sessions.values()].filter(session => session.taskId === taskId).map(session => this.describe(session))
  }
  describe(session) {
    return { id: session.id, name: session.name, cwd: session.cwd, running: session.running, exitCode: session.exitCode, createdAt: session.createdAt }
  }
  async create(taskId, size, { requestId, ensure = false, name } = {}) {
    let environment = this.context(taskId)
    if (this.closed) throw Object.assign(new Error('服务正在关闭'), { statusCode: 503 })
    this.sweep()
    const findExisting = () => [...this.sessions.values()].find(session => session.taskId === taskId && ((requestId && session.requestId === requestId) || ensure))
    const existing = findExisting()
    if (existing) return existing
    if (!this.spawn && process.platform === 'darwin') {
      // node-pty 预编译包可能丢失 spawn-helper 的执行位。
      const root = path.dirname(createRequire(import.meta.url).resolve('node-pty/package.json'))
      for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
        const helper = path.join(root, relative)
        if (fs.existsSync(helper)) {
          const mode = fs.statSync(helper).mode
          if (!(mode & 0o100)) fs.chmodSync(helper, mode | 0o111)
        }
      }
    }
    const spawn = this.spawn || (await import('node-pty')).spawn
    // 动态导入后再次检查，确保重试和并发首次打开不会重复创建。
    const concurrent = findExisting()
    if (concurrent) return concurrent
    environment = this.context(taskId)
    if (this.closed) throw Object.assign(new Error('服务正在关闭'), { statusCode: 503 })
    const shell = process.platform === 'win32' ? (process.env.COMSPEC || 'cmd.exe') : (process.env.SHELL || '/bin/sh')
    const pty = spawn(shell, [], { name: 'xterm-256color', cwd: environment.cwd, ...size, env: childEnvironment({ TERM: 'xterm-256color' }) })
    const number = (this.counters.get(taskId) || 0) + 1
    this.counters.set(taskId, number)
    const session = { id: randomUUID(), taskId, requestId, name: name || `终端 ${number}`, createdAt: new Date().toISOString(), cwd: environment.cwd, environmentId: environment.id, pty, chunks: [], end: 0, start: 0, length: 0, exitCode: null, running: true, inputs: new Set() }
    this.sessions.set(session.id, session)
    pty.onData((data) => {
      session.end += data.length
      if (data.length > LIMIT) { session.chunks = []; session.length = 0; data = data.slice(-LIMIT); session.start = session.end - data.length }
      const last = session.chunks.at(-1)
      if (last && last.data.length + data.length <= 4096) { last.data += data; last.end = session.end }
      else session.chunks.push({ end: session.end, data })
      session.length += data.length
      while (session.length > LIMIT && session.chunks.length > 1) {
        const removed = session.chunks.shift()
        session.length -= removed.data.length
        session.start = removed.end
      }
    })
    pty.onExit(({ exitCode }) => { session.running = false; session.exitCode = exitCode })
    return session
  }
  get(taskId, id) {
    const environment = this.context(taskId)
    const session = this.sessions.get(id)
    if (session && session.taskId === taskId && (session.cwd !== environment.cwd || session.environmentId !== environment.id)) {
      this.remove(id)
      throw Object.assign(new Error('会话工作目录已改变，请新建终端'), { statusCode: 409 })
    }
    if (!session || session.taskId !== taskId) throw Object.assign(new Error('终端已结束或已重建，请重新打开'), { statusCode: 409 })
    return session
  }
  read(session, cursor = 0) {
    const reset = cursor < session.start || cursor > session.end
    const offset = reset ? session.start : cursor
    const data = session.chunks.filter((chunk) => chunk.end > offset).map((chunk) => chunk.data.slice(Math.max(0, offset - (chunk.end - chunk.data.length)))).join('')
    return { id: session.id, cwd: session.cwd, data, cursor: session.end, reset, running: session.running, exitCode: session.exitCode }
  }
  remove(id) {
    const session = this.sessions.get(id)
    if (!session) return
    this.sessions.delete(id)
    if (session.running) session.pty.kill()
  }
  sweep() {
    for (const [id, session] of this.sessions) {
      try { const env = this.context(session.taskId); if (env.id !== session.environmentId || env.cwd !== session.cwd) this.remove(id) }
      catch { this.remove(id) }
    }
    for (const taskId of this.counters.keys()) {
      if (!this.repository.getTask(taskId)) this.counters.delete(taskId)
    }
  }
  close() { this.closed = true; for (const id of this.sessions.keys()) this.remove(id) }
}

export function registerTerminalRoutes(app, repository, service = new TerminalService(repository)) {
  const timer = setInterval(() => service.sweep(), 2000)
  timer.unref()
  app.addHook('onClose', async () => { clearInterval(timer); service.close() })
  const prefix = '/api/v2/tasks/:taskId/terminals'
  const terminalPath = `${prefix}/:terminalId`
  const get = request => service.get(request.params.taskId, request.params.terminalId)
  app.get(prefix, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return { terminals: service.list(request.params.taskId) }
  })
  app.post(prefix, async (request) => {
    const { requestId, ensure, cols, rows } = CreateTerminalSchema.parse(request.body)
    const session = await service.create(request.params.taskId, { cols, rows }, { requestId, ensure })
    return { terminal: service.describe(session) }
  })
  app.get(terminalPath, async (request, reply) => {
    reply.header('Cache-Control', 'no-store')
    return service.read(get(request), TerminalCursorSchema.parse(request.query).cursor)
  })
  app.patch(terminalPath, async request => {
    const { name } = RenameTerminalSchema.parse(request.body)
    const session = get(request)
    session.name = name
    return { terminal: service.describe(session) }
  })
  app.post(`${terminalPath}/input`, async (request) => {
    const input = TerminalInputSchema.parse(request.body)
    const session = get(request)
    if (!session.running) throw Object.assign(new Error('终端进程已退出'), { statusCode: 409 })
    if (!session.inputs.has(input.id)) {
      session.pty.write(input.data)
      session.inputs.add(input.id)
      if (session.inputs.size > 512) session.inputs.delete(session.inputs.values().next().value)
    }
    return { ok: true }
  })
  app.post(`${terminalPath}/resize`, async (request) => {
    const size = TerminalSizeSchema.parse(request.body)
    const session = get(request)
    if (session.running) session.pty.resize(size.cols, size.rows)
    return { ok: true }
  })
  app.delete(terminalPath, async (request) => {
    const session = get(request)
    service.remove(session.id)
    return { ok: true }
  })
  app.post(`${terminalPath}/restart`, async (request) => {
    const size = TerminalSizeSchema.parse(request.body)
    const session = get(request)
    if (session.running) throw Object.assign(new Error('请先结束进程再重启'), { statusCode: 409 })
    // 原 ID 作为幂等标识，新终端继承名称；先创建成功才移除退出记录。
    const next = await service.create(request.params.taskId, size, { requestId: session.id, name: session.name })
    service.remove(session.id)
    return { terminal: service.describe(next) }
  })
}
