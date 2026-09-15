import test from 'node:test'
import assert from 'node:assert/strict'
import Fastify from 'fastify'
import { randomUUID } from 'node:crypto'
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
