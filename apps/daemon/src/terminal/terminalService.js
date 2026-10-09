import { childEnvironment, terminateChild } from '../runtime/processControl.js'
import { randomUUID } from 'node:crypto'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { CreateTerminalSchema, RenameTerminalSchema, TerminalSizeSchema, TerminalInputSchema, TerminalCursorSchema } from '../../../../packages/protocol/src/terminal.js'

export const TERMINAL_HISTORY_LIMIT = 256 * 1024
const LIMIT = TERMINAL_HISTORY_LIMIT

export class TerminalService {
  constructor(repository, spawn, onChange = () => {}) {
    this.repository = repository
    this.spawn = spawn
    this.sessions = new Map()
    this.closed = false
    this.counters = new Map()
    this.onChange = onChange
    this.serviceOperations = new Map()
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
    return { id: session.id, name: session.name, cwd: session.cwd, running: session.running, exitCode: session.exitCode, createdAt: session.createdAt,
      ...(session.service ? { service: { ...session.service }, stopping: Boolean(session.stopping) } : {}) }
  }
  notify(taskId, openTerminalId) {
    if (!this.closed) this.onChange(taskId, openTerminalId)
  }
  serviceSnapshot(taskId) {
    return [...this.sessions.values()].filter(session => session.taskId === taskId && session.service).map(session => this.describe(session))
  }
  async create(taskId, size, { requestId, ensure = false, name, command = '', cwd, service } = {}) {
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
    const args = command ? (process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command]) : []
    const pty = spawn(shell, args, { name: 'xterm-256color', cwd: cwd || environment.cwd, ...size, env: childEnvironment({ TERM: 'xterm-256color' }) })
    const number = (this.counters.get(taskId) || 0) + 1
    this.counters.set(taskId, number)
    const session = { id: randomUUID(), taskId, requestId, name: name || `终端 ${number}`, createdAt: new Date().toISOString(), cwd: cwd || environment.cwd, environmentCwd: environment.cwd, environmentId: environment.id, pty, chunks: [], end: 0, start: 0, length: 0, exitCode: null, running: true, inputs: new Set(), service }
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
    pty.onExit(({ exitCode }) => {
      session.running = false
      session.stopping = false
      session.exitCode = exitCode
      if (session.service && this.sessions.has(session.id)) this.notify(taskId)
    })
    return session
  }
  get(taskId, id) {
    const environment = this.context(taskId)
    const session = this.sessions.get(id)
    if (session && session.taskId === taskId && (session.environmentCwd !== environment.cwd || session.environmentId !== environment.id)) {
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
    this.stop(session)
    if (session.service) this.notify(session.taskId)
  }
  stop(session) {
    if (!session.running || session.stopping) return
    session.stopping = true
    if (session.service && process.platform !== 'win32' && session.pty.pid) {
      // node-pty 创建独立会话；清理整组服务子进程，不能只杀掉外层 shell。
      terminateChild({ pid: session.pty.pid, exitCode: null, promptxProcessGroup: true, kill: signal => session.pty.kill(signal) })
    } else session.pty.kill()
    if (session.service && this.sessions.has(session.id)) this.notify(session.taskId)
  }
  listServices(taskId) {
    return this.list(taskId).filter(session => session.service)
  }
  async serviceCwd(taskId, cwd = '.') {
    const root = await fs.promises.realpath(this.context(taskId).cwd)
    const target = await fs.promises.realpath(path.resolve(root, cwd))
    const relative = path.relative(root, target)
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await fs.promises.stat(target)).isDirectory()) {
      throw Object.assign(new Error('服务工作目录必须位于当前会话的工作区内。'), { statusCode: 400 })
    }
    return target
  }
  async startService(taskId, input) {
    if (input.url) {
      const url = new URL(input.url)
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
        throw Object.assign(new Error('就绪检查地址必须是本机 HTTP 地址。'), { statusCode: 400 })
      }
    }
    const cwd = await this.serviceCwd(taskId, input.cwd)
    const key = JSON.stringify([taskId, cwd, input.command])
    if (this.serviceOperations.has(key)) return this.serviceOperations.get(key)
    const operation = (async () => {
      const existing = [...this.sessions.values()].find(session => session.taskId === taskId && session.cwd === cwd && session.service?.command === input.command && session.running)
      if (existing?.stopping) throw Object.assign(new Error('服务正在停止，请等待进程退出后再启动。'), { statusCode: 409 })
      if (existing) return { terminal: this.describe(existing), reused: true }
      if (input.url && await this.portInUse(input.url)) throw Object.assign(new Error('指定的服务端口已被占用，请检查已有服务或改用其他端口。'), { statusCode: 409 })
      const session = await this.create(taskId, { cols: 100, rows: 30 }, { name: input.name, cwd, command: input.command,
        service: { command: input.command, url: input.url || '', readiness: 'starting' } })
      this.notify(taskId, session.id)
      await this.checkService(session, input.waitMs)
      this.notify(taskId)
      return { terminal: this.describe(session), reused: false, ...this.read(session) }
    })()
    this.serviceOperations.set(key, operation)
    try { return await operation } finally { this.serviceOperations.delete(key) }
  }
  async portInUse(address) {
    const url = new URL(address)
    return new Promise(resolve => {
      const socket = net.createConnection({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)) })
      const finish = value => { socket.destroy(); resolve(value) }
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
      socket.setTimeout(500, () => finish(false))
    })
  }
  async checkService(session, waitMs = 8000) {
    const deadline = Date.now() + waitMs
    const stableAfter = Date.now() + 300
    do {
      if (this.closed || !session.running || session.stopping || !this.sessions.has(session.id)) break
      if (!session.service.url) {
        const text = this.read(session).data.replace(/\x1b\[[0-9;]*m/g, '')
        const urls = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+(?:\/[^\s\x1b]*)?/g)
        if (urls?.length) session.service.url = urls.at(-1).replace('0.0.0.0', '127.0.0.1')
      }
      if (session.service.url) {
        try {
          const response = await fetch(session.service.url, { signal: AbortSignal.timeout(500), redirect: 'manual' })
          await response.body?.cancel()
          if (response.status >= 200 && response.status < 400 && Date.now() >= stableAfter && session.running && !session.stopping && !this.closed && this.sessions.has(session.id)) { session.service.readiness = 'ready'; return }
        } catch {} // 启动中可能还没有监听端口。
      }
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
    session.service.readiness = !session.running ? 'failed' : 'unverified'
  }
  async restartService(taskId, id) {
    const session = this.get(taskId, id)
    if (!session.service) throw Object.assign(new Error('这个终端不是托管服务。'), { statusCode: 400 })
    if (session.running) throw Object.assign(new Error('请先停止服务，等待进程退出后再重启。'), { statusCode: 409 })
    const result = await this.startService(taskId, { name: session.name, cwd: session.cwd, command: session.service.command, url: session.service.url || undefined, waitMs: 8000 })
    this.remove(id)
    return result
  }
  sweep() {
    for (const [id, session] of this.sessions) {
      try { const env = this.context(session.taskId); if (env.id !== session.environmentId || env.cwd !== session.environmentCwd) this.remove(id) }
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
    if (session.service) service.notify(session.taskId)
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
    if (session.service) return service.restartService(request.params.taskId, session.id)
    if (session.running) throw Object.assign(new Error('请先结束进程再重启'), { statusCode: 409 })
    // 原 ID 作为幂等标识，新终端继承名称；先创建成功才移除退出记录。
    const next = await service.create(request.params.taskId, size, { requestId: session.id, name: session.name })
    service.remove(session.id)
    return { terminal: service.describe(next) }
  })
  app.get('/api/v2/tasks/:taskId/services', async request => ({ services: service.listServices(request.params.taskId) }))
  app.post(`${terminalPath}/stop`, async request => { service.stop(get(request)); return { ok: true } })
}
