import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createControlState, flattenAcpOptions, normalizeContextUsage } from './controlState.js'
import { AcpRuntime, normalizeAcpControls } from './providers/acp.js'
import { ClaudeRuntime } from './providers/claude.js'

test('控制状态按模型切换思考强度并回退到模型默认值', () => {
  const control = createControlState({
    models: [
      {
        id: 'fast',
        label: 'Fast',
        isDefault: true,
        defaultReasoningEffort: 'low',
        reasoningEfforts: [
          { id: 'low', label: '低' },
          { id: 'high', label: '高' },
        ],
      },
      {
        id: 'deep',
        label: 'Deep',
        defaultReasoningEffort: 'high',
        reasoningEfforts: [{ id: 'high', label: '高' }],
      },
    ],
    requestedModelId: 'deep',
    requestedReasoningEffort: 'low',
  })

  assert.equal(control.currentModelId, 'deep')
  assert.equal(control.currentReasoningEffort, 'high')
  assert.deepEqual(control.reasoningEfforts.map((item) => item.id), ['high'])
  assert.equal('isDefault' in control.models[0], false)
})

test('上下文使用量会取整并限制在 0 到 100%', () => {
  assert.equal(normalizeContextUsage(10, 0), null)
  assert.equal(normalizeContextUsage(-10, 100).percentage, 0)
  const usage = normalizeContextUsage(150.4, 100.2)
  assert.equal(usage.usedTokens, 150)
  assert.equal(usage.maxTokens, 100)
  assert.equal(usage.percentage, 100)
})

test('ACP 分组选项会展开为统一的模型和思考强度控制状态', () => {
  const grouped = [{
    id: 'model',
    type: 'select',
    category: 'model',
    currentValue: 'balanced',
    options: [
      { group: 'stable', name: '稳定版', options: [{ value: 'balanced', name: 'Balanced' }] },
      { group: 'preview', name: '预览版', options: [{ value: 'fast', name: 'Fast' }] },
    ],
  }]
  assert.deepEqual(flattenAcpOptions(grouped).map((item) => item.value), ['balanced', 'fast'])

  const control = normalizeAcpControls({
    configOptions: [
      ...grouped,
      {
        id: 'thought',
        type: 'select',
        category: 'thought_level',
        currentValue: 'medium',
        options: [
          { value: 'low', name: '低' },
          { value: 'medium', name: '中' },
        ],
      },
    ],
  })
  assert.deepEqual(control.models.map((item) => item.id), ['balanced', 'fast'])
  assert.equal(control.currentModelId, 'balanced')
  assert.equal(control.currentReasoningEffort, 'medium')
})

test('ACP 使用缓存目录原地切换模型并保留可选项', async () => {
  const acpSessionControls = {
    models: {
      currentModelId: 'thinking',
      availableModels: [
        { modelId: 'normal', name: 'Normal' },
        { modelId: 'thinking', name: 'Thinking' },
      ],
    },
    configOptions: [],
  }
  const runtime = new AcpRuntime({ cwd: process.cwd(), config: { acpSessionControls } })
  const changedModels = []
  runtime.connection = {
    unstable_setSessionModel: async ({ modelId }) => { changedModels.push(modelId) },
  }
  runtime.connected = true

  const control = await runtime.updateSettings({ modelId: 'normal', reasoningEffort: '' })

  assert.deepEqual(changedModels, ['normal'])
  assert.equal(control.currentModelId, 'normal')
  assert.deepEqual(control.models.map((model) => model.id), ['normal', 'thinking'])
})

test('Claude 主动中断的结果会记为取消而不是失败', async () => {
  const runtime = new ClaudeRuntime({ cwd: process.cwd() })
  async function* interruptedResult() {
    yield { type: 'result', subtype: 'error_during_execution', errors: ['Interrupted'] }
  }
  const stream = interruptedResult()
  runtime.runningQuery = stream
  runtime.cancelRequested = true
  runtime.refreshContextUsage = async () => {}
  let canceled = 0
  let failed = 0
  runtime.on('turnCanceled', () => { canceled += 1 })
  runtime.on('turnFailed', () => { failed += 1 })

  await runtime.consume(stream, new AbortController())

  assert.equal(canceled, 1)
  assert.equal(failed, 0)
  assert.equal(runtime.cancelRequested, false)
})
