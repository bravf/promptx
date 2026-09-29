import assert from 'node:assert/strict'
import test from 'node:test'
import { mapCodexRolloutSnapshot } from './codexHistory.js'

test('重新导入原生 function/custom tool 日志保留调用参数和对应输出', () => {
  const records = [
    { type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } },
    { type: 'response_item', payload: { type: 'function_call', call_id: 'one', name: 'exec_command', arguments: '{"cmd":"pwd"}' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'one', output: '/workspace' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'two', name: 'apply_patch', input: 'patch input' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'two', output: 'denied', is_error: true } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } },
  ]
  const snapshot = mapCodexRolloutSnapshot({ id: 'thread' }, records.map(record => JSON.stringify(record)).join('\n'))
  const tools = snapshot.turns.flatMap(turn => turn.items).map(entry => entry.item).filter(item => item.type === 'tool_call')
  assert.equal(tools[0].detail.result, '/workspace')
  assert.equal(tools[0].status, 'completed')
  assert.equal(tools[1].detail.arguments, 'patch input')
  assert.equal(tools[1].status, 'failed')
})
