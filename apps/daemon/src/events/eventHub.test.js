import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EventHub } from './eventHub.js'

test('EventHub 全局订阅会收到所有 Agent 事件，并可退订', () => {
  const hub = new EventHub()
  const agentEvents = []
  const unsubscribe = hub.subscribeAll((event) => agentEvents.push(event))

  hub.publish('agent-1', { type: 'agent', agent: { id: 'agent-1' } })
  hub.publish('agent-2', { type: 'turn', turn: { id: 'turn-1' } })
  assert.equal(agentEvents.length, 2)
  assert.equal(agentEvents[0].agent.id, 'agent-1')

  unsubscribe()
  hub.publish('agent-1', { type: 'agent', agent: { id: 'agent-1' } })
  assert.equal(agentEvents.length, 2)
})
