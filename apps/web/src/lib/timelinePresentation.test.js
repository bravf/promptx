import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTurnTimingMap, formatElapsedTime, formatMessageTime, getTurnActivityState, groupTimelineTurns, isTimelineTurnRunning, userMessageCopyText } from './timelinePresentation.js'

function entry(seq, turnId, type, item = {}) {
  return { seqStart: seq, seqEnd: seq, turnId, timestamp: `2026-01-01T00:00:0${seq}.000Z`, item: { type, ...item } }
}

test('同一 Turn 聚合输入、思考过程和最终输出', () => {
  const result = groupTimelineTurns([
    entry(1, 'turn-a', 'user_message'),
    entry(2, 'turn-a', 'reasoning', { text: '分析' }),
    entry(3, 'turn-a', 'tool_call', { callId: 'tool-1' }),
    entry(4, 'turn-a', 'todo', { items: [] }),
    entry(5, 'turn-a', 'assistant_message', { phase: 'final_answer', text: '完成' }),
  ])
  assert.equal(result.length, 1)
  assert.equal(result[0].presentationType, 'turn')
  assert.deepEqual(result[0].userEntries.map((item) => item.item.type), ['user_message'])
  assert.deepEqual(result[0].processEntries.map((item) => item.item.type), ['reasoning', 'tool_call', 'todo'])
  assert.deepEqual(result[0].outputEntries.map((item) => item.item.type), ['assistant_message'])
})

test('Assistant commentary 进入过程区，只有 final answer 进入输出区', () => {
  const result = groupTimelineTurns([
    entry(1, 'turn-a', 'assistant_message', { phase: 'commentary', text: '我先检查项目' }),
    entry(2, 'turn-a', 'assistant_message', { phase: 'final_answer', text: '当前项目是 Vue 应用' }),
  ])
  assert.deepEqual(result[0].processEntries.map((item) => item.item.text), ['我先检查项目'])
  assert.deepEqual(result[0].outputEntries.map((item) => item.item.text), ['当前项目是 Vue 应用'])
})

test('空白 Assistant 消息不渲染为空的过程或输出条目', () => {
  const result = groupTimelineTurns([
    entry(1, 'turn-a', 'assistant_message', { phase: 'commentary', text: '   ' }),
    entry(2, 'turn-a', 'reasoning', { text: '分析中' }),
    entry(3, 'turn-a', 'assistant_message', { phase: 'final_answer', text: '' }),
  ])
  assert.deepEqual(result[0].processEntries.map((item) => item.item.type), ['reasoning'])
  assert.deepEqual(result[0].outputEntries, [])
})

test('同一 Turn 中被过程事件隔开的最终回复合并为一个展示条目', () => {
  const result = groupTimelineTurns([
    entry(1, 'turn-a', 'assistant_message', { phase: 'final_answer', text: '我先读取项目。' }),
    entry(2, 'turn-a', 'tool_call', { callId: 'tool-1' }),
    entry(3, 'turn-a', 'reasoning', { text: '继续分析' }),
    entry(4, 'turn-a', 'assistant_message', { phase: 'final_answer', text: '项目分析完成。' }),
  ])

  assert.equal(result[0].outputEntries.length, 1)
  assert.equal(result[0].outputEntries[0].item.text, '我先读取项目。\n\n项目分析完成。')
  assert.equal(result[0].outputEntries[0].seqStart, 1)
  assert.equal(result[0].outputEntries[0].seqEnd, 4)
  assert.deepEqual(result[0].outputEntries[0].collapsed, ['turn_assistant_merge'])
})

test('Provider 重试提示进入过程区，仅在它是最新事件时显示', () => {
  const retry = { code: 'provider_retrying', text: '正在重试' }
  const active = groupTimelineTurns([
    entry(1, 'turn-a', 'system_notice', retry),
    entry(2, 'turn-a', 'system_notice', retry),
  ])[0]
  assert.deepEqual(active.processEntries.map((item) => item.seqEnd), [2])

  const recovered = groupTimelineTurns([
    entry(1, 'turn-b', 'system_notice', retry),
    entry(2, 'turn-b', 'reasoning', { text: '恢复响应' }),
  ])[0]
  assert.deepEqual(recovered.processEntries.map((item) => item.item.type), ['reasoning'])
})

test('Turn 活动状态区分自动重试、响应延迟和正常运行', () => {
  const retry = { code: 'provider_retrying', text: '正在重试' }
  const retrying = groupTimelineTurns([entry(1, 'turn-a', 'system_notice', retry)])[0]
  assert.equal(getTurnActivityState(retrying, { running: true, now: Date.parse('2026-01-01T00:01:00.000Z') }).status, 'retrying')

  const delayed = groupTimelineTurns([entry(1, 'turn-b', 'reasoning', { text: '分析中' })])[0]
  assert.equal(getTurnActivityState(delayed, { running: true, now: Date.parse('2026-01-01T00:00:50.000Z') }).status, 'delayed')
  assert.equal(getTurnActivityState(delayed, { running: true, now: Date.parse('2026-01-01T00:00:30.000Z') }).status, 'active')
  assert.equal(getTurnActivityState(retrying, { running: false }).status, 'completed')
})

test('不同 Turn 不会串组，无 Turn 数据保持原位置', () => {
  const standalone = entry(2, '', 'system_notice')
  const result = groupTimelineTurns([
    entry(1, 'turn-a', 'reasoning'),
    standalone,
    entry(3, 'turn-b', 'reasoning'),
  ])
  assert.equal(result.length, 3)
  assert.deepEqual(result.map((item) => item.key || item.item.type), ['turn:turn-a', 'system_notice', 'turn:turn-b'])
})

test('Turn 精确时间优先，缺少元数据时回退 Timeline 时间', () => {
  const rows = [
    { seq: 1, turnId: 'turn-a', timestamp: '2026-01-01T00:00:02.000Z' },
    { seq: 2, turnId: 'turn-a', timestamp: '2026-01-01T00:00:05.000Z' },
    { seq: 3, turnId: 'turn-b', timestamp: '2026-01-01T00:01:00.000Z' },
  ]
  const result = createTurnTimingMap(rows, [{
    id: 'turn-a', status: 'completed', createdAt: '2026-01-01T00:00:00.000Z', startedAt: '2026-01-01T00:00:01.000Z', finishedAt: '2026-01-01T00:00:09.000Z',
  }])
  assert.equal(result.get('turn-a').finishedAt - result.get('turn-a').startedAt, 8000)
  assert.equal(result.get('turn-b').startedAt, Date.parse('2026-01-01T00:01:00.000Z'))
  assert.equal(result.get('turn-b').finishedAt, Date.parse('2026-01-01T00:01:00.000Z'))
})

test('Agent 已结束时不让断线前遗留的 Turn 状态继续转圈', () => {
  assert.equal(isTimelineTurnRunning({
    agentRunning: false,
    latestTurnId: 'turn-a',
    turnId: 'turn-a',
    turnStatus: 'running',
  }), false)
  assert.equal(isTimelineTurnRunning({
    agentRunning: true,
    latestTurnId: 'turn-b',
    turnId: 'turn-a',
    turnStatus: 'running',
  }), false)
  assert.equal(isTimelineTurnRunning({
    agentRunning: true,
    latestTurnId: 'turn-a',
    turnId: 'turn-a',
    turnStatus: 'running',
  }), true)
})

test('耗时使用中文紧凑格式', () => {
  assert.equal(formatElapsedTime(8000), '8秒')
  assert.equal(formatElapsedTime(123000), '2分钟 03秒')
  assert.equal(formatElapsedTime(3723000), '1小时 02分钟 03秒')
})

test('消息时间根据本地日历日期补充昨天、日期和年份', () => {
  const now = new Date(2026, 8, 8, 10, 30)
  assert.equal(formatMessageTime(new Date(2026, 8, 8, 9, 2).toISOString(), now), '09:02')
  assert.equal(formatMessageTime(new Date(2026, 8, 7, 9, 2).toISOString(), now), '昨天 09:02')
  assert.equal(formatMessageTime(new Date(2026, 8, 6, 9, 2).toISOString(), now), '9月6日 09:02')
  assert.equal(formatMessageTime(new Date(2025, 11, 31, 9, 2).toISOString(), now), '2025年12月31日 09:02')
  assert.equal(formatMessageTime('invalid', now), '')
})

test('输入消息复制文本包含附件名称', () => {
  assert.equal(userMessageCopyText([{ type: 'text', text: '看这里' }, { type: 'image', name: '图.png' }, { type: 'file', name: '说明.pdf' }]), '看这里\n[图片] 图.png\n[附件] 说明.pdf')
})
