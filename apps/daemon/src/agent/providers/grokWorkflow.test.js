import assert from 'node:assert/strict'
import test from 'node:test'
import { grokWorkflowForPrompt, grokWorkflowTask } from './grokWorkflow.js'

test('Grok 工作流完成阶段在最终汇总前仍保持运行', () => {
  const running = grokWorkflowTask({ sessionUpdate: 'workflow_updated', run_id: 'wf-1', revision: 3, status: 'active', name: '研究' })
  assert.equal(running.status, 'running')
  const complete = grokWorkflowTask({ sessionUpdate: 'workflow_updated', run_id: 'wf-1', revision: 4, status: 'complete', name: '研究' }, running)
  assert.equal(complete.status, 'running')
  assert.equal(complete.awaitingSummary, true)
})

test('Grok 工作流只在对应的合成 Turn 完成后解锁', () => {
  const workflow = grokWorkflowTask({ run_id: 'wf-1', revision: 4, status: 'complete' })
  assert.ok(grokWorkflowForPrompt([workflow], 'workflow-completed-wf-1-4'))
  assert.equal(grokWorkflowForPrompt([workflow], 'other'), undefined)
})

test('Grok 前台工作流直接完成，后台工作流等待最终汇总', () => {
  assert.equal(grokWorkflowTask({ run_id: 'wf', revision: 1, status: 'complete', foreground: true }).status, 'completed')
  const completed = { ...grokWorkflowTask({ run_id: 'wf', revision: 2, status: 'complete' }), status: 'completed' }
  assert.equal(grokWorkflowTask({ run_id: 'wf', revision: 2, status: 'complete' }, completed), null)
  assert.equal(grokWorkflowTask({ run_id: 'wf', revision: 2, status: 'active' }, completed), null)
})

test('Grok 工作流忽略乱序修订，并保留取消终态', () => {
  const workflow = grokWorkflowTask({ run_id: 'wf-1', revision: 4, status: 'active' })
  assert.equal(grokWorkflowTask({ run_id: 'wf-1', revision: 3, status: 'complete' }, workflow), null)
  const canceled = grokWorkflowTask({ run_id: 'wf-1', revision: 5, status: 'cancelled' }, workflow)
  assert.equal(canceled.status, 'canceled')
})
