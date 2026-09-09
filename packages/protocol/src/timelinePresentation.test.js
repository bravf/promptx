import assert from 'node:assert/strict'
import test from 'node:test'
import { presentTimelineItem, presentTimelineRow } from './timelinePresentation.js'

test('展示 Timeline 会移除工具大输出并保留命令和文件路径', () => {
  const item = presentTimelineItem({
    type: 'tool_call',
    callId: 'call-1',
    name: '终端命令',
    status: 'completed',
    detail: {
      type: 'shell',
      command: 'git status',
      aggregatedOutput: 'x'.repeat(500_000),
      rawInput: JSON.stringify({ filePath: '/workspace/src/App.vue', line: 12 }),
      rawOutput: 'y'.repeat(500_000),
    },
  })

  assert.equal(item.detail.command, 'git status')
  assert.deepEqual(item.detail.paths, [{ path: '/workspace/src/App.vue', line: 12 }])
  assert.equal('aggregatedOutput' in item.detail, false)
  assert.equal('rawInput' in item.detail, false)
  assert.equal('rawOutput' in item.detail, false)
  assert.ok(JSON.stringify(item).length < 1_000)
})

test('展示 Timeline 保留普通消息和行元数据', () => {
  const row = presentTimelineRow({
    seq: 3,
    timestamp: '2026-01-01T00:00:00.000Z',
    turnId: 'turn-1',
    item: { type: 'assistant_message', phase: 'final_answer', text: '完成' },
  })
  assert.deepEqual(row, {
    seq: 3,
    timestamp: '2026-01-01T00:00:00.000Z',
    turnId: 'turn-1',
    item: { type: 'assistant_message', phase: 'final_answer', text: '完成' },
  })
})
