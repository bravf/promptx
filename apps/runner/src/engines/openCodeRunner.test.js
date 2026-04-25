import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createOpenCodeNormalizationState,
  extractOpenCodeErrorMessage,
  extractOpenCodeSessionId,
  extractOpenCodeText,
  extractOpenCodeUsage,
  normalizeOpenCodeEvent,
  normalizeOpenCodeEvents,
} from './openCodeRunner.js'

test('runner openCodeRunner maps sub-agent task tool_use to collaboration events', () => {
  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'tool_use',
      sessionID: 'ses_main',
      part: {
        type: 'tool',
        tool: 'task',
        state: {
          status: 'completed',
          input: {
            description: '分析 a.js 文件',
            prompt: '请分析 /tmp/demo/a.js 文件',
            subagent_type: 'explore',
          },
          output: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
          metadata: {
            sessionId: 'ses_child_1',
            model: {
              providerID: 'opencode',
              modelID: 'minimax-m2.5-free',
            },
          },
        },
      },
    }),
    [
      {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          receiver_thread_ids: ['ses_child_1'],
          prompt: '请分析 /tmp/demo/a.js 文件',
          agents_states: {
            ses_child_1: {
              status: 'completed',
              message: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
              title: '分析 a.js 文件',
              role: 'explore',
              target: 'a.js',
              model: 'opencode/minimax-m2.5-free',
            },
          },
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'wait',
          receiver_thread_ids: ['ses_child_1'],
          prompt: '请分析 /tmp/demo/a.js 文件',
          agents_states: {
            ses_child_1: {
              status: 'completed',
              message: 'task_id: ses_child_1\n\n<task_result>ok</task_result>',
              title: '分析 a.js 文件',
              role: 'explore',
              target: 'a.js',
              model: 'opencode/minimax-m2.5-free',
            },
          },
        },
      },
    ]
  )
})

test('extractOpenCodeSessionId reads common session id fields', () => {
  assert.equal(extractOpenCodeSessionId({ sessionID: 'opencode-session-1' }), 'opencode-session-1')
  assert.equal(extractOpenCodeSessionId({ sessionId: 'opencode-session-2' }), 'opencode-session-2')
})

test('extractOpenCodeText trims text payload', () => {
  assert.equal(
    extractOpenCodeText({
      type: 'text',
      part: {
        type: 'text',
        text: '\n\n已完成修改\n',
      },
    }),
    '已完成修改'
  )
})

test('normalizeOpenCodeEvent maps text output to agent message', () => {
  assert.deepEqual(
    normalizeOpenCodeEvent({
      type: 'text',
      part: {
        type: 'text',
        text: '已完成修改',
      },
    }),
    {
      type: 'item.completed',
      item: {
        type: 'agent_message',
        text: '已完成修改',
      },
    }
  )
})

test('normalizeOpenCodeEvents maps first step_start to turn.started only once', () => {
  const state = createOpenCodeNormalizationState()

  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'step_start',
      sessionID: 'ses_1',
    }, state),
    [{ type: 'turn.started' }]
  )

  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'step_start',
      sessionID: 'ses_1',
    }, state),
    []
  )
})

test('normalizeOpenCodeEvents maps completed tool_use to command events', () => {
  assert.deepEqual(
    normalizeOpenCodeEvents({
      type: 'tool_use',
      sessionID: 'ses_2',
      part: {
        type: 'tool',
        tool: 'read',
        state: {
          status: 'completed',
          input: {
            filePath: '/tmp/demo.txt',
          },
          output: '<path>/tmp/demo.txt</path>',
        },
      },
    }),
    [
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          command: 'read: /tmp/demo.txt',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'read: /tmp/demo.txt',
          status: 'completed',
          exit_code: 0,
          aggregated_output: '<path>/tmp/demo.txt</path>',
        },
      },
    ]
  )
})

test('normalizeOpenCodeEvent maps step_finish stop to turn completion with usage', () => {
  const event = normalizeOpenCodeEvent({
    type: 'step_finish',
    part: {
      type: 'step-finish',
      reason: 'stop',
      tokens: {
        input: 321,
        output: 12,
        cache: {
          read: 256,
        },
      },
    },
  })

  assert.deepEqual(event, {
    type: 'turn.completed',
    usage: {
      input_tokens: 321,
      output_tokens: 12,
      cached_input_tokens: 256,
    },
  })

  assert.deepEqual(extractOpenCodeUsage({
    part: {
      tokens: {
        input: 321,
        output: 12,
        cache: {
          read: 256,
        },
      },
    },
  }), {
    input_tokens: 321,
    output_tokens: 12,
    cached_input_tokens: 256,
  })
})

test('extractOpenCodeErrorMessage reads nested API errors', () => {
  assert.equal(
    extractOpenCodeErrorMessage({
      type: 'error',
      error: {
        name: 'APIError',
        data: {
          message: 'openai_error',
          responseBody: '{"error":{"message":"bad gateway"}}',
        },
      },
    }),
    'openai_error'
  )
})
