import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isKimiInfoStderrLine,
  normalizeKimiEvents,
  createKimiNormalizationState,
} from './kimiCodeRunner.js'
import { AGENT_RUN_ITEM_TYPES } from '@promptx/shared'

test('isKimiInfoStderrLine treats resume hints as non-error metadata', () => {
  assert.equal(
    isKimiInfoStderrLine('To resume this session: kimi -r ffb2f903-1173-4f8a-a49a-c8b0deae3e2d'),
    true
  )
  assert.equal(
    isKimiInfoStderrLine('To resume this session: kimi --session ffb2f903-1173-4f8a-a49a-c8b0deae3e2d'),
    true
  )
})

test('isKimiInfoStderrLine keeps real stderr visible', () => {
  assert.equal(isKimiInfoStderrLine('Error: authentication failed'), false)
})

test('normalizeKimiEvents maps SetTodoList tool_call to todo_list events', () => {
  const state = createKimiNormalizationState()

  const assistantEvent = {
    role: 'assistant',
    content: [],
    tool_calls: [{
      id: 'call-1',
      function: {
        name: 'SetTodoList',
        arguments: JSON.stringify({
          todos: [
            { title: 'Task A', status: 'in_progress' },
            { title: 'Task B', status: 'done' },
            { title: 'Task C', status: 'pending' },
          ],
        }),
      },
    }],
  }

  const startedEvents = normalizeKimiEvents(assistantEvent, state)
  assert.equal(startedEvents.length, 2)
  assert.equal(startedEvents[0].type, 'turn.started')

  const todoStarted = startedEvents[1]
  assert.equal(todoStarted.type, 'item.started')
  assert.equal(todoStarted.item.type, AGENT_RUN_ITEM_TYPES.TODO_LIST)
  assert.equal(todoStarted.item.items.length, 3)
  assert.deepEqual(todoStarted.item.items[0], { text: 'Task A', status: 'in_progress', completed: false })
  assert.deepEqual(todoStarted.item.items[1], { text: 'Task B', status: 'completed', completed: true })
  assert.deepEqual(todoStarted.item.items[2], { text: 'Task C', status: 'pending', completed: false })

  const toolEvent = {
    role: 'tool',
    tool_call_id: 'call-1',
    content: 'Todo list updated',
  }

  const completedEvents = normalizeKimiEvents(toolEvent, state)
  assert.equal(completedEvents.length, 1)
  assert.equal(completedEvents[0].type, 'item.completed')
  assert.equal(completedEvents[0].item.type, AGENT_RUN_ITEM_TYPES.TODO_LIST)
  assert.equal(completedEvents[0].item.items.length, 3)
})

test('normalizeKimiEvents keeps regular tool_calls as command_execution', () => {
  const state = createKimiNormalizationState()

  const assistantEvent = {
    role: 'assistant',
    content: [],
    tool_calls: [{
      id: 'call-2',
      function: {
        name: 'Shell',
        arguments: JSON.stringify({ command: 'ls' }),
      },
    }],
  }

  const startedEvents = normalizeKimiEvents(assistantEvent, state)
  assert.equal(startedEvents.length, 2)
  assert.equal(startedEvents[0].type, 'turn.started')

  const cmdStarted = startedEvents[1]
  assert.equal(cmdStarted.type, 'item.started')
  assert.equal(cmdStarted.item.type, AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION)

  const toolEvent = {
    role: 'tool',
    tool_call_id: 'call-2',
    content: 'file.txt',
  }

  const completedEvents = normalizeKimiEvents(toolEvent, state)
  assert.equal(completedEvents.length, 1)
  assert.equal(completedEvents[0].type, 'item.completed')
  assert.equal(completedEvents[0].item.type, AGENT_RUN_ITEM_TYPES.COMMAND_EXECUTION)
})

test('normalizeKimiEvents handles SetTodoList with empty or malformed todos', () => {
  const state = createKimiNormalizationState()

  const assistantEvent = {
    role: 'assistant',
    content: [],
    tool_calls: [{
      id: 'call-3',
      function: {
        name: 'SetTodoList',
        arguments: JSON.stringify({ todos: [] }),
      },
    }],
  }

  const events = normalizeKimiEvents(assistantEvent, state)
  assert.equal(events.length, 2)
  assert.equal(events[1].type, 'item.started')
  assert.equal(events[1].item.type, AGENT_RUN_ITEM_TYPES.TODO_LIST)
  assert.equal(events[1].item.items.length, 0)
})
