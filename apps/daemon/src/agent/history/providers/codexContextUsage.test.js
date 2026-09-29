import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { readCodexContextUsage } from './codexContextUsage.js'
import { CodexRuntime } from '../../providers/codex.js'

const record = (used, time = '2026-09-29T01:00:00Z') => JSON.stringify({
  timestamp: time, type: 'event_msg', payload: { type: 'token_count', info: {
    last_token_usage: { total_tokens: used }, total_token_usage: { total_tokens: 999999 }, model_context_window: 100000,
  } },
})

test('Codex 从长日志尾部恢复最近上下文，忽略累计消耗、坏行和空统计，并缓存未变化文件', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'promptx-context-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'rollout.jsonl')
  await fs.writeFile(file, [record(12000), record(25000), JSON.stringify({ output: 'x'.repeat(2 * 1024 * 1024) }), record(null), '{broken'].join('\n'))
  const result = await readCodexContextUsage(file)
  assert.equal(result.usage.usedTokens, 25000)
  assert.equal(result.usage.percentage, 25)
  assert.equal(result.usage.updatedAt, '2026-09-29T01:00:00.000Z')
  assert.deepEqual(await readCodexContextUsage(file, result.revision), { revision: result.revision })
  await fs.appendFile(file, '\n' + record(0, '2026-09-29T02:00:00Z') + '\n')
  assert.equal((await readCodexContextUsage(file, result.revision)).usage.usedTokens, 0)
  assert.deepEqual(await readCodexContextUsage(path.join(directory, 'missing')), {})
})

test('Codex 历史用量不会覆盖更新的实时值或被子会话事件污染', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'promptx-context-runtime-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const file = path.join(directory, 'rollout.jsonl')
  await fs.writeFile(file, record(25000) + '\n')
  const runtime = new CodexRuntime({ cwd: directory, nativeHandle: { threadId: 'main' } })
  await runtime.refreshContextUsageFromHistory(file)
  assert.equal(runtime.controlState.contextUsage.usedTokens, 25000)
  runtime.onNotification({ method: 'thread/tokenUsage/updated', params: { threadId: 'main', tokenUsage: { last: { totalTokens: 30000 }, modelContextWindow: 100000 } } })
  await fs.appendFile(file, record(26000) + '\n')
  await runtime.refreshContextUsageFromHistory(file)
  runtime.onNotification({ method: 'thread/tokenUsage/updated', params: { threadId: 'child', tokenUsage: { last: { totalTokens: 10 }, modelContextWindow: 100000 } } })
  runtime.onNotification({ method: 'thread/tokenUsage/updated', params: { threadId: 'main', tokenUsage: {} } })
  assert.equal(runtime.controlState.contextUsage.usedTokens, 30000)
})
