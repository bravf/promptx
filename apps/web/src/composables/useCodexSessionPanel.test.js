import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRunEventToTurn,
  createTurnFromRun,
  formatCodexEvent,
  getProcessStatus,
  sortSessions,
} from './useCodexSessionPanel.js'

test('sortSessions prioritizes running then current then updatedAt', () => {
  const sessions = sortSessions([
    { id: 'old', running: false, updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'current', running: false, updatedAt: '2024-01-03T00:00:00.000Z' },
    { id: 'running', running: true, updatedAt: '2024-01-02T00:00:00.000Z' },
  ], 'current')

  assert.deepEqual(sessions.map((item) => item.id), ['running', 'current', 'old'])
})

test('formatCodexEvent formats command completion details', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'pnpm build',
      aggregated_output: 'done',
    },
  })

  assert.equal(event.kind, 'command')
  assert.equal(event.title, '命令执行完成')
  assert.match(event.detail, /pnpm build/)
})

test('getProcessStatus reflects stopped run', () => {
  assert.equal(getProcessStatus({ status: 'stopped' }), '已停止')
})

test('createTurnFromRun restores wrapped event payloads from persisted runs', () => {
  let turnId = 0
  let logId = 0
  const mergedSessions = []

  const turn = createTurnFromRun({
    id: 'run-1',
    prompt: 'hello',
    status: 'completed',
    responseMessage: 'done',
    events: [
      {
        id: 1,
        seq: 1,
        eventType: 'session',
        payload: {
          type: 'session',
          session: {
            id: 'session-1',
            title: 'demo',
            cwd: 'D:/code/demo',
          },
        },
      },
      {
        id: 2,
        seq: 2,
        eventType: 'completed',
        payload: {
          type: 'completed',
          message: 'done',
        },
      },
    ],
  }, () => ++turnId, () => ++logId, (session) => {
    mergedSessions.push(session.id)
  })

  assert.equal(turn.events.length, 2)
  assert.deepEqual(mergedSessions, ['session-1'])
  assert.equal(turn.responseMessage, 'done')
  assert.equal(turn.lastEventSeq, 2)
})

test('applyRunEventToTurn appends incremental codex events once and updates response text', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-2',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  const applied = applyRunEventToTurn(turn, {
    seq: 3,
    payload: {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'incremental reply',
        },
      },
    },
  }, () => ++logId, () => {})

  const duplicate = applyRunEventToTurn(turn, {
    seq: 3,
    payload: {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'duplicate reply',
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(applied, true)
  assert.equal(duplicate, false)
  assert.equal(turn.responseMessage, 'incremental reply')
  assert.equal(turn.events.length, 1)
  assert.equal(turn.lastEventSeq, 3)
})
