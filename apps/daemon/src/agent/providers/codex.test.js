import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { CodexRuntime } from './codex.js'

class FakeRpc extends EventEmitter {
  constructor(handler) {
    super()
    this.handler = handler
    this.calls = []
    this.closed = false
  }

  request(method, params) {
    this.calls.push({ method, params })
    return this.handler(method, params)
  }

  notify() {}
  respond() {}
  close() { this.closed = true }
}

function createRuntime(handler) {
  let rpc
  const runtime = new CodexRuntime({
    cwd: process.cwd(),
    nativeHandle: { threadId: 'thread-1' },
    rpcFactory: () => {
      rpc = new FakeRpc(handler)
      return rpc
    },
  })
  return { runtime, getRpc: () => rpc }
}

test('读取 Codex 控制状态不会抢占 thread writer', async () => {
  const { runtime, getRpc } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    assert.fail(`不应调用 ${method}`)
  })

  await runtime.getControlState()
  assert.deepEqual(getRpc().calls.map((call) => call.method), ['initialize', 'model/list'])
  runtime.close()
})

test('发送前将 Codex active writer 冲突转换为结构化中文错误', async () => {
  const { runtime } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    if (method === 'thread/resume') throw new Error('thread thread-1 already has an active writer')
    assert.fail(`未处理的方法：${method}`)
  })

  await assert.rejects(runtime.prepareTurn(), (error) => {
    assert.equal(error.code, 'codex_thread_active_writer')
    assert.equal(error.statusCode, 409)
    assert.match(error.message, /另一个客户端/)
    return true
  })
  runtime.close()
})

test('Codex 仅在发送前 resume，并可在 Turn 结束后释放 writer', async () => {
  const { runtime, getRpc } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    if (method === 'thread/resume') return { thread: { id: 'thread-1' } }
    assert.fail(`未处理的方法：${method}`)
  })

  await runtime.prepareTurn()
  assert.equal(getRpc().calls.filter((call) => call.method === 'thread/resume').length, 1)
  const rpc = getRpc()
  runtime.releaseThreadWriter()
  assert.equal(rpc.closed, true)
  assert.equal(runtime.connected, false)
  assert.equal(runtime.threadLoaded, false)
})

test('发送已归档 Codex 会话时自动解归档并重试 resume', async () => {
  let resumeCount = 0
  const { runtime, getRpc } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    if (method === 'thread/resume') {
      resumeCount += 1
      if (resumeCount === 1) {
        throw new Error('session thread-1 is archived. Run `codex unarchive thread-1` to unarchive it first.')
      }
      return { thread: { id: 'thread-1' } }
    }
    if (method === 'thread/unarchive') return {}
    assert.fail(`未处理的方法：${method}`)
  })

  await runtime.prepareTurn()
  assert.deepEqual(getRpc().calls.map((call) => call.method), [
    'initialize',
    'model/list',
    'thread/resume',
    'thread/unarchive',
    'thread/resume',
  ])
  assert.equal(runtime.threadLoaded, true)
  runtime.close()
})

test('Codex 会话已被另一客户端解归档时继续 resume', async () => {
  let resumeCount = 0
  const { runtime } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    if (method === 'thread/resume') {
      resumeCount += 1
      if (resumeCount === 1) throw new Error('session thread-1 is archived. Run `codex unarchive thread-1` to unarchive it first.')
      return { thread: { id: 'thread-1' } }
    }
    if (method === 'thread/unarchive') throw new Error('no archived rollout found for thread id thread-1')
    assert.fail(`未处理的方法：${method}`)
  })

  await runtime.prepareTurn()
  assert.equal(runtime.threadLoaded, true)
  runtime.close()
})

test('Codex 会话解归档后的 writer 冲突仍转换为结构化中文错误', async () => {
  let resumeCount = 0
  const { runtime } = createRuntime(async (method) => {
    if (method === 'initialize') return {}
    if (method === 'model/list') return { data: [], nextCursor: null }
    if (method === 'thread/resume') {
      resumeCount += 1
      if (resumeCount === 1) throw new Error('session thread-1 is archived. Run `codex unarchive thread-1` to unarchive it first.')
      throw new Error('thread thread-1 already has an active writer')
    }
    if (method === 'thread/unarchive') return {}
    assert.fail(`未处理的方法：${method}`)
  })

  await assert.rejects(runtime.prepareTurn(), (error) => {
    assert.equal(error.code, 'codex_thread_active_writer')
    assert.equal(error.statusCode, 409)
    return true
  })
  runtime.close()
})
