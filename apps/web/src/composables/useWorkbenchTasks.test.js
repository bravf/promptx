import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyTerminalRunUnreadUpdate,
  buildPromptPreview,
  clearFocusedTaskUnreadUpdateInMap,
  deriveTaskPreview,
  isActiveRunStatus,
  isCurrentTaskSendingState,
  isTerminalRunStatus,
  isTaskRunning,
  markTaskUnreadUpdateInMap,
  mergeTaskSummariesWithWorkspaceDiff,
  pruneNotifiedTerminalRunMap,
  reorderTaskSummaries,
  resolveTaskDisplayTitle,
  shouldRefreshWorkspaceDiffSummaries,
} from './useWorkbenchTasks.js'

test('resolveTaskDisplayTitle prefers manual title over auto title and preview', () => {
  const title = resolveTaskDisplayTitle({
    title: '手动标题',
    autoTitle: '自动标题',
    preview: '预览标题',
  }, [
    { type: 'text', content: '这是正文内容' },
  ])

  assert.equal(title, '手动标题')
})

test('resolveTaskDisplayTitle falls back to derived title from blocks', () => {
  const title = resolveTaskDisplayTitle({}, [
    { type: 'text', content: '这是一个很长很长的需求标题，应该被自动截断' },
  ])

  assert.equal(title, '这是一个很长很长的需求标题，应该')
})

test('deriveTaskPreview compacts whitespace and uses first text-like block', () => {
  const preview = deriveTaskPreview([
    { type: 'image', content: '/demo.png' },
    { type: 'imported_text', content: '  第一行\n\n第二行   第三行  ' },
  ], 20)

  assert.equal(preview, '第一行 第二行 第三行')
})

test('buildPromptPreview trims whitespace and limits length', () => {
  const preview = buildPromptPreview('  hello\n\nworld   from   promptx  ', 12)
  assert.equal(preview, 'hello world ')
})

test('isTaskRunning only trusts persisted task running state', () => {
  assert.equal(isTaskRunning({ running: true }), true)
  assert.equal(isTaskRunning({ running: false }), false)
  assert.equal(isTaskRunning({}), false)
})

test('isCurrentTaskSendingState keeps current task disabled during local optimistic send', () => {
  assert.equal(isCurrentTaskSendingState({ running: false }, true), true)
  assert.equal(isCurrentTaskSendingState({ running: true }, false), true)
  assert.equal(isCurrentTaskSendingState({ running: false }, false), false)
})

test('isActiveRunStatus matches queued through stopping only', () => {
  assert.equal(isActiveRunStatus('queued'), true)
  assert.equal(isActiveRunStatus('running'), true)
  assert.equal(isActiveRunStatus('stopping'), true)
  assert.equal(isActiveRunStatus('completed'), false)
  assert.equal(isActiveRunStatus('error'), false)
})

test('isTerminalRunStatus matches all terminal outcomes used by notifications', () => {
  assert.equal(isTerminalRunStatus('completed'), true)
  assert.equal(isTerminalRunStatus('error'), true)
  assert.equal(isTerminalRunStatus('stopped'), true)
  assert.equal(isTerminalRunStatus('interrupted'), true)
  assert.equal(isTerminalRunStatus('stop_timeout'), true)
  assert.equal(isTerminalRunStatus('failed'), true)
  assert.equal(isTerminalRunStatus('cancelled'), true)
  assert.equal(isTerminalRunStatus('timeout'), true)
  assert.equal(isTerminalRunStatus('running'), false)
})

test('markTaskUnreadUpdateInMap skips focused current task', () => {
  const result = markTaskUnreadUpdateInMap({}, 'task-a', {
    currentTaskSlug: 'task-a',
    pageFocused: true,
  })

  assert.deepEqual(result.unreadMap, {})
  assert.equal(result.didMark, false)
})

test('applyTerminalRunUnreadUpdate marks unread once and dedupes repeated terminal status', () => {
  const first = applyTerminalRunUnreadUpdate({
    unreadMap: {},
    notifiedMap: {},
    taskSlug: 'task-b',
    change: {
      runId: 'run-1',
      status: 'completed',
    },
    currentTaskSlug: 'task-a',
    pageFocused: true,
  })

  assert.deepEqual(first.unreadMap, {
    'task-b': true,
  })
  assert.equal(first.didMark, true)
  assert.equal(first.didDedupe, false)
  assert.deepEqual(first.notifiedMap['run-1'], {
    taskSlug: 'task-b',
    status: 'completed',
  })

  const second = applyTerminalRunUnreadUpdate({
    unreadMap: first.unreadMap,
    notifiedMap: first.notifiedMap,
    taskSlug: 'task-b',
    change: {
      runId: 'run-1',
      status: 'completed',
    },
    currentTaskSlug: 'task-a',
    pageFocused: true,
  })

  assert.deepEqual(second.unreadMap, {
    'task-b': true,
  })
  assert.equal(second.didMark, false)
  assert.equal(second.didDedupe, true)
})

test('clearFocusedTaskUnreadUpdateInMap only clears current task when page is focused', () => {
  const unreadMap = {
    'task-a': true,
    'task-b': true,
  }

  assert.deepEqual(clearFocusedTaskUnreadUpdateInMap(unreadMap, {
    currentTaskSlug: 'task-a',
    pageFocused: false,
  }), unreadMap)

  assert.deepEqual(clearFocusedTaskUnreadUpdateInMap(unreadMap, {
    currentTaskSlug: 'task-a',
    pageFocused: true,
  }), {
    'task-b': true,
  })
})

test('pruneNotifiedTerminalRunMap drops removed tasks and keeps known ones', () => {
  const result = pruneNotifiedTerminalRunMap({
    'run-1': {
      taskSlug: 'task-a',
      status: 'completed',
    },
    'run-2': {
      taskSlug: 'task-b',
      status: 'failed',
    },
  }, [
    { slug: 'task-b' },
  ])

  assert.deepEqual(result, {
    'run-2': {
      taskSlug: 'task-b',
      status: 'failed',
    },
  })
})

test('reorderTaskSummaries follows explicit slug order', () => {
  const reordered = reorderTaskSummaries([
    { slug: 'a' },
    { slug: 'b' },
    { slug: 'c' },
  ], ['c', 'a', 'b'])

  assert.deepEqual(reordered.map((item) => item.slug), ['c', 'a', 'b'])
})

test('reorderTaskSummaries preserves unknown trailing items', () => {
  const reordered = reorderTaskSummaries([
    { slug: 'a' },
    { slug: 'b' },
    { slug: 'c' },
  ], ['b', 'a'])

  assert.deepEqual(reordered.map((item) => item.slug), ['b', 'a', 'c'])
})

test('mergeTaskSummariesWithWorkspaceDiff preserves summary for same session', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
    },
  ])

  assert.deepEqual(merged[0].workspaceDiffSummary, {
    supported: true,
    fileCount: 3,
    additions: 10,
    deletions: 2,
    statsComplete: true,
  })
})

test('mergeTaskSummariesWithWorkspaceDiff follows server task order', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-a',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
    {
      slug: 'task-b',
      codexSessionId: 'session-b',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 2,
      },
    },
  ], [
    {
      slug: 'task-b',
      codexSessionId: 'session-b',
    },
    {
      slug: 'task-a',
      codexSessionId: 'session-a',
    },
  ])

  assert.deepEqual(merged.map((item) => item.slug), ['task-b', 'task-a'])
  assert.equal(merged[0].workspaceDiffSummary?.fileCount, 2)
  assert.equal(merged[1].workspaceDiffSummary?.fileCount, 1)
})

test('mergeTaskSummariesWithWorkspaceDiff clears summary when session changes', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-b',
    },
  ])

  assert.equal(merged[0].workspaceDiffSummary, null)
})

test('mergeTaskSummariesWithWorkspaceDiff clears summary when session is removed', () => {
  const merged = mergeTaskSummariesWithWorkspaceDiff([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      workspaceDiffSummary: {
        supported: true,
        fileCount: 3,
        additions: 10,
        deletions: 2,
        statsComplete: true,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: '',
    },
  ])

  assert.equal(merged[0].workspaceDiffSummary, null)
})

test('shouldRefreshWorkspaceDiffSummaries refreshes on initial load when session exists', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: null,
    },
  ]), true)
})

test('shouldRefreshWorkspaceDiffSummaries skips refresh when list shape and session state are stable', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ]), false)
})

test('shouldRefreshWorkspaceDiffSummaries refreshes when running state changes', () => {
  assert.equal(shouldRefreshWorkspaceDiffSummaries([
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: true,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ], [
    {
      slug: 'task-1',
      codexSessionId: 'session-a',
      running: false,
      workspaceDiffSummary: {
        supported: true,
        fileCount: 1,
      },
    },
  ]), true)
})
