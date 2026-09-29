import assert from 'node:assert/strict'
import test from 'node:test'
import { openDatabase } from '../db/database.js'
import { createRepository } from '../db/repository.js'
import { ToolDetailStore } from './toolDetailStore.js'
import { TimelineCoalescer } from './timelineCoalescer.js'

function fixture(t) {
  const db = openDatabase(':memory:'); t.after(() => db.close())
  const repository = createRepository(db)
  const project = repository.createProject({ repositoryRoot: process.cwd() })
  const environment = repository.createEnvironment({ cwd: process.cwd(), repositoryRoot: process.cwd(), kind: 'local' })
  const task = repository.createTask({ projectId: project.id, environmentId: environment.id })
  repository.createAgent(task.id, { providerId: 'claude' })
  const turn = repository.createTurn(task.id, 'turn')
  const store = new ToolDetailStore(repository)
  const append = detail => repository.appendTimeline(task.id, turn.id, { type: 'tool_call', callId: 'same', name: 'Bash', status: 'completed', detail })
  const read = params => store.read(task.id, { turnId: turn.id, callId: 'same', ...params })
  return { repository, task, turn, store, append, read }
}

test('大输出按 JSON 字节有界分页，中文和 emoji 不丢失；Relay 首页更小', t => {
  const { append, read } = fixture(t)
  const output = '你好😀\n\u0001'.repeat(100000)
  append({ type: 'claude_tool', input: { command: 'echo demo' }, output })
  const local = read(), remote = read({ transport: 'relay' })
  assert.ok(Buffer.byteLength(JSON.stringify(local)) < 128 * 1024)
  assert.ok(Buffer.byteLength(JSON.stringify(remote)) < Buffer.byteLength(JSON.stringify(local)))
  let section = local.sections.find(value => value.id === 'output')
  let actual = section.text
  while (section.hasMore) {
    const page = read({ section: 'output', cursor: section.cursor })
    assert.ok(Buffer.byteLength(JSON.stringify(page)) < 128 * 1024)
    section = page.section; actual += section.text
  }
  assert.equal(actual, output)
})

test('追加只读取新增部分，替换和 epoch 变化拒绝旧游标', t => {
  const { append, read, repository, task } = fixture(t)
  append({ type: 'commandExecution', command: 'pwd', outputDelta: 'a' })
  const first = read(), cursor = first.sections.find(value => value.id === 'output').cursor
  append({ type: 'commandExecution', outputDelta: 'b' })
  assert.equal(read({ section: 'output', cursor }).section.text, 'b')
  assert.ok(!JSON.stringify(read({ manifest: '1' })).includes('pwd'))
  append({ type: 'commandExecution', aggregatedOutput: 'changed' })
  assert.throws(() => read({ section: 'output', cursor }), { statusCode: 409 })
  assert.throws(() => read({ epoch: 'old' }), { statusCode: 409 })
  assert.throws(() => read({ turnId: 'another-turn' }), { statusCode: 404 })
  assert.throws(() => read({ section: 'output', cursor: 'bad' }), { statusCode: 400 })
  repository.deleteTask(task.id)
  assert.throws(() => read(), { statusCode: 404 })
})

test('60ms 合并不会丢命令起始参数或输出片段，终态立即提交', () => {
  const rows = [], coalescer = new TimelineCoalescer(value => rows.push(value))
  const push = (detail, status = 'running') => coalescer.push('agent', { turnId: 'turn', item: { type: 'tool_call', callId: 'call', status, detail } })
  push({ command: 'pwd' }); push({ outputDelta: 'a' }); push({ outputDelta: 'b' })
  coalescer.flushAll()
  assert.equal(rows[0].item.detail.outputDelta, 'ab')
  assert.equal(rows[0].item.detail.command, 'pwd')
  push({ outputDelta: 'c' }); push({ aggregatedOutput: 'abc' }, 'completed')
  assert.equal(rows.length, 2)
  assert.equal(rows[1].item.detail.outputDelta, undefined)
})

test('同 callId 跨轮次隔离；历史原地纠正会更新 epoch 并清除旧详情版本', t => {
  const { repository, task, turn, store, append, read } = fixture(t)
  append({ type: 'shell', output: 'first' })
  repository.updateTurn(turn.id, { status: 'completed' })
  const otherTurn = repository.createTurn(task.id, 'other')
  repository.appendTimeline(task.id, otherTurn.id, { type: 'tool_call', callId: 'same', name: 'Bash', status: 'completed', detail: { type: 'shell', output: 'second' } })
  assert.equal(read().sections.find(section => section.id === 'output').text, 'first')
  assert.equal(store.read(task.id, { turnId: otherTurn.id, callId: 'same' }).sections.find(section => section.id === 'output').text, 'second')
  const sync = output => repository.applyTimelineSync(task.id, {
    mode: 'append', providerId: 'claude', sourceId: 'native', rows: [{ localTurnId: otherTurn.id, providerMessageId: 'corrected-tool', item: { type: 'tool_call', callId: 'history', name: 'Bash', status: 'completed', detail: { type: 'shell', output } } }],
  })
  sync('before')
  const initial = store.read(task.id, { turnId: otherTurn.id, callId: 'history' })
  sync('after')
  assert.throws(() => store.read(task.id, { turnId: otherTurn.id, callId: 'history', epoch: initial.epoch }), { statusCode: 409 })
  assert.equal(store.read(task.id, { turnId: otherTurn.id, callId: 'history' }).sections[0].text, 'after')
})
