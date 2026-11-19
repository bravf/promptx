import { childEnvironment, isProcessGroupAlive, isSameLiveProcessGroup, processGroupIdentity, terminateChild } from '../runtime/processControl.js'
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
      if (session.service) session.service.stoppedByUser = Boolean(session.stopping)
      session.stopping = false
      session.exitCode = exitCode
      if (session.service && exitCode) session.service.error = this.read(session).data.slice(-600).trim() || `进程退出码：${exitCode}`
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
    if (session.service && !session.preserveService) this.repository.deleteManagedService?.(id)
    this.stop(session)
    if (session.service) this.notify(session.taskId)
  }
  stop(session) {
    if (!session.running || session.stopping) return
    if (session.service && !session.preserveService) this.repository.setManagedServiceAutoStart?.(session.id, false)
    session.stopping = true
    if (session.service && process.platform !== 'win32' && (session.pty?.pid || session.processPid)) {
      // node-pty 创建独立会话；清理整组服务子进程，不能只杀掉外层 shell。
      const pid = session.pty?.pid || session.processPid
      if (session.pty) terminateChild({ pid, exitCode: null, promptxProcessGroup: true, kill: signal => session.pty.kill(signal) })
      else this.stopRecoveredProcess(session, pid)
    } else session.pty.kill()
    if (session.service && this.sessions.has(session.id)) this.notify(session.taskId)
  }
  stopRecoveredProcess(session, pid) {
    const signalGroup = signal => { try { process.kill(-pid, signal) } catch {} }
    signalGroup('SIGTERM')
    const timer = setInterval(() => {
      if (!isProcessGroupAlive(pid)) {
        clearInterval(timer)
        session.running = false
        session.stopping = false
        session.exitCode = 0
        session.service.stoppedByUser = true
        this.notify(session.taskId)
      }
    }, 100)
    timer.unref()
    const forceTimer = setTimeout(() => signalGroup('SIGKILL'), 2000)
    forceTimer.unref()
    setTimeout(() => {
      clearInterval(timer)
      clearTimeout(forceTimer)
      if (session.running) {
        session.running = false
        session.stopping = false
        session.exitCode = 1
        session.service.error = '未能确认旧进程组已退出，请检查服务进程。'
        this.notify(session.taskId)
      }
    }, 2500).unref()
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
    const type = input.type || ((input.url || input.healthUrl) ? 'web' : /\.app\/Contents\/MacOS\//.test(input.command) ? 'desktop' : 'process')
    if (type !== 'web' && (input.url || input.healthUrl)) throw Object.assign(new Error('仅 Web 服务可以配置访问地址。'), { statusCode: 400 })
    if (type === 'desktop' && /^\s*(?:\/usr\/bin\/)?open(?:\s|$)/.test(input.command)) {
      throw Object.assign(new Error('请直接以前台方式运行 .app/Contents/MacOS/ 中的程序，不要使用 open，以便跟踪和停止实际应用进程。'), { statusCode: 400 })
    }
    for (const address of [input.url, input.healthUrl].filter(Boolean)) {
      const url = new URL(address)
      if (!['http:', 'https:'].includes(url.protocol) || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password) {
        throw Object.assign(new Error('就绪检查地址必须是本机 HTTP 地址。'), { statusCode: 400 })
      }
    }
    if (input.url && /^\/(?:api|healthz?|metrics|readyz?)(?:\/|$)/i.test(new URL(input.url).pathname)) {
      input = { ...input, healthUrl: input.healthUrl || input.url, url: undefined }
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
        service: { type, command: input.command, url: input.url || '', healthUrl: input.healthUrl || '', readiness: 'starting' } })
      this.persistService(session, true)
      for (const previous of [...this.sessions.values()]) {
        if (previous.id !== session.id && previous.taskId === taskId && previous.service && !previous.running && previous.cwd === cwd && previous.service.command === input.command) this.remove(previous.id)
      }
      this.notify(taskId)
      await this.checkService(session, input.waitMs)
      this.persistService(session, true)
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
      if (['desktop', 'watch', 'remote'].includes(session.service.type)) {
        if (Date.now() >= stableAfter) { session.service.readiness = 'running'; return }
      } else if (!session.service.url) {
        const text = this.read(session).data.replace(/\x1b\[[0-9;]*m/g, '')
        const urls = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0):\d+(?:\/[^\s\x1b]*)?/g)
        if (urls?.length) {
          const candidates = urls.map(value => value.replace('0.0.0.0', '127.0.0.1'))
          const page = candidates.find(value => !/^\/(?:api|healthz?|metrics|readyz?)(?:\/|$)/i.test(new URL(value).pathname))
          if (page) session.service.url = page
          else if (!session.service.healthUrl) session.service.healthUrl = candidates[0]
          session.service.type = 'web'
        }
      }
      if (session.service.healthUrl || session.service.url) {
        try {
          const response = await fetch(session.service.healthUrl || session.service.url, { signal: AbortSignal.timeout(500), redirect: 'manual' })
          await response.body?.cancel()
          if (response.status >= 200 && response.status < 400 && Date.now() >= stableAfter && session.running && !session.stopping && !this.closed && this.sessions.has(session.id)) { session.service.readiness = 'ready'; return }
        } catch {} // 启动中可能还没有监听端口。
      }
      if (Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 150))
    } while (Date.now() < deadline)
    session.service.readiness = !session.running ? 'failed' : session.service.type === 'web' ? 'unverified' : 'running'
  }
  async restartService(taskId, id) {
    const session = this.get(taskId, id)
    if (!session.service) throw Object.assign(new Error('这个终端不是托管服务。'), { statusCode: 400 })
    if (session.running) throw Object.assign(new Error('请先停止服务，等待进程退出后再重启。'), { statusCode: 409 })
    const result = await this.startService(taskId, { name: session.name, type: session.service.type, cwd: session.cwd, command: session.service.command, url: session.service.url || undefined, healthUrl: session.service.healthUrl || undefined, waitMs: 8000 })
    this.remove(id)
    return result
  }
  persistService(session, autoStart) {
    this.repository.saveManagedService?.({ terminalId: session.id, taskId: session.taskId, name: session.name,
      cwd: session.cwd, command: session.service.command, service: session.service, autoStart, createdAt: session.createdAt,
      processPid: session.pty?.pid || session.processPid, processIdentity: session.processIdentity || processGroupIdentity(session.pty?.pid) })
  }
  async restoreServices() {
    const saved = this.repository.listManagedServices?.() || []
    for (const item of saved) {
      if (!item.autoStart) {
        const task = this.repository.getTask(item.taskId)
        const environment = task && this.repository.getEnvironment(task.environmentId)
        if (!task || task.lifecycle !== 'active' || !environment) {
          this.repository.deleteManagedService?.(item.terminalId)
          continue
        }
        this.sessions.set(item.terminalId, { id: item.terminalId, taskId: item.taskId, name: item.name,
          cwd: item.cwd, environmentCwd: environment.cwd, environmentId: task.environmentId, createdAt: item.createdAt,
          chunks: [], end: 0, start: 0, length: 0, exitCode: 0, running: false, inputs: new Set(),
          service: { ...item.service, readiness: 'stopped', stoppedByUser: true, recovered: true,
            error: '服务已停止，历史终端日志未保存。' } })
        continue
      }
      if (isSameLiveProcessGroup(item.processPid, item.processIdentity)) {
        const task = this.repository.getTask(item.taskId)
        const environment = task && this.repository.getEnvironment(task.environmentId)
        if (task && task.lifecycle === 'active' && environment) {
          this.sessions.set(item.terminalId, { id: item.terminalId, taskId: item.taskId, name: item.name,
            cwd: item.cwd, environmentCwd: environment.cwd, environmentId: task.environmentId, createdAt: item.createdAt,
            chunks: [], end: 0, start: 0, length: 0, exitCode: null, running: true, inputs: new Set(),
            processPid: item.processPid, processIdentity: item.processIdentity,
            service: { ...item.service, readiness: item.service.url ? 'unverified' : 'running', recovered: true, recoveredManaged: true,
              error: '已接回上次仍在运行的进程，终端日志不可恢复。' } })
          continue
        }
      }
      try {
        const restored = await this.startService(item.taskId, { name: item.name, type: item.service.type, cwd: item.cwd,
          command: item.command, url: item.service.url || undefined, healthUrl: item.service.healthUrl || undefined, waitMs: 8000 })
        if (restored.terminal.id !== item.terminalId) this.repository.deleteManagedService?.(item.terminalId)
      } catch (error) {
        const task = this.repository.getTask(item.taskId)
        const environment = task && this.repository.getEnvironment(task.environmentId)
        if (!task || task.lifecycle !== 'active' || !environment) {
          this.repository.deleteManagedService?.(item.terminalId)
          continue
        }
        if (item.service.url && /指定的服务端口已被占用/.test(error.message)) {
          const session = { id: item.terminalId, taskId: item.taskId, name: item.name, cwd: item.cwd,
            environmentCwd: environment.cwd, environmentId: task.environmentId, createdAt: item.createdAt,
            chunks: [], end: 0, start: 0, length: 0, exitCode: 1, running: false, inputs: new Set(),
            service: { ...item.service, readiness: 'unverified', recovered: true,
              error: '页面端口仍被占用，未重复启动。请确认是否是原服务进程。' } }
          this.sessions.set(session.id, session)
          this.persistService(session, true)
          continue
        }
        const session = { id: item.terminalId, taskId: item.taskId, name: item.name, cwd: item.cwd,
          environmentCwd: environment.cwd, environmentId: task.environmentId, createdAt: item.createdAt,
          chunks: [], end: 0, start: 0, length: 0, exitCode: 1, running: false, inputs: new Set(),
          service: { ...item.service, readiness: 'failed', error: error.message } }
        this.sessions.set(session.id, session)
        this.persistService(session, true)
      }
    }
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
  close() {
    this.closed = true
    for (const session of [...this.sessions.values()]) {
      if (session.service) session.preserveService = true
      this.remove(session.id)
    }
  }
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
    if (session.service) {
      service.repository.renameManagedService?.(session.id, name)
      service.notify(session.taskId)
    }
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
  app.post('/api/v2/tasks/:taskId/services/clear-ended', async request => {
    for (const item of service.listServices(request.params.taskId)) {
      if (!item.running && (!item.exitCode || item.service.stoppedByUser || item.service.dismissed)) service.remove(item.id)
    }
    return { ok: true }
  })
  app.post(`${terminalPath}/dismiss`, async request => {
    const session = get(request)
    if (!session.service || session.running) throw Object.assign(new Error('只能忽略已结束的运行任务。'), { statusCode: 400 })
    session.service.dismissed = true
    service.notify(session.taskId)
    return { ok: true }
  })
  app.get('/api/v2/tasks/:taskId/services', async request => ({ services: service.listServices(request.params.taskId) }))
  app.post(`${terminalPath}/stop`, async request => { service.stop(get(request)); return { ok: true } })
}
