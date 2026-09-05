import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_AGENT_TITLE, deriveAgentTitle } from './sessionTitle.js'

test('默认 Agent 标题为新会话', () => {
  assert.equal(DEFAULT_AGENT_TITLE, '新会话')
})

test('从第一个非空文本块的第一条非空行派生标题', () => {
  assert.equal(deriveAgentTitle([
    { type: 'image', assetId: 'asset-1' },
    { type: 'text', text: '  \n  请   帮我\t分析 PromptX  \n后续内容' },
  ]), '请 帮我 分析 PromptX')
})

test('派生标题最多保留 60 个字符', () => {
  assert.equal(deriveAgentTitle([{ type: 'text', text: 'a'.repeat(80) }]), 'a'.repeat(60))
})

test('没有非空文本时不派生标题', () => {
  assert.equal(deriveAgentTitle([
    { type: 'file', assetId: 'asset-1' },
    { type: 'text', text: ' \n\t ' },
  ]), null)
})
