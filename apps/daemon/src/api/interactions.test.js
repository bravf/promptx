import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createApp } from '../app.js'
import { PendingInteractions } from '../agent/providers/pendingInteractions.js'
import { projectTimelineRows } from '../../../../packages/protocol/src/timelineProjection.js'
import { codexAsyncInteraction } from '../../../../packages/protocol/src/codexAsyncQuestions.js'

test('问答 API 任务隔离、刷新恢复、重复回答、取消、重启失效，回答继续原 Turn', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-interactions-'))
  const app = await createApp({
    databasePath: ':memory:', assetsDir: path.join(root, 'uploads'), logger: false, webRoot: false, relay: false,
    relayOptions: { configPath: path.join(root, 'relay.json'), identityPath: path.join(root, 'identity.json') },
    providerRegistry: { get: () => ({ createRuntime() {
      const runtime = new EventEmitter()
      runtime.interactions = new PendingInteractions(runtime)
      runtime.prepareTurn = async () => {}
      runtime.startTurn = async () => {
        const pending = runtime.interactions.ask({ kind: 'question', title: '选择格式', questions: [{
          id: 'format', header: '格式', question: '哪种格式？', options: [{ id: 'json', label: 'JSON' }, { id: 'md', label: 'Markdown' }],
        }] }, { respond: (_response, answers) => answers })
        void pending.then(answers => {
          runtime.emit('timeline', { type: 'assistant_message', phase: 'final_answer', text: `继续执行：${answers.format?.[0] || '取消询问'}` })
          runtime.emit('turnCompleted', {})
        })
        return { nativeTurnId: crypto.randomUUID() }
      }
      runtime.readHistorySnapshot = async () => ({ status: 'unsupported' })
      runtime.cancel = async () => { runtime.interactions.expire('任务已取消。'); runtime.emit('turnCanceled', {}) }
      runtime.close = () => runtime.interactions.expire()
      return runtime
    } }) },
  })
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const repository = app.sqliteRepository
  const project = repository.createProject({ repositoryRoot: root, displayName: '问答测试' })
  function task() {
    const environment = repository.createEnvironment({ cwd: root, repositoryRoot: root, kind: 'local' })
    const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '问答会话' })
    repository.createAgent(task.id, { providerId: 'codex' })
    return task
  }
  const a = task(), b = task()
  await app.listen({ host: '127.0.0.1', port: 0 })
  const headers = { host: `127.0.0.1:${app.server.address().port}` }
  const inject = options => app.inject({ ...options, headers })
  const base = `http://${headers.host}`
  async function start() {
    const result = await inject({ method: 'POST', url: `/api/v2/tasks/${a.id}/turns`, payload: { clientMessageId: crypto.randomUUID(), input: { content: [{ type: 'text', text: '测试问答' }] } } })
    assert.equal(result.statusCode, 202, result.body)
    return result.json().turn
  }
  const turn = await start()
  const pending = await inject({ url: `/api/v2/tasks/${a.id}/interactions` })
  const request = pending.json().requests[0]
  assert.equal(repository.getTaskAgent(a.id).attentionReason, 'permission')
  await inject({ method: 'POST', url: `/api/v2/tasks/${a.id}/attention/clear` })
  assert.equal(repository.getTaskAgent(a.id).attentionReason, 'permission')
  const url = `/api/v2/tasks/${a.id}/interactions/${request.id}/respond`
  const payload = { decision: 'answer', answers: { format: { optionIds: ['md'] } } }
  const isolated = await inject({ method: 'POST', url: `/api/v2/tasks/${b.id}/interactions/${request.id}/respond`, payload })
  assert.equal(isolated.statusCode, 409)
  const invalid = await inject({ method: 'POST', url, payload: { decision: 'answer', answers: {} } })
  assert.equal(invalid.statusCode, 400)

  // 重连已有游标仍收到完整的待回答问题，不依赖旧 Timeline 行是否在分页窗口中。
  const state = repository.getTimelineState(a.id)
  const response = await fetch(`${base}/api/v2/task-events`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscriptions: [{ id: 'a', taskId: a.id, cursor: `${state.epoch}:${state.nextSeq - 1}` }] }), signal: AbortSignal.timeout(5000) })
  const reader = response.body.getReader()
  let text = ''
  while (!text.includes('event: task-event\ndata:') || !text.includes('"type":"ready"')) text += new TextDecoder().decode((await reader.read()).value)
  await reader.cancel()
  assert.ok(text.includes(request.id))
  assert.ok(text.includes('"type":"interactions"'))

  const results = await Promise.all([inject({ method: 'POST', url, payload }), inject({ method: 'POST', url, payload })])
  assert.deepEqual(results.map(result => result.statusCode).sort(), [200, 409])
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(repository.listTurns(a.id).length, 1)
  const rows = repository.listTimelineRows(a.id)
  assert.equal(rows.find(row => row.item.text === '继续执行：Markdown').turnId, turn.id)
  const projected = projectTimelineRows(rows).filter(entry => entry.item.type === 'interaction_request')
  assert.equal(projected.length, 1)
  assert.equal(projected[0].item.status, 'answered')

  await start()
  const canceledId = (await inject({ url: `/api/v2/tasks/${a.id}/interactions` })).json().requests[0].id
  assert.equal((await inject({ method: 'POST', url: `/api/v2/tasks/${a.id}/cancel` })).statusCode, 200)
  assert.equal((await inject({ method: 'POST', url: `/api/v2/tasks/${a.id}/interactions/${canceledId}/respond`, payload })).statusCode, 409)
  assert.equal(projectTimelineRows(repository.listTimelineRows(a.id)).find(entry => entry.item.id === canceledId).item.status, 'expired')

  repository.appendTimeline(b.id, null, { type: 'interaction_request', ...request, status: 'pending' })
  repository.failActiveTurnsOnStartup()
  assert.equal(repository.listTimelineRows(b.id).at(-1).item.status, 'expired')

  const asyncRequest = codexAsyncInteraction({ id: 'async-call', delivery: 'async', questions: [{ title: '报告格式？', options: ['Markdown', 'JSON'] }] })
  repository.appendTimeline(a.id, turn.id, asyncRequest)
  repository.failActiveTurnsOnStartup()
  assert.equal(repository.listInteractionRows(a.id).at(-1).item.status, 'pending')
  const answerUrl = `/api/v2/tasks/${a.id}/interactions/${asyncRequest.id}/respond`
  const asyncPayload = { decision: 'answer', answers: { 0: { optionIds: ['0'] } } }
  const continued = await inject({ method: 'POST', url: answerUrl, payload: asyncPayload })
  assert.equal(continued.statusCode, 200, continued.body)
  assert.equal(repository.listTurns(a.id).length, 3)
  const summary = repository.listTimelineRows(a.id).find(row => row.item.type === 'user_message' && row.item.clientMessageId === `interaction:${asyncRequest.id}`)
  assert.match(summary.item.content[0].text, /回答 Agent 的问题/)
  assert.ok(!summary.item.content[0].text.includes('send_user_message_question_reply'))
  assert.equal((await inject({ method: 'POST', url: answerUrl, payload: asyncPayload })).statusCode, 409)
  assert.equal(projectTimelineRows(repository.listTimelineRows(a.id)).find(entry => entry.item.id === asyncRequest.id).item.status, 'answered')
})
