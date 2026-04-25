import test from 'node:test'
import assert from 'node:assert/strict'

import {
  createClaudeNormalizationState,
  extractClaudeAssistantText,
  extractClaudeResultText,
  extractClaudeSessionId,
  normalizeClaudeEvent,
  normalizeClaudeEvents,
} from './claudeCodeRunner.js'

test('runner claudeCodeRunner maps fatal auth api_retry to error event', () => {
  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'system',
      subtype: 'api_retry',
      attempt: 1,
      max_retries: 10,
      error_status: 401,
      error: 'authentication_failed',
    }),
    [{
      type: 'error',
      message: 'Claude Code 认证失败（HTTP 401 authentication_failed）。请重新登录 Claude Code，或检查当前环境中的认证令牌配置。',
    }]
  )
})

test('runner claudeCodeRunner maps transient api_retry to reconnecting error event', () => {
  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'system',
      subtype: 'api_retry',
      attempt: 2,
      max_retries: 10,
      error_status: 503,
      error: 'overloaded',
    }),
    [{
      type: 'error',
      message: 'Reconnecting... 2/10 (HTTP 503 overloaded)',
    }]
  )
})

test('runner claudeCodeRunner maps Agent sub-agents into collaboration events', () => {
  const state = createClaudeNormalizationState()

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'agent-tool-1',
            name: 'Agent',
            input: {
              description: 'Analyze a.js exports',
              subagent_type: 'general-purpose',
              prompt: 'Analyze a.js in the current directory.',
              model: 'sonnet',
            },
          },
        ],
      },
    }, state),
    [{
      type: 'item.started',
      item: {
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        receiver_thread_ids: [],
        prompt: 'Analyze a.js in the current directory.',
        agents_states: {},
      },
    }]
  )

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'system',
      subtype: 'task_started',
      tool_use_id: 'agent-tool-1',
      task_id: 'task-a',
      description: 'Analyze a.js exports',
    }, state),
    [{
      type: 'item.completed',
      item: {
        type: 'collab_tool_call',
        tool: 'spawn_agent',
        receiver_thread_ids: ['task-a'],
        prompt: 'Analyze a.js in the current directory.',
        agents_states: {
          'task-a': {
            status: 'running',
            message: '',
            title: 'Analyze a.js exports',
            role: 'general-purpose',
            target: 'a.js',
            model: 'sonnet',
            task_id: 'task-a',
          },
        },
      },
    }]
  )
})

test('runner claudeCodeRunner maps task_completed and ignores duplicate tool_result for Agent sub-agents', () => {
  const state = createClaudeNormalizationState()

  normalizeClaudeEvents({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'agent-tool-2',
          name: 'Agent',
          input: {
            description: 'Analyze b.js exports',
            subagent_type: 'general-purpose',
            prompt: 'Analyze b.js in the current directory.',
            model: 'sonnet',
          },
        },
      ],
    },
  }, state)

  normalizeClaudeEvents({
    type: 'system',
    subtype: 'task_started',
    tool_use_id: 'agent-tool-2',
    task_id: 'task-b',
    description: 'Analyze b.js exports',
  }, state)

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'system',
      subtype: 'task_completed',
      task_id: 'task-b',
      result: 'found 2 exports',
      description: 'Analyze b.js exports',
    }, state),
    [{
      type: 'item.completed',
      item: {
        type: 'collab_tool_call',
        tool: 'wait',
        receiver_thread_ids: ['task-b'],
        prompt: 'Analyze b.js in the current directory.',
        agents_states: {
          'task-b': {
            status: 'completed',
            message: 'found 2 exports',
            title: 'Analyze b.js exports',
            role: 'general-purpose',
            target: 'b.js',
            model: 'sonnet',
            task_id: 'task-b',
          },
        },
      },
    }]
  )

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'agent-tool-2',
            content: 'duplicate result',
            is_error: false,
          },
        ],
      },
    }, state),
    []
  )
})

test('runner claudeCodeRunner maps TodoWrite into todo_list events', () => {
  const state = createClaudeNormalizationState()

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'assistant',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'todo-tool-1',
            name: 'TodoWrite',
            input: {
              todos: [
                {
                  content: 'Inspect relevant backend and admin codepaths',
                  activeForm: 'Inspecting relevant backend and admin codepaths',
                  status: 'in_progress',
                },
                {
                  content: 'Implement hospital database model and admin APIs',
                  status: 'pending',
                },
                {
                  content: 'Add tests',
                  status: 'completed',
                },
              ],
            },
          },
        ],
      },
    }, state),
    [{
      type: 'item.started',
      item: {
        type: 'todo_list',
        items: [
          {
            text: 'Inspecting relevant backend and admin codepaths',
            status: 'in_progress',
            completed: false,
          },
          {
            text: 'Implement hospital database model and admin APIs',
            status: 'pending',
            completed: false,
          },
          {
            text: 'Add tests',
            status: 'completed',
            completed: true,
          },
        ],
      },
    }]
  )

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'todo-tool-1',
            content: 'Todos have been modified successfully.',
            is_error: false,
          },
        ],
      },
    }, state),
    [{
      type: 'item.completed',
      item: {
        type: 'todo_list',
        items: [
          {
            text: 'Inspecting relevant backend and admin codepaths',
            status: 'in_progress',
            completed: false,
          },
          {
            text: 'Implement hospital database model and admin APIs',
            status: 'pending',
            completed: false,
          },
          {
            text: 'Add tests',
            status: 'completed',
            completed: true,
          },
        ],
      },
    }]
  )
})

test('extractClaudeAssistantText joins nested text parts', () => {
  const text = extractClaudeAssistantText({
    type: 'assistant',
    message: {
      content: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    },
  })

  assert.equal(text, '第一段\n第二段')
})

test('extractClaudeSessionId reads common session id fields', () => {
  assert.equal(extractClaudeSessionId({ session_id: 'claude-session-1' }), 'claude-session-1')
  assert.equal(extractClaudeSessionId({ result: { session_id: 'claude-session-2' } }), 'claude-session-2')
})

test('normalizeClaudeEvent maps assistant output to agent message', () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: '已完成修改' }],
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

test('normalizeClaudeEvent maps result output to turn completion', () => {
  assert.deepEqual(
    normalizeClaudeEvent({
      type: 'result',
      result: '最终回复',
    }),
    {
      type: 'turn.completed',
      result: '最终回复',
    }
  )

  assert.equal(extractClaudeResultText({ result: '最终回复' }), '最终回复')
})

test('normalizeClaudeEvents maps system init to thread start', () => {
  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'system',
      subtype: 'init',
      session_id: 'claude-session-init',
    }),
    [{
      type: 'thread.started',
      thread_id: 'claude-session-init',
    }]
  )
})

test('normalizeClaudeEvents maps thinking, tool use and text blocks', () => {
  const state = createClaudeNormalizationState()

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: '先看看目录结构' },
          { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls -1' } },
          { type: 'text', text: '已查看完成' },
        ],
      },
    }, state),
    [
      {
        type: 'item.started',
        item: {
          type: 'reasoning',
          text: '先看看目录结构',
        },
      },
      {
        type: 'item.started',
        item: {
          type: 'command_execution',
          command: 'Bash: ls -1',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: '已查看完成',
        },
      },
    ]
  )
})

test('normalizeClaudeEvents maps tool results back to remembered tool call', () => {
  const state = createClaudeNormalizationState()
  normalizeClaudeEvents({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool-2', name: 'Bash', input: { command: 'pwd' } },
      ],
    },
  }, state)

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'user',
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'tool-2', content: '/tmp/demo', is_error: false },
        ],
      },
    }, state),
    [{
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'Bash: pwd',
        status: 'completed',
        exit_code: 0,
        aggregated_output: '/tmp/demo',
      },
    }]
  )
})

test('normalizeClaudeEvents stringifies structured tool results', () => {
  const state = createClaudeNormalizationState()
  normalizeClaudeEvents({
    type: 'assistant',
    message: {
      content: [
        { type: 'tool_use', id: 'tool-3', name: 'Read', input: { file_path: '/tmp/demo.txt' } },
      ],
    },
  }, state)

  assert.deepEqual(
    normalizeClaudeEvents({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-3',
            content: [
              { type: 'text', text: '<path>/tmp/demo.txt</path>' },
              { type: 'text', text: '<type>file</type>' },
            ],
          },
        ],
      },
    },
    state),
    [{
      type: 'item.completed',
      item: {
        type: 'command_execution',
        command: 'Read: /tmp/demo.txt',
        status: 'completed',
        exit_code: 0,
        aggregated_output: '<path>/tmp/demo.txt</path>\n<type>file</type>',
      },
    }]
  )
})
