import assert from 'node:assert/strict'
import test from 'node:test'
import { ClaudeRuntime } from './claude.js'

function fakeQuery() {
  let resolveUsage
  const usage = new Promise(resolve => { resolveUsage = resolve })
  let releaseStream
  const streamDone = new Promise(resolve => { releaseStream = resolve })
  const stream = {
    async *[Symbol.asyncIterator]() { await streamDone },
    supportedModels: async () => [
      { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'high'] },
      { value: 'sonnet', displayName: 'Sonnet', supportedEffortLevels: ['low', 'high'] },
    ],
    getContextUsage: () => usage,
    close() { releaseStream() },
  }
  return { stream, resolveUsage }
}

test('Claude 模型返回不等待上下文；缓存仅复用同工作区目录，发送仍初始化会话', async () => {
  const cwd = `/tmp/claude-controls-${crypto.randomUUID()}`
  const first = fakeQuery()
  const runtime = new ClaudeRuntime({ cwd, queryFactory: () => first.stream })
  const cachedQuery = fakeQuery()
  let starts = 0
  const cached = new ClaudeRuntime({
    cwd, modelId: 'sonnet', config: { reasoningEffort: 'low' },
    queryFactory: () => { starts += 1; return cachedQuery.stream },
  })
  const otherQuery = fakeQuery()
  let otherStarts = 0
  const other = new ClaudeRuntime({ cwd: `${cwd}-other`, queryFactory: () => { otherStarts += 1; return otherQuery.stream } })
  try {
    const control = await runtime.getControlState()
    assert.equal(control.currentModelId, 'opus')
    assert.equal(control.currentReasoningEffort, 'high')
    assert.equal(control.contextUsage, null)
    const reused = await cached.getControlState()
    assert.equal(starts, 0)
    assert.equal(reused.currentModelId, 'sonnet')
    assert.equal(reused.currentReasoningEffort, 'low')
    await cached.startTurn([{ type: 'text', text: '测试' }], 'm')
    assert.equal(starts, 1)
    assert.equal(cached.connected, true)
    await other.getControlState()
    assert.equal(otherStarts, 1)
    runtime.close()
    first.resolveUsage({ totalTokens: 123, maxTokens: 1000 })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(runtime.controlState.contextUsage, null)
  } finally {
    runtime.close()
    cached.close()
    other.close()
  }
})

test('Claude 模型目录缓存到期后重新查询', async () => {
  const cwd = `/tmp/claude-controls-${crypto.randomUUID()}`
  const first = new ClaudeRuntime({ cwd, queryFactory: () => fakeQuery().stream })
  let starts = 0
  const second = new ClaudeRuntime({ cwd, queryFactory: () => { starts += 1; return fakeQuery().stream } })
  const originalNow = Date.now
  try {
    await first.getControlState()
    const now = Date.now()
    Date.now = () => now + 6 * 60 * 1000
    await second.getControlState()
    assert.equal(starts, 1)
  } finally {
    Date.now = originalNow
    first.close()
    second.close()
  }
})
