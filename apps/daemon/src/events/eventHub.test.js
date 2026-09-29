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

test('一个订阅者异常不阻断其他订阅者或业务写入', () => {
  const errors = [], events = []
  const hub = new EventHub(error => errors.push(error))
  hub.subscribe('a', () => { throw new Error('客户端断开') })
  hub.subscribe('a', event => events.push(event))
  hub.publish('a', { type: 'timeline' })
  assert.equal(errors.length, 1)
  assert.deepEqual(events, [{ type: 'timeline' }])
})
