import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { JsonRpcProcess } from '../agent/jsonRpcProcess.js'
import { childEnvironment, withTimeout } from './processControl.js'
import { acquireInstanceLock } from './instanceLock.js'
import { runGit } from '../environments/worktreeService.js'

test('Agent 环境不继承服务监听端口，保留其他环境', () => {
  const env = childEnvironment({ PORT: '3001', HOST: '127.0.0.1', CUSTOM_ENV: 'preserved' })
  assert.equal(env.PORT, undefined); assert.equal(env.HOST, undefined)
  assert.equal(env.CUSTOM_ENV, 'preserved')
})

test('JSON-RPC 无响应会超时、清理请求并退出子进程', async () => {
  const rpc = new JsonRpcProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { requestTimeoutMs: 50 })
  const exited = once(rpc, 'exit')
  await assert.rejects(rpc.request('initialize'), /超时/)
  assert.equal(rpc.pending.size, 0)
  await exited
  await assert.rejects(rpc.request('afterClose'), /不可写/)
  assert.equal(rpc.pending.size, 0)
})

test('stdin 异常不会产生未处理的 error，请求及时失败', async () => {
  const rpc = new JsonRpcProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'])
  const exited = once(rpc, 'exit')
  const pending = rpc.request('test')
  rpc.child.stdin.emit('error', new Error('模拟 EPIPE'))
  await assert.rejects(pending, /EPIPE/)
  assert.equal(rpc.pending.size, 0)
  await exited
})

test('初始化和取消的超时器不影响已完成操作', async () => {
  assert.equal(await withTimeout(() => 42, 20, '测试'), 42)
  await assert.rejects(withTimeout(() => new Promise(() => {}), 20, '初始化'), /初始化超时/)
})

test('同一数据库不能重复启动，正常释放与已退出进程的锁可恢复', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-lock-'))
  const file = path.join(root, 'test.sqlite')
  try {
    const release = acquireInstanceLock(file)
    assert.throws(() => acquireInstanceLock(file), /已有 Daemon/)
    release()
    fs.writeFileSync(`${file}.lock`, JSON.stringify({ pid: 2147483647 }))
    acquireInstanceLock(file)()
    assert.equal(fs.existsSync(`${file}.lock`), false)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('Git 超时会终止挂起的命令，输出存在上限', async () => {
  await assert.rejects(runGit(process.cwd(), ['-c', 'alias.wait=!sleep 10', 'wait'], { timeoutMs: 40 }), /超时/)
  await assert.rejects(runGit(process.cwd(), ['--help'], { maxOutputBytes: 10 }), /输出超过限制/)
})
