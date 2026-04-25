import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyRunEventToTurn,
  applyRunEventsPayloadToTurns,
  classifyCodexIssue,
  createTurnFromRun,
  extractCodexEventErrorText,
  formatElapsedDuration,
  formatCodexIssueMessage,
  formatCodexEvent,
  getStoredProcessVisibility,
  getProcessStatus,
  getTurnAgentLabel,
  getTurnSummaryDetail,
  getTurnSummaryItems,
  getTurnSummaryStatus,
  hasTurnSummary,
  isShellTurn,
  mergeCodexSessionRecord,
  normalizeStoredProcessVisibility,
  sortSessions,
  syncTurnStateFromRun,
} from './useCodexSessionPanel.js'

test('normalizeStoredProcessVisibility defaults to showing process logs', () => {
  assert.equal(normalizeStoredProcessVisibility(null), true)
  assert.equal(normalizeStoredProcessVisibility(''), true)
  assert.equal(normalizeStoredProcessVisibility('true'), true)
  assert.equal(normalizeStoredProcessVisibility('false'), false)
  assert.equal(normalizeStoredProcessVisibility('0'), false)
})

test('getStoredProcessVisibility reads persisted local preference', () => {
  const originalWindow = globalThis.window
  const storage = new Map([['promptx:session-panel:show-process', 'false']])

  globalThis.window = {
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null
      },
    },
  }

  try {
    assert.equal(getStoredProcessVisibility(), false)
  } finally {
    globalThis.window = originalWindow
  }
})

test('sortSessions prioritizes running then current then updatedAt', () => {
  const sessions = sortSessions([
    { id: 'old', running: false, updatedAt: '2024-01-01T00:00:00.000Z' },
    { id: 'current', running: false, updatedAt: '2024-01-03T00:00:00.000Z' },
    { id: 'running', running: true, updatedAt: '2024-01-02T00:00:00.000Z' },
  ], 'current')

  assert.deepEqual(sessions.map((item) => item.id), ['running', 'current', 'old'])
})

test('shell turns use displayEngine as visible agent label', () => {
  const turn = createTurnFromRun({
    id: 'run-shell-1',
    engine: 'shell',
    displayEngine: 'claude-code',
    prompt: '!git status',
    status: 'completed',
  }, () => 'turn-shell-1', () => 'log-shell-1', () => {})

  assert.equal(isShellTurn(turn), true)
  assert.equal(turn.engine, 'shell')
  assert.equal(turn.displayEngine, 'claude-code')
  assert.equal(getTurnAgentLabel(turn), 'Claude Code')
})

test('formatCodexEvent formats command completion details', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'pnpm build',
      aggregated_output: 'done',
    },
  })

  assert.equal(event.kind, 'command')
  assert.equal(event.title, '命令执行完成')
  assert.match(event.detail, /pnpm build/)
})

test('formatCodexEvent parses Claude read results into structured detail blocks', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'Read: /tmp/project/src',
      aggregated_output: [
        '<path>/tmp/project/src</path>',
        '<type>directory</type>',
        '<entries>',
        'base.js',
        'hooks/',
        '</entries>',
      ].join('\n'),
    },
  }, 'Claude Code', 'claude-code')

  assert.equal(event.kind, 'command')
  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.equal(event.detailBlocks?.[0]?.items?.[0]?.value, 'Read')
  assert.equal(event.detailBlocks?.[1]?.type, 'directory_list')
  assert.deepEqual(event.detailBlocks?.[1]?.entries, ['base.js', 'hooks/'])
})

test('formatCodexEvent keeps OpenCode grep output as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'grep: /tmp/project/file.js',
      aggregated_output: [
        '473:function startFocusFollow(index, options = {}) {',
        '535:function placeCursor(index, position = null, options = {}) {',
      ].join('\n'),
    },
  }, 'OpenCode', 'opencode')

  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.match(event.detailBlocks?.[1]?.text || '', /473:function startFocusFollow/)
})

test('formatCodexEvent keeps ripgrep-style output as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'Bash: rg -n "relay" apps/web/src apps/server/src',
      aggregated_output: [
        'apps/web/src/lib/i18n.js:126:      relay: {',
        "apps/web/src/lib/i18n.js:132:        relayUrl: 'Relay 地址',",
        "apps/server/src/relayServer.js:264:  <form class=\"card\" action=\"/relay/admin/login\" method=\"post\">",
      ].join('\n'),
    },
  }, 'Claude Code', 'claude-code')

  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.match(event.detailBlocks?.[1]?.text || '', /apps\/web\/src\/lib\/i18n\.js:126:/)
})

test('formatCodexEvent strips ansi sequences from command output and keeps build failure as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'vite build',
      exit_code: 1,
      aggregated_output: [
        '\u001b[31mBuild failed with 1 error:\u001b[0m',
        '',
        '[MISSING_EXPORT] Error:',
        '"Sonner" is not exported by "web/src/components/ui/sonner/index.js".',
        '╭─[ web/src/App.vue:13:10 ]',
        '│',
        "13 │ import { Sonner } from '@/components/ui/sonner'",
      ].join('\n'),
    },
  }, 'Claude Code', 'claude-code')

  assert.equal(event.kind, 'error')
  assert.match(event.detail, /vite build/)
  assert.doesNotMatch(event.detail, /\u001b\[/)
  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.match(event.detailBlocks?.[1]?.text || '', /\[MISSING_EXPORT\] Error:/)
})

test('formatCodexIssueMessage strips ansi sequences from stderr text', () => {
  assert.equal(formatCodexIssueMessage('\u001b[31mBuild failed\u001b[0m'), 'Build failed')
})

test('formatCodexEvent treats raw shell commands as command meta', () => {
  const event = formatCodexEvent({
    type: 'item.started',
    item: {
      type: 'command_execution',
      status: 'in_progress',
      command: '/bin/zsh -lc "pnpm build"',
    },
  }, 'Codex', 'codex')

  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.deepEqual(event.detailBlocks?.[0]?.items, [
    { label: '命令', value: '/bin/zsh -lc "pnpm build"' },
  ])
})

test('formatCodexEvent keeps git status output as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: '/bin/zsh -lc "git status --short"',
      aggregated_output: [
        'M apps/web/src/components/ProcessDetailRenderer.vue',
        'M apps/web/src/composables/codexSessionPanelTurns.js',
      ].join('\n'),
    },
  }, 'Codex', 'codex')

  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.match(event.detailBlocks?.[1]?.text, /ProcessDetailRenderer/)
})

test('formatCodexEvent keeps workspace build logs as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: '/bin/zsh -lc "pnpm build"',
      aggregated_output: [
        '@muyichengshayu/promptx@0.1.30 build',
        '/Users/bravf/code/promptx',
        'pnpm -r build',
        '',
        'Scope: 5 of 6 workspace projects',
        'apps/web build$ vite build',
        'apps/web build: vite v5.4.21 building for production...',
      ].join('\n'),
    },
  }, 'Codex', 'codex')

  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.match(event.detailBlocks?.[1]?.text, /pnpm -r build/)
})

test('formatCodexEvent keeps git diff output as text instead of markdown', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'bash: git diff',
      aggregated_output: [
        'diff --git a/apps/web/src/components/CodexSessionPanel.vue b/apps/web/src/components/CodexSessionPanel.vue',
        'index 32ba088..78ca751 100644',
        '--- a/apps/web/src/components/CodexSessionPanel.vue',
        '+++ b/apps/web/src/components/CodexSessionPanel.vue',
        '@@ -391,7 +391,7 @@ defineExpose({',
        '-                    class=\"old\"',
        '+                    class=\"new\"',
      ].join('\n'),
    },
  }, 'OpenCode', 'opencode')

  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.doesNotMatch(event.detailBlocks?.[1]?.text || '', /^```/)
})

test('formatCodexEvent keeps mixed description and terminal output in one text block', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: '/bin/zsh -lc "pnpm build"',
      aggregated_output: [
        '准备开始构建，先看一下当前输出。',
        '',
        '/bin/zsh -lc "pnpm build"',
        'apps/web build$ vite build',
        'apps/web build: transforming...',
      ].join('\n'),
    },
  }, 'Codex', 'codex')

  assert.equal(event.detailBlocks?.[1]?.type, 'text')
  assert.equal(event.detailBlocks?.[2], undefined)
  assert.match(event.detailBlocks?.[1]?.text || '', /apps\/web build: transforming\.\.\./)
})

test('formatCodexEvent parses OpenCode todowrite output into checklist', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'command_execution',
      status: 'completed',
      command: 'todowrite: {"todos":[{"content":"任务一","status":"completed"},{"content":"任务二","status":"in_progress"},{"content":"任务三","status":"pending"}]}',
      aggregated_output: [
        '[',
        '  { "content": "任务一", "status": "completed" },',
        '  { "content": "任务二", "status": "in_progress" },',
        '  { "content": "任务三", "status": "pending" }',
        ']',
      ].join('\n'),
    },
  }, 'OpenCode', 'opencode')

  assert.equal(event.kind, 'todo')
  assert.equal(event.title, '更新待办列表')
  assert.equal(event.groupType, 'todo')
  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.equal(event.detailBlocks?.[1]?.type, 'checklist')
  assert.deepEqual(event.detailBlocks?.[1]?.items, [
    { completed: true, status: 'completed', text: '任务一' },
    { completed: false, status: 'in_progress', text: '任务二' },
    { completed: false, status: 'pending', text: '任务三' },
  ])
})

test('formatCodexEvent parses Claude TodoWrite input into checklist before tool result returns', () => {
  const event = formatCodexEvent({
    type: 'item.started',
    item: {
      type: 'command_execution',
      status: 'in_progress',
      command: 'TodoWrite: {"todos":[{"content":"梳理问题","status":"completed"},{"content":"修复展示","status":"in_progress"}]}',
    },
  }, 'Claude Code', 'claude-code')

  assert.equal(event.kind, 'todo')
  assert.equal(event.title, '更新待办列表')
  assert.equal(event.detailBlocks?.[1]?.type, 'checklist')
  assert.deepEqual(event.detailBlocks?.[1]?.items, [
    { completed: true, status: 'completed', text: '梳理问题' },
    { completed: false, status: 'in_progress', text: '修复展示' },
  ])
})

test('formatCodexEvent formats reasoning steps', () => {
  const event = formatCodexEvent({
    type: 'item.started',
    item: {
      type: 'reasoning',
      text: '先检查一下目录结构和依赖关系',
    },
  }, 'Claude Code', 'claude-code')

  assert.equal(event.kind, 'reasoning')
  assert.equal(event.title, '思考过程')
  assert.equal(event.groupType, 'reasoning')
  assert.match(event.detail, /目录结构/)
})

test('formatCodexEvent ignores empty Claude system heartbeat events', () => {
  const event = formatCodexEvent({
    type: 'claude.system',
    detail: '',
  }, 'Claude Code', 'claude-code')

  assert.equal(event.title, '')
  assert.equal(event.detail, '')
})

test('getProcessStatus reflects stopped run', () => {
  assert.equal(getProcessStatus({ status: 'stopped' }), '已停止')
})

test('getProcessStatus reflects interrupted run', () => {
  assert.equal(getProcessStatus({ status: 'interrupted' }), '已中断')
})

test('classifyCodexIssue recognizes billing problems', () => {
  const issue = classifyCodexIssue('Error: insufficient_quota. Please check your billing account.')

  assert.equal(issue?.type, 'billing')
  assert.equal(issue?.title, '额度或账单异常')
})

test('formatCodexIssueMessage adds a clearer summary for rate limit failures', () => {
  const detail = formatCodexIssueMessage('429 Too many requests, rate limit exceeded')

  assert.match(detail, /触发了限流/)
  assert.match(detail, /原始错误/)
})

test('classifyCodexIssue recognizes OpenCode cli missing errors', () => {
  const issue = classifyCodexIssue('找不到 OpenCode CLI，请先确认终端里可以运行 opencode --version', 'opencode')

  assert.equal(issue?.type, 'cli_missing')
  assert.equal(issue?.title, 'OpenCode CLI 不可用')
})

test('classifyCodexIssue recognizes Kimi Code cli missing errors', () => {
  const issue = classifyCodexIssue('找不到 Kimi Code CLI，请先确认终端里可以运行 kimi --version', 'kimi-code')

  assert.equal(issue?.type, 'cli_missing')
  assert.equal(issue?.title, 'Kimi Code CLI 不可用')
})

test('extractCodexEventErrorText reads nested codex event errors', () => {
  const text = extractCodexEventErrorText({
    type: 'turn.failed',
    error: {
      cause: {
        message: 'network error: fetch failed',
      },
    },
  })

  assert.equal(text, 'network error: fetch failed')
})

test('formatCodexEvent formats turn.failed with clearer error details', () => {
  const event = formatCodexEvent({
    type: 'turn.failed',
    error: {
      message: 'network error: connection timed out',
    },
  })

  assert.equal(event.kind, 'error')
  assert.equal(event.title, '网络连接异常')
  assert.match(event.detail, /连接超时|network error/i)
})

test('formatCodexEvent formats completed web search actions', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'web_search',
      query: 'Bruno Mars March 2026 Hot 100',
      action: {
        type: 'search',
        queries: [
          'AP Bruno Mars March 2026 Hot 100',
          'Billboard Bruno Mars March 2026 Hot 100',
        ],
      },
    },
  })

  assert.equal(event.kind, 'command')
  assert.equal(event.title, '已搜索网页')
  assert.match(event.detail, /关键词：Bruno Mars March 2026 Hot 100/)
  assert.match(event.detail, /Billboard Bruno Mars/)
})

test('formatCodexEvent formats collab tool calls with agent counts', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call',
      tool: 'spawn_agent',
      receiver_thread_ids: ['agent-1', 'agent-2'],
      prompt: '分析 taskPointManage 页面打印接入点',
    },
  })

  assert.equal(event.kind, 'todo')
  assert.equal(event.title, '已启动 2 个子代理')
  assert.match(event.detail, /分析 taskPointManage 页面打印接入点/)
})

test('formatCodexEvent derives sub-agent count from agents_states and exposes sub-agent detail blocks', () => {
  const longMessage = [
    '发现 2 个导出函数',
    'checkTaskPointPrint',
    'syncTaskPointReceipt',
    '调用链从 WorkbenchView -> TaskToolbar -> PrintDialog',
    '需要补一个权限短路判断',
    '现有实现没有兜底 toast',
    '建议把打印参数收口到 shared 层',
  ].join('\n')

  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call',
      tool: 'wait',
      receiver_thread_ids: [],
      prompt: '等待子代理返回',
      agents_states: {
        'agent-1': {
          status: 'completed',
          title: '分析 a.js',
          role: 'explore',
          target: 'a.js',
          message: longMessage,
          model: 'opencode/minimax-m2.5-free',
        },
      },
    },
  }, 'OpenCode', 'opencode')

  assert.equal(event.title, '子代理结果已汇总')
  assert.equal(event.detailBlocks?.[0]?.type, 'meta')
  assert.equal(event.detailBlocks?.[0]?.items?.[1]?.value, '1')
  assert.equal(event.detailBlocks?.[1]?.type, 'sub_agent_list')
  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.title, '分析 a.js')
  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.status, 'completed')
  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.target, 'a.js')
  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.message, longMessage)
  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.messageBlocks?.[0]?.type, 'text')
})

test('formatCodexEvent keeps sub-agent result details as text', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'collab_tool_call',
      tool: 'wait',
      agents_states: {
        'agent-1': {
          status: 'completed',
          title: '搜索 relay 相关文件',
          message: [
            'apps/web/src/lib/i18n.js:126:      relay: {',
            "apps/web/src/lib/i18n.js:132:        relayUrl: 'Relay 地址',",
            "apps/server/src/relayServer.js:264:  <form class=\"card\" action=\"/relay/admin/login\" method=\"post\">",
          ].join('\n'),
        },
      },
    },
  }, 'OpenCode', 'opencode')

  assert.equal(event.detailBlocks?.[1]?.items?.[0]?.messageBlocks?.[0]?.type, 'text')
})

test('formatCodexEvent formats file changes as concrete file updates', () => {
  const event = formatCodexEvent({
    type: 'item.completed',
    item: {
      type: 'file_change',
      changes: [
        { path: '/tmp/a.js', kind: 'update' },
        { path: '/tmp/b.js', kind: 'create' },
      ],
    },
  })

  assert.equal(event.kind, 'command')
  assert.equal(event.title, '已记录 2 个文件改动')
  assert.match(event.detail, /更新 \/tmp\/a\.js/)
  assert.match(event.detail, /新增 \/tmp\/b\.js/)
})

test('formatCodexEvent includes cached token usage on turn completion', () => {
  const event = formatCodexEvent({
    type: 'turn.completed',
    usage: {
      input_tokens: 123456,
      cached_input_tokens: 120000,
      output_tokens: 789,
    },
  })

  assert.match(event.detail, /输入 123,456/)
  assert.match(event.detail, /缓存 120,000/)
  assert.match(event.detail, /输出 789/)
})

test('formatCodexEvent formats reconnecting errors as retry status', () => {
  const event = formatCodexEvent({
    type: 'error',
    message: 'Reconnecting... 3/5 (stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses))',
  })

  assert.equal(event.kind, 'info')
  assert.equal(event.title, '网络异常，正在重试 (3/5)')
  assert.match(event.detail, /网络问题|原始错误/)
})

test('formatElapsedDuration switches to minute-second display after 66 seconds', () => {
  assert.equal(formatElapsedDuration(65), '65s')
  assert.equal(formatElapsedDuration(66), '1分6秒')
  assert.equal(formatElapsedDuration(3661), '1小时1分1秒')
})

test('createTurnFromRun restores wrapped event payloads from persisted runs', () => {
  let turnId = 0
  let logId = 0
  const mergedSessions = []

  const turn = createTurnFromRun({
    id: 'run-1',
    prompt: 'hello',
    status: 'completed',
    responseMessage: 'done',
    events: [
      {
        id: 1,
        seq: 1,
        eventType: 'session',
        payload: {
          type: 'session',
          session: {
            id: 'session-1',
            title: 'demo',
            cwd: 'D:/code/demo',
          },
        },
      },
      {
        id: 2,
        seq: 2,
        eventType: 'completed',
        payload: {
          type: 'completed',
          message: 'done',
        },
      },
    ],
  }, () => ++turnId, () => ++logId, (session) => {
    mergedSessions.push(session.id)
  })

  assert.equal(turn.events.length, 1)
  assert.deepEqual(mergedSessions, ['session-1'])
  assert.equal(turn.responseMessage, 'done')
  assert.equal(turn.lastEventSeq, 2)
})

test('createTurnFromRun keeps promptBlocks for new data and resolves image assets', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-blocks',
    prompt: 'https://example.com/manual-image-link.png',
    promptBlocks: [
      { type: 'text', content: '请看这张图', meta: {} },
      { type: 'image', content: '/uploads/demo.png', meta: {} },
    ],
    status: 'completed',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  assert.equal(turn.prompt, 'https://example.com/manual-image-link.png')
  assert.deepEqual(turn.promptBlocks, [
    { type: 'text', content: '请看这张图', meta: {} },
    { type: 'image', content: 'http://localhost:3000/uploads/demo.png', meta: {} },
  ])
})

test('applyRunEventsPayloadToTurns always writes back to the latest turn object with the same runId', () => {
  let logId = 0
  const staleTurn = {
    runId: 'run-1',
    eventCount: 3,
    eventsLoaded: false,
    eventsLoading: true,
    events: [],
    lastEventSeq: 0,
    summary: {},
  }
  const latestTurn = {
    runId: 'run-1',
    eventCount: 3,
    eventsLoaded: false,
    eventsLoading: true,
    events: [],
    lastEventSeq: 0,
    summary: {},
  }
  const turns = [latestTurn]

  const appliedTurn = applyRunEventsPayloadToTurns(turns, 'run-1', {
    items: [
      {
        seq: 1,
        eventType: 'session',
        payload: {
          type: 'session',
          session: {
            id: 'session-1',
            title: 'demo',
            cwd: '/tmp/demo',
          },
        },
      },
      {
        seq: 2,
        eventType: 'completed',
        payload: {
          type: 'completed',
          message: '最终结果',
        },
      },
    ],
  }, () => ++logId, () => {})

  assert.equal(appliedTurn, latestTurn)
  assert.equal(latestTurn.eventsLoaded, true)
  assert.equal(latestTurn.eventsLoading, false)
  assert.equal(latestTurn.events.length, 1)
  assert.equal(latestTurn.responseMessage, '最终结果')
  assert.equal(staleTurn.events.length, 0)
})

test('createTurnFromRun keeps historical event logs unloaded when events are omitted', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-summary',
    prompt: 'hello',
    status: 'completed',
    eventCount: 6,
    eventsIncluded: false,
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  assert.equal(turn.eventCount, 6)
  assert.equal(turn.eventsLoaded, false)
  assert.deepEqual(turn.events, [])
})

test('applyRunEventToTurn appends incremental codex events once and updates response text', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-2',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  const applied = applyRunEventToTurn(turn, {
    seq: 3,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'incremental reply',
        },
      },
    },
  }, () => ++logId, () => {})

  const duplicate = applyRunEventToTurn(turn, {
    seq: 3,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'duplicate reply',
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(applied, true)
  assert.equal(duplicate, false)
  assert.equal(turn.responseMessage, 'incremental reply')
  assert.equal(turn.events.length, 1)
  assert.equal(turn.lastEventSeq, 3)
})

test('applyRunEventToTurn skips empty Claude system heartbeat events', () => {
  const turn = createTurnFromRun({
    id: 'run-heartbeat',
    engine: 'claude-code',
    status: 'running',
    events: [],
    eventsIncluded: true,
  }, () => 1, (() => {
    let value = 0
    return () => ++value
  })(), () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'claude.system',
        detail: '',
      },
    },
  }, (() => {
    let value = 0
    return () => ++value
  })(), () => {})

  assert.equal(turn.events.length, 0)
})

test('applyRunEventToTurn 兼容旧的 codex 包络事件类型', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-legacy-codex',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'codex',
      event: {
        type: 'item.completed',
        item: {
          type: 'agent_message',
          text: 'legacy reply',
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(turn.responseMessage, 'legacy reply')
  assert.equal(turn.events.length, 1)
})

test('applyRunEventToTurn formats classified errors with clearer details', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-3',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'error',
      message: 'permission denied while opening workspace file',
    },
  }, () => ++logId, () => {})

  assert.equal(turn.status, 'error')
  assert.match(turn.errorMessage, /权限不够/)
  assert.equal(turn.events[0]?.title, '权限不足')
})

test('applyRunEventToTurn marks codex turn.failed as error with extracted details', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-4',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'turn.failed',
        error: {
          message: 'network error: fetch failed',
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(turn.status, 'error')
  assert.equal(turn.events[0]?.title, '网络连接异常')
  assert.match(turn.errorMessage, /网络问题|原始错误/)
})

test('applyRunEventToTurn keeps reconnecting events collapsed and leaves run running', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-5',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'error',
        message: 'Reconnecting... 1/5 (stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses))',
      },
    },
  }, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 2,
    payload: {
      type: 'agent_event',
      event: {
        type: 'error',
        message: 'Reconnecting... 2/5 (stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses))',
      },
    },
  }, () => ++logId, () => {})

  assert.equal(turn.status, 'running')
  assert.equal(turn.events.length, 1)
  assert.equal(turn.events[0]?.title, '网络异常，正在重试 (2/5)')
  assert.equal(turn.errorMessage, '')
})

test('applyRunEventToTurn builds turn summary for search command file and agents', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-6',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'web_search',
          action: { type: 'search' },
        },
      },
    },
  }, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 2,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'command_execution',
          command: 'pnpm build',
          status: 'completed',
          exit_code: 0,
        },
      },
    },
  }, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 3,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'file_change',
          changes: [
            { path: '/tmp/a.js', kind: 'update' },
            { path: '/tmp/b.js', kind: 'create' },
          ],
        },
      },
    },
  }, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 4,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          receiver_thread_ids: ['agent-1', 'agent-2'],
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(hasTurnSummary(turn), true)
  assert.deepEqual(getTurnSummaryItems({
    ...turn,
    finishedAt: '2026-03-16T10:01:06.000Z',
    startedAt: '2026-03-16T10:00:00.000Z',
    status: 'completed',
  }), [
    { key: 'elapsed', label: '耗时', value: '1分6秒' },
    { key: 'web', label: '网页', value: '1' },
    { key: 'command', label: '命令', value: '1' },
    { key: 'file', label: '改动', value: '2' },
    { key: 'agent', label: '子代理', value: '2' },
  ])
  assert.equal(getTurnSummaryStatus(turn), '最近：已启动 2 个子代理')
  assert.equal(getTurnSummaryDetail(turn), '')
})

test('applyRunEventToTurn counts sub-agents from agents_states when receiver ids are absent', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-agent-states',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'collab_tool_call',
          tool: 'spawn_agent',
          receiver_thread_ids: [],
          agents_states: {
            'agent-a': { status: 'running', title: '分析 a.js' },
            'agent-b': { status: 'running', title: '分析 b.js' },
          },
        },
      },
    },
  }, () => ++logId, () => {})

  assert.deepEqual(getTurnSummaryItems(turn), [
    { key: 'agent', label: '子代理', value: '2' },
  ])
  assert.equal(getTurnSummaryStatus(turn), '最近：已启动 2 个子代理')
})

test('applyRunEventToTurn reports waiting agent status in turn summary', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-7',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.started',
        item: {
          type: 'collab_tool_call',
          tool: 'wait',
          receiver_thread_ids: ['agent-1', 'agent-2', 'agent-3'],
        },
      },
    },
  }, () => ++logId, () => {})

  assert.equal(getTurnSummaryStatus(turn), '当前：等待 3 个子代理返回结果')
})

test('applyRunEventToTurn stores latest summary detail for commands and searches', () => {
  let turnId = 0
  let logId = 0

  const turn = createTurnFromRun({
    id: 'run-8',
    prompt: 'hello',
    status: 'running',
    events: [],
  }, () => ++turnId, () => ++logId, () => {})

  applyRunEventToTurn(turn, {
    seq: 1,
    payload: {
      type: 'agent_event',
      event: {
        type: 'item.completed',
        item: {
          type: 'web_search',
          query: 'Bruno Mars March 2026 Hot 100',
          action: { type: 'search' },
        },
      },
    },
  }, () => ++logId, () => {})

  assert.match(getTurnSummaryDetail(turn), /Bruno Mars March 2026 Hot 100/)
})

test('syncTurnStateFromRun keeps event-derived error when persisted error is only a trailing warning', () => {
  const turn = {
    status: 'error',
    responseMessage: '',
    errorMessage: 'Codex 在请求过程中遇到了网络问题或连接超时。\n\n原始错误：stream disconnected before completion: error sending request for url (https://api.codexzh.com/v1/responses)',
  }

  syncTurnStateFromRun(turn, {
    status: 'error',
    errorMessage: 'Warning: no last agent message; wrote empty content to /tmp/demo.txt',
  })

  assert.match(turn.errorMessage, /网络问题/)
  assert.doesNotMatch(turn.errorMessage, /no last agent message/i)
})

test('mergeCodexSessionRecord 在 partial session 更新后保留已有 agentBindings', () => {
  const currentSession = {
    id: 'session-1',
    title: '聊天',
    engine: 'codex',
    running: true,
    agentBindings: [
      { engine: 'codex', sessionRecordId: 'session-1', isDefault: true },
      { engine: 'claude-code', sessionRecordId: 'session-2', isDefault: false },
      { engine: 'opencode', sessionRecordId: 'session-3', isDefault: false },
    ],
  }

  const partialSession = {
    id: 'session-1',
    title: '聊天',
    engine: 'codex',
    updatedAt: '2026-04-15T10:00:00.000Z',
  }

  const merged = mergeCodexSessionRecord(currentSession, partialSession, {
    preserveRunning: true,
  })

  assert.equal(merged?.id, 'session-1')
  assert.equal(merged?.running, true)
  assert.deepEqual(
    (merged?.agentBindings || []).map((item) => item.engine),
    ['codex', 'claude-code', 'opencode']
  )
})
