import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { createApp } from '../app.js'

test('共享事件流按订阅隔离、补齐分页历史，并支持独立恢复游标', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-task-events-'))
  let currentModelId = 'test-model'
  const app = await createApp({
    databasePath: ':memory:', assetsDir: path.join(root, 'uploads'), logger: false, webRoot: false, relay: false,
    relayOptions: { configPath: path.join(root, 'relay.json'), identityPath: path.join(root, 'identity.json') },
    providerRegistry: { get: () => ({ createRuntime() {
      const runtime = new EventEmitter()
      runtime.getControlState = async () => ({ models: [], currentModelId, reasoningEfforts: [], currentReasoningEffort: '' })
      runtime.readHistorySnapshot = async () => ({ status: 'unsupported' })
      runtime.close = () => {}
      return runtime
    } }) },
  })
  t.after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }) })
  const repository = app.sqliteRepository
  const project = repository.createProject({ repositoryRoot: root, displayName: '事件回归' })
  function createTask(title) {
    const environment = repository.createEnvironment({ cwd: root, repositoryRoot: root, kind: 'local' })
    const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title })
    repository.createAgent(task.id, { providerId: 'codex' })
    return task
  }
  function append(task, text) {
    const turn = repository.createTurn(task.id, crypto.randomUUID())
    repository.updateTurn(turn.id, { status: 'completed' })
    return repository.appendTimeline(task.id, turn.id, { type: 'assistant_message', text })
  }
  const a = createTask('a'), b = createTask('b')
  for (let index = 0; index < 450; index++) append(a, `a-${index}`)
  append(b, 'b-0')
  const aEpoch = repository.getTimelineState(a.id).epoch
  const bEpoch = repository.getTimelineState(b.id).epoch
  await app.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${app.server.address().port}`
  async function readSnapshots(subscriptions) {
    const response = await fetch(`${base}/api/v2/task-events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5174' },
      body: JSON.stringify({ subscriptions }), signal: AbortSignal.timeout(5000),
    })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://127.0.0.1:5174')
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const messages = []
    let buffer = ''
    try {
      while (messages.filter(message => message.event.type === 'ready').length < subscriptions.length) {
        const { done, value } = await reader.read()
        assert.equal(done, false)
        buffer += decoder.decode(value, { stream: true })
        let boundary
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = block.split('\n').find(line => line.startsWith('data: '))
          if (data) messages.push(JSON.parse(data.slice(6)))
        }
      }
      return messages
    } finally { await reader.cancel() }
  }
  const events = await readSnapshots([
    { id: 'a', taskId: a.id, cursor: `${aEpoch}:0` },
    { id: 'b', taskId: b.id, cursor: `${bEpoch}:0` },
    { id: 'diff', taskId: a.id, snapshot: false },
  ])
  const aRows = events.filter(message => message.subscriptionId === 'a' && message.event.type === 'timeline')
  assert.equal(aRows.length, 450)
  assert.equal(aRows.at(-1).event.row.item.text, 'a-449')
  const bRows = events.filter(message => message.subscriptionId === 'b' && message.event.type === 'timeline')
  assert.equal(bRows.length, 1)
  assert.equal(bRows[0].event.row.item.text, 'b-0')
  assert.deepEqual(events.filter(message => message.subscriptionId === 'diff').map(message => message.event.type), ['ready'])
  append(a, 'a-new')
  append(b, 'b-new')
  const resumed = await readSnapshots([
    { id: 'a', taskId: a.id, cursor: `${aEpoch}:${aRows.at(-1).event.row.seq}` },
    { id: 'b', taskId: b.id, cursor: `${bEpoch}:${bRows.at(-1).event.row.seq}` },
  ])
  assert.deepEqual(resumed.filter(message => message.event.type === 'timeline').map(message => message.event.row.item.text), ['a-new', 'b-new'])
  const reset = await readSnapshots([{ id: 'a', taskId: a.id, cursor: 'obsolete-epoch:9999' }])
  assert.equal(reset[0].event.type, 'reset')
  assert.equal(reset[0].event.timeline.epoch, aEpoch)
  const headers = { host: `127.0.0.1:${app.server.address().port}` }
  const turnsResponse = await app.inject({ headers, url: `/api/v2/tasks/${a.id}/turns?limit=1000` })
  const { revision } = turnsResponse.json()
  const unchanged = await readSnapshots([{ id: 'a', taskId: a.id, cursor: `${aEpoch}:451`, turnsRevision: revision }])
  const unchangedSync = unchanged.find(message => message.event.type === 'timeline-synced').event.sync
  assert.equal(unchangedSync.turnsRevision, revision)
  assert.equal(unchangedSync.turns, undefined)
  append(a, 'changed-after-rest')
  const changed = await readSnapshots([{ id: 'a', taskId: a.id, cursor: `${aEpoch}:451`, turnsRevision: revision }])
  assert.equal(changed.filter(message => message.event.type === 'timeline').length, 1)
  const changedSync = changed.find(message => message.event.type === 'timeline-synced').event.sync
  assert.notEqual(changedSync.turnsRevision, revision)
  assert.equal(changedSync.turns.length, 452)
  const staleEpoch = await readSnapshots([{ id: 'a', taskId: a.id, cursor: 'obsolete:9999', turnsRevision: changedSync.turnsRevision }])
  assert.equal(staleEpoch[0].event.type, 'reset')
  const workbench = (await app.inject({ headers, url: '/api/v2/workbench' })).json()
  assert.equal(workbench.projects[0].id, project.id)
  assert.deepEqual(new Set(workbench.projects[0].tasks.map(task => task.id)), new Set([a.id, b.id]))
  assert.equal(workbench.projects[0].tasks[0].agent.providerId, 'codex')
  const oldControl = (await app.inject({ headers, url: `/api/v2/tasks/${a.id}/control` })).json()
  const noControlChange = await readSnapshots([{ id: 'a', taskId: a.id, controlRevision: oldControl.revision }])
  assert.equal(noControlChange.some(message => message.event.type === 'control'), false)
  currentModelId = 'changed-model'
  const newControl = (await app.inject({ headers, url: `/api/v2/tasks/${a.id}/control` })).json()
  assert.notEqual(newControl.revision, oldControl.revision)
  const controlChange = await readSnapshots([{ id: 'a', taskId: a.id, controlRevision: oldControl.revision }])
  assert.equal(controlChange.find(message => message.event.type === 'control').event.control.currentModelId, currentModelId)
  const duplicate = await app.inject({ headers: { host: `127.0.0.1:${app.server.address().port}` }, method: 'POST', url: '/api/v2/task-events', payload: { subscriptions: [{ id: 'a', taskId: a.id }, { id: 'a', taskId: b.id }] } })
  assert.equal(duplicate.statusCode, 400)
})
