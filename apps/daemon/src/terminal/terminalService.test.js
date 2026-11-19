import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import net from 'node:net'
import { processGroupIdentity } from '../runtime/processControl.js'
import { TerminalService, registerTerminalRoutes } from './terminalService.js'

function fixture() {
  const tasks = new Map(['a', 'b'].map(id => [id, { id, environmentId: id, lifecycle: 'active' }]))
  const processes = []
  const service = new TerminalService({ getTask: id => tasks.get(id), getEnvironment: id => ({ id, cwd: '/tmp', status: 'ready' }) }, () => {
    const pty = { killed: false, writes: [], write(data) { this.writes.push(data) }, resize(cols, rows) { this.size = { cols, rows } }, onData(fn) { this.output = fn }, onExit(fn) { this.exit = fn }, kill() { this.killed = true } }
    processes.push(pty)
    return pty
  })
  return { service, tasks, processes }
}
test('终端按会话隔离，重开复用，退出和归档会清理', async () => {
  const { service, tasks, processes } = fixture()
  const a = await service.create('a', { cols: 80, rows: 24 })
  assert.equal(await service.create('a', { cols: 80, rows: 24 }, { ensure: true }), a)
  const b = await service.create('b', { cols: 80, rows: 24 })
  processes[0].output('hello')
  assert.equal(service.read(a).data, 'hello')
  assert.equal(service.read(a, 3).data, 'lo')
  assert.equal(service.read(b).data, '')
  tasks.get('a').lifecycle = 'archived'
  service.sweep()
  assert.equal(processes[0].killed, true)
  assert.equal(processes[1].killed, false)
  service.close()
  assert.equal(processes[1].killed, true)
})
test('输出历史有界，过期游标要求重置', async () => {
  const { service, processes } = fixture()
  const a = await service.create('a', { cols: 80, rows: 24 })
  for (let i = 0; i < 100; i++) processes[0].output('x'.repeat(4096))
  const state = service.read(a)
  assert.equal(state.reset, true)
  assert.ok(state.data.length <= 256 * 1024)
  assert.equal(service.read(a, state.cursor).data, '')
  service.close()
})

test('服务正在停止时不能复用为运行中的服务', async t => {
  const { service, processes } = fixture()
  t.after(() => service.close())
  const input = { name: '正在停止的服务', command: 'echo test', waitMs: 0 }
  const first = await service.startService('a', input)
  service.stop(service.get('a', first.terminal.id))
  await assert.rejects(service.startService('a', input), error => error.statusCode === 409 && /正在停止/.test(error.message))
  assert.equal(processes.length, 1)
})

test('真实 PTY 支持命令执行、调整尺寸、Ctrl+C 与重新连接', { skip: process.platform === 'win32' }, async (t) => {
  const service = new TerminalService({ getTask: () => ({ environmentId: 'env', lifecycle: 'active' }), getEnvironment: () => ({ id: 'env', cwd: '/tmp', status: 'ready' }) })
  t.after(() => service.close())
  const originalShell = process.env.SHELL
  process.env.SHELL = '/bin/sh'
  let session
  try { session = await service.create('real', { cols: 80, rows: 24 }) }
  finally { if (originalShell === undefined) delete process.env.SHELL; else process.env.SHELL = originalShell }
  async function waitForOutput(pattern, cursor = 0) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      if (pattern.test(service.read(session, cursor).data)) return
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    assert.fail(`未收到预期终端输出：${pattern}`)
  }
  session.pty.write("printf '\\120\\124\\131\\137\\117\\113\\n'\r")
  await waitForOutput(/PTY_OK\r?\n/)
  session.pty.resize(100, 30)
  let cursor = session.end
  session.pty.write('stty size\r')
  await waitForOutput(/30 100/, cursor)
  session.pty.write('sleep 30\r')
  await new Promise(resolve => setTimeout(resolve, 100))
  session.pty.write('\x03')
  cursor = session.end
  session.pty.write("printf '\\120\\124\\131\\137\\117\\113\\n'\r")
  await waitForOutput(/PTY_OK\r?\n/, cursor)
  assert.equal(await service.create('real', { cols: 80, rows: 24 }, { ensure: true }), session)
  assert.ok(service.read(session).data.includes('PTY_OK'))
})

test('同一会话支持多个 ID，创建请求幂等，关闭单个终端不影响其他终端', async () => {
  const { service, processes } = fixture()
  const [first, duplicate] = await Promise.all([
    service.create('a', { cols: 80, rows: 24 }, { requestId: 'create-1' }),
    service.create('a', { cols: 80, rows: 24 }, { requestId: 'create-1' }),
  ])
  assert.equal(first, duplicate)
  const second = await service.create('a', { cols: 80, rows: 24 }, { requestId: 'create-2' })
  assert.notEqual(first.id, second.id)
  assert.deepEqual(service.list('a').map(item => item.name), ['终端 1', '终端 2'])
  assert.throws(() => service.get('b', first.id), /终端已结束/)
  first.pty.output('first only')
  assert.equal(service.read(second).data, '')
  service.remove(first.id)
  assert.equal(processes[0].killed, true)
  assert.equal(processes[1].killed, false)
  assert.equal(service.list('a').length, 1)
  service.close()
})

test('多终端持续短输出的缓存总量与分块数有界', async () => {
  const { service } = fixture()
  const sessions = await Promise.all(Array.from({ length: 20 }, (_, i) => service.create('a', { cols: 80, rows: 24 }, { requestId: `load-${i}` })))
  for (const session of sessions) {
    for (let i = 0; i < 10000; i++) session.pty.output('x'.repeat(64))
    assert.ok(session.length <= 256 * 1024)
    assert.ok(session.chunks.length <= 65)
  }
  assert.equal(service.list('a').length, 20)
  service.close()
})

test('终端 API 校验输入、隔离会话并支持命名和重启', async (t) => {
  const { service, processes } = fixture()
  const app = Fastify()
  app.setErrorHandler((error, _request, reply) => reply.code(error.name === 'ZodError' ? 400 : error.statusCode || 500).send({ message: error.message }))
  registerTerminalRoutes(app, service.repository, service)
  t.after(() => app.close())
  const base = '/api/v2/tasks/a/terminals'
  const create = await app.inject({ method: 'POST', url: base, payload: { requestId: randomUUID(), cols: 80, rows: 24 } })
  assert.equal(create.statusCode, 200)
  const id = create.json().terminal.id
  const renamed = await app.inject({ method: 'PATCH', url: `${base}/${id}`, payload: { name: '前端服务' } })
  assert.equal(renamed.json().terminal.name, '前端服务')
  const invalid = await app.inject({ method: 'POST', url: `${base}/${id}/resize`, payload: { cols: -1, rows: 24 } })
  assert.equal(invalid.statusCode, 400)
  const crossTask = await app.inject(`/api/v2/tasks/b/terminals/${id}`)
  assert.equal(crossTask.statusCode, 409)
  const input = { id: randomUUID(), data: 'echo hello\r' }
  for (let i = 0; i < 2; i++) assert.equal((await app.inject({ method: 'POST', url: `${base}/${id}/input`, payload: input })).statusCode, 200)
  assert.deepEqual(processes[0].writes, [input.data])
  processes[0].exit({ exitCode: 0 })
  const restart = await app.inject({ method: 'POST', url: `${base}/${id}/restart`, payload: { cols: 80, rows: 24 } })
  assert.equal(restart.statusCode, 200)
  assert.notEqual(restart.json().terminal.id, id)
  assert.equal(restart.json().terminal.name, '前端服务')
  assert.equal((await app.inject(base)).json().terminals.length, 1)
  await app.inject({ method: 'DELETE', url: `${base}/${restart.json().terminal.id}` })
  assert.equal((await app.inject(base)).json().terminals.length, 0)
})

test('托管服务配置在 Daemon 关闭后保留并于下次启动恢复，主动停止后不自动恢复', async () => {
  const task = { id: 'a', environmentId: 'a', lifecycle: 'active' }
  const records = new Map()
  const repository = {
    getTask: () => task,
    getEnvironment: () => ({ id: 'a', cwd: '/tmp', status: 'ready' }),
    saveManagedService(value) { records.set(value.terminalId, { ...value }) },
    deleteManagedService(id) { records.delete(id) },
    setManagedServiceAutoStart(id, autoStart) { const item = records.get(id); if (item) item.autoStart = autoStart },
    listManagedServices(autoStartOnly) { return [...records.values()].filter(item => !autoStartOnly || item.autoStart) },
  }
  const spawned = []
  const spawn = () => {
    const pty = { onData() {}, onExit() {}, kill() { this.killed = true } }
    spawned.push(pty)
    return pty
  }
  const first = new TerminalService(repository, spawn)
  const started = await first.startService('a', { name: '持久服务', type: 'watch', command: 'node watcher.js', waitMs: 0 })
  const firstId = started.terminal.id
  first.close()
  assert.equal(records.get(firstId).autoStart, true)

  const resumed = new TerminalService(repository, spawn)
  await resumed.restoreServices()
  assert.equal(resumed.listServices('a').length, 1)
  assert.equal(resumed.listServices('a')[0].service.command, 'node watcher.js')
  assert.equal(resumed.listServices('a')[0].running, true)
  const restored = resumed.get('a', resumed.listServices('a')[0].id)
  resumed.stop(restored)
  assert.equal(records.get(restored.id).autoStart, false)
  resumed.close()
  assert.equal(records.size, 1)

  const next = new TerminalService(repository, spawn)
  await next.restoreServices()
  assert.equal(next.listServices('a').length, 1)
  assert.equal(next.listServices('a')[0].running, false)
  next.close()
  assert.equal(spawned.length, 2)
})

test('Daemon 异常退出后复用仍存活且身份匹配的服务进程组', { skip: process.platform === 'win32' }, async t => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' })
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
  const item = { terminalId: 'saved-id', taskId: 'a', name: '恢复服务', cwd: '/tmp', command: 'node app.js',
    service: { type: 'watch', command: 'node app.js', url: '', healthUrl: '', readiness: 'running' },
    autoStart: true, createdAt: new Date().toISOString(), processPid: child.pid, processIdentity: processGroupIdentity(child.pid) }
  const repository = {
    getTask: () => ({ id: 'a', environmentId: 'a', lifecycle: 'active' }),
    getEnvironment: () => ({ id: 'a', cwd: '/tmp', status: 'ready' }),
    listManagedServices: () => [item],
    setManagedServiceAutoStart: (_id, enabled) => { item.autoStart = enabled },
  }
  const resumed = new TerminalService(repository, () => assert.fail('恢复时不应再启动一份进程'))
  t.after(() => { resumed.close(); try { process.kill(-child.pid, 'SIGKILL') } catch {} })
  await resumed.restoreServices()
  const recovered = resumed.listServices('a')[0]
  assert.equal(recovered.id, 'saved-id')
  assert.equal(recovered.running, true)
  assert.equal(recovered.service.recoveredManaged, true)
  const session = resumed.get('a', recovered.id)
  resumed.stop(session)
  const deadline = Date.now() + 3000
  while (session.running && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
  assert.equal(session.running, false)
})

test('恢复时页面端口已占用则不启动副本并保留可打开地址的状态卡片', async t => {
  const { service, processes, root } = fixture()
  const server = net.createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const url = `http://127.0.0.1:${server.address().port}/`
  const saved = { terminalId: 'saved-web', taskId: 'a', name: '已有 Web 服务', cwd: root,
    command: 'node app.mjs', service: { type: 'web', command: 'node app.mjs', url, healthUrl: '', readiness: 'ready' },
    autoStart: true, createdAt: new Date().toISOString(), processPid: null, processIdentity: '' }
  service.repository.listManagedServices = () => [saved]
  service.repository.saveManagedService = () => {}
  service.repository.deleteManagedService = () => {}
  service.spawn = () => { throw new Error('不应重复启动服务') }
  await service.restoreServices()
  const [card] = service.listServices('a')
  assert.equal(processes.length, 0)
  assert.equal(card.running, false)
  assert.equal(card.service.recovered, true)
  assert.match(card.service.error, /未重复启动/)
})
