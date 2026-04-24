import test from 'node:test'
import assert from 'node:assert/strict'

import { createClaudeNormalizationState, normalizeClaudeEvents } from './claudeCodeRunner.js'

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
