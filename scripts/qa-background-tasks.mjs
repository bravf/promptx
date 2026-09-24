import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createApp } from '../apps/daemon/src/app.js'
const provider = process.argv[2]
if (!['claude', 'codex', 'grok'].includes(provider))
  throw new Error(
    '用法：node scripts/qa-background-tasks.mjs claude|codex|grok [cancel]；会调用真实模型。',
  )
const cancelMode = process.argv[3] === 'cancel'
const root = fs.mkdtempSync(
  path.join(os.tmpdir(), `promptx-integration-${provider}-`),
)
execFileSync('git', ['init', '-q'], { cwd: root })
fs.writeFileSync(path.join(root, 'README.md'), 'ALPHA=17\nBETA=25\n')
const app = await createApp({
  databasePath: path.join(root, 'test.sqlite'),
  assetsDir: path.join(root, 'assets'),
  logger: false,
  webRoot: false,
  relay: false,
})
const log = (data) =>
  console.log(
    JSON.stringify({ at: new Date().toISOString(), provider, ...data }),
  )
const request = async (method, url, payload) => {
  const r = await app.inject({ method, url, payload })
  if (r.statusCode >= 400) throw new Error(r.body)
  return r.json()
}
const until = async (fn, ms = 300000) => {
  const start = Date.now()
  while (Date.now() - start < ms) {
    const value = await fn()
    if (value) return value
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('等待超时')
}
try {
  const { project } = await request('POST', '/api/v2/projects', {
    repositoryRoot: root,
  })
  const { task } = await request(
    'POST',
    `/api/v2/projects/${project.id}/tasks`,
    { providerId: provider, executionKind: 'local', title: '后台真实回归' },
  )
  const repo = app.sqliteRepository
  const prompt = cancelMode
    ? 'Read-only cancellation integration test: launch TWO background subagents, each must run sleep 120 using its terminal tool, then reply DONE. Launch both before doing anything else. Acknowledge launch and wait for their results. Do not modify files or use external messaging tools.'
    : 'Read-only integration test. Delegate reading ALPHA and BETA from README.md to TWO actual subagents, each should run sleep 8 before reading. Run in background if supported. Acknowledge launch then automatically sum their numeric results and report exactly VALIDATED_SUM=42 when they finish. Do not modify files. Do not use any external messaging tools.'
  await request('POST', `/api/v2/tasks/${task.id}/turns`, {
    clientMessageId: randomUUID(),
    input: { content: [{ type: 'text', text: prompt }] },
  })
  await until(() => {
    const a = repo.getTaskAgent(task.id)
    return a.backgroundTasks.length >= 2
  })
  log({ stage: 'two-subagents-observed' })
  if (cancelMode) {
    await request('POST', `/api/v2/tasks/${task.id}/cancel`, { all: true })
    await until(
      () =>
        repo
          .getTaskAgent(task.id)
          .backgroundTasks.every(
            (t) => !['running', 'pending'].includes(t.status),
          ),
      45000,
    )
    log({
      stage: 'CANCEL_PASS',
      tasks: repo
        .getTaskAgent(task.id)
        .backgroundTasks.map((t) => ({ status: t.status, title: t.title })),
    })
  } else {
    await until(() => {
      const a = repo.getTaskAgent(task.id)
      const rows = repo.listTimelineRows(task.id)
      return (
        a.lifecycle !== 'running' &&
        a.backgroundTasks.length >= 2 &&
        a.backgroundTasks.every((t) => t.status === 'completed') &&
        rows
          .filter((r) => r.item.type === 'assistant_message')
          .map((r) => r.item.text)
          .join('')
          .includes('VALIDATED_SUM=42')
      )
    })
    const before = repo.listTimelineRows(task.id)
    log({
      stage: 'completed',
      turns: repo.listTurns(task.id).length,
      tasks: repo
        .getTaskAgent(task.id)
        .backgroundTasks.map((t) => ({ status: t.status, title: t.title })),
    })
    await request('POST', `/api/v2/tasks/${task.id}/timeline/sync`, {})
    const after = repo.listTimelineRows(task.id)
    const messages = (rows) =>
      rows
        .filter((r) => r.item.type === 'assistant_message')
        .map((r) => r.item.text)
        .join('')
    assert.equal(
      (messages(after).match(/VALIDATED_SUM=42/g) || []).length,
      (messages(before).match(/VALIDATED_SUM=42/g) || []).length,
      '历史同步重复了最终汇总',
    )
    log({
      stage: 'history-parity',
      rowsBefore: before.length,
      rowsAfter: after.length,
    })
    await request('POST', `/api/v2/tasks/${task.id}/turns`, {
      clientMessageId: randomUUID(),
      input: {
        content: [
          {
            type: 'text',
            text: 'Now reply exactly FOLLOWUP_OK. Do not launch any tools or subagents.',
          },
        ],
      },
    })
    await until(() => repo.getTaskAgent(task.id).lifecycle !== 'running')
    assert.ok(messages(repo.listTimelineRows(task.id)).includes('FOLLOWUP_OK'))
    log({ stage: 'PASS', root })
  }
} finally {
  await app.close()
}
