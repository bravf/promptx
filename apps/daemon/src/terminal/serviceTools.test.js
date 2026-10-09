import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import http from 'node:http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { TerminalService } from './terminalService.js'
import { ServiceToolHost } from './serviceToolHost.js'

async function port() {
  const socket = net.createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const value = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return value
}
async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-service-test-'))
  const tasks = new Map(['a', 'b'].map(id => [id, { id, lifecycle: 'active', environmentId: 'env' }]))
  const service = new TerminalService({ getTask: id => tasks.get(id), getEnvironment: () => ({ id: 'env', cwd: root, status: 'ready' }) })
  const host = new ServiceToolHost(service)
  await host.listen()
  t.after(async () => { service.close(); await host.close(); fs.rmSync(root, { recursive: true, force: true }) })
  async function client(taskId) {
    const config = host.connect(taskId)
    const client = new Client({ name: 'promptx-test', version: '1.0' })
    await client.connect(new StdioClientTransport({ command: config.command, args: config.args, env: config.env, stderr: 'pipe' }))
    t.after(() => { config.release(); return client.close() })
    return { client, config, call: async (name, args = {}) => {
      const result = await client.callTool({ name, arguments: args })
      let value
      try { value = JSON.parse(result.content[0].text) } catch { value = { error: result.content[0].text } }
      return { ...result, value }
    } }
  }
  return { root, service, host, client, tasks }
}
async function waitUntil(check) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 25)) }
  assert.fail('等待状态超时')
}

test('真实 MCP/PTY：服务独立于客户端退出，重复启动复用、跨会话隔离、日志、停止和重启', { timeout: 30000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const listenPort = await port()
  fs.mkdirSync(path.join(f.root, 'web'))
  fs.writeFileSync(path.join(f.root, 'web', 'server.mjs'), `import http from 'node:http'; http.createServer((q,r)=>r.end('SERVICE_OK')).listen(${listenPort}, '127.0.0.1',()=>console.log('http://127.0.0.1:${listenPort}/'))`)
  const a = await f.client('a'), b = await f.client('b')
  assert.equal((await a.client.listTools()).tools.length, 5)
  const input = { name: '预览服务', command: `${process.execPath} server.mjs`, cwd: 'web', waitMs: 3000 }
  const [first, second] = await Promise.all([a.call('start_service', input), a.call('start_service', input)])
  assert.ok(!first.isError, JSON.stringify(first))
  const id = first.value.terminal.id
  assert.equal(first.value.terminal.service.readiness, 'ready')
  assert.equal(second.value.terminal.id, id)
  assert.equal(f.service.listServices('a').length, 1)
  assert.equal((await b.call('list_services')).value.services.length, 0)
  assert.equal((await b.call('stop_service', { terminalId: id })).isError, true)
  assert.match((await a.call('read_service_logs', { terminalId: id })).value.data, /127\.0\.0\.1/)
  await a.client.close()
  a.config.release()
  assert.equal(await (await fetch(`http://127.0.0.1:${listenPort}/`)).text(), 'SERVICE_OK')
  const resumed = await f.client('a')
  assert.equal((await resumed.call('list_services')).value.services[0].id, id)
  assert.equal((await resumed.call('restart_service', { terminalId: id })).isError, true)
  await resumed.call('stop_service', { terminalId: id })
  await waitUntil(() => !f.service.get('a', id).running)
  await assert.rejects(fetch(`http://127.0.0.1:${listenPort}/`))
  const restarted = await resumed.call('restart_service', { terminalId: id })
  assert.ok(!restarted.isError, JSON.stringify(restarted))
  assert.notEqual(restarted.value.terminal.id, id)
  assert.equal(restarted.value.terminal.service.readiness, 'ready')
  assert.equal(f.service.listServices('a').length, 1)
  f.service.close()
  await waitUntil(async () => { try { await fetch(`http://127.0.0.1:${listenPort}/`); return false } catch { return true } })
})

test('服务工具拒绝浏览器来源、未知令牌、目录逃逸和越权参数，启动失败不报告就绪', { timeout: 15000 }, async t => {
  const f = await fixture(t)
  const a = await f.client('a')
  const url = a.config.env.PROMPTX_SERVICE_TOOL_URL
  const headers = { Authorization: `Bearer ${a.config.env.PROMPTX_SERVICE_TOOL_TOKEN}`, 'Content-Type': 'application/json' }
  const payload = JSON.stringify({ name: 'list_services', arguments: {} })
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://px.mushayu.com' }, body: payload })).status, 403)
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer invalid' }, body: payload })).status, 403)
  assert.equal((await a.call('start_service', { name: 'escape', command: 'exit 0', cwd: '..', waitMs: 0 })).isError, true)
  assert.equal((await a.call('start_service', { name: 'remote', command: 'exit 0', url: 'https://example.com' })).isError, true)
  assert.equal((await a.call('list_services', { taskId: 'b' })).isError, true)
  const failed = await a.call('start_service', { name: '失败服务', command: 'exit 7', waitMs: 500 })
  assert.equal(failed.value.terminal.running, false)
  assert.equal(failed.value.terminal.exitCode, 7)
  assert.equal(failed.value.terminal.service.readiness, 'failed')
  const occupied = http.createServer((_request, response) => response.end('OTHER_SERVICE'))
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  const conflict = await a.call('start_service', { name: '端口冲突', command: 'exit 7', url: `http://127.0.0.1:${occupied.address().port}/`, waitMs: 500 })
  assert.equal(conflict.isError, true)
  assert.match(conflict.value.error, /端口已被占用/)
  assert.equal(f.service.listServices('a').length, 1)
  a.config.release()
  assert.equal((await fetch(url, { method: 'POST', headers, body: payload })).status, 403)
})

test('停止托管终端清理 shell 子进程，关闭后异步退出不触发通知', { timeout: 15000, skip: process.platform === 'win32' }, async t => {
  const f = await fixture(t)
  const listenPort = await port()
  fs.writeFileSync(path.join(f.root, 'child.mjs'), `import http from 'node:http';http.createServer((q,r)=>r.end('CHILD_OK')).listen(${listenPort},'127.0.0.1',()=>console.log('http://127.0.0.1:${listenPort}/'))`)
  let notifications = 0
  f.service.onChange = () => { notifications++ }
  const result = await f.service.startService('a', { name: '带子进程服务', command: `${process.execPath} child.mjs & wait`, waitMs: 3000 })
  assert.equal(result.terminal.service.readiness, 'ready')
  const session = f.service.get('a', result.terminal.id)
  f.service.stop(session)
  await waitUntil(() => !session.running)
  await waitUntil(async () => { try { await fetch(`http://127.0.0.1:${listenPort}/`); return false } catch { return true } })
  const second = await f.service.restartService('a', session.id)
  assert.equal(second.terminal.service.readiness, 'ready')
  const next = f.service.get('a', second.terminal.id)
  f.service.close()
  const atClose = notifications
  await waitUntil(() => !next.running)
  assert.equal(notifications, atClose)
})
