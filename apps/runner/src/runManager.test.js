import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { classifyStopTimeoutPhase, createRunManager } from './runManager.js'

function createFakeServerClient() {
  return {
    events: [],
    statuses: [],
    async postEvents(items = []) {
      this.events.push(...items)
      return { ok: true }
    },
    async postStatus(payload = {}) {
      this.statuses.push(payload)
      return { ok: true }
    },
  }
}

function createDeferred() {
  let resolve
  let reject
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve
    reject = nextReject
  })
  return { promise, resolve, reject }
}

test('runManager.getRun 对不存在的 run 返回 null', () => {
  const runManager = createRunManager({
    serverClient: createFakeServerClient(),
    resolveRunner() {
      throw new Error('should not resolve runner')
    },
  })

  assert.equal(runManager.getRun('missing-run'), null)
})

test('runManager 可以驱动一个最小 fake runner 完成执行并推送状态和事件', async () => {
  const serverClient = createFakeServerClient()
  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt(session, prompt, callbacks = {}) {
          callbacks.onEvent?.({ type: 'stdout', text: `${session.id}:${prompt}` })
          callbacks.onThreadStarted?.('thread-test-1')
          return {
            child: {
              pid: 4321,
              exitCode: 0,
              signalCode: null,
            },
            result: Promise.resolve({
              sessionId: session.id,
              threadId: 'thread-test-1',
              message: 'done',
            }),
            cancel() {},
          }
        },
      }
    },
  })

  const snapshot = await runManager.startRun({
    runId: 'run-1',
    taskSlug: 'task-1',
    sessionId: 'session-1',
    title: 'Session 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello',
  })

  assert.equal(snapshot.runId, 'run-1')
  assert.ok(['starting', 'running'].includes(snapshot.status))

  await delay(20)

  const statuses = serverClient.statuses.map((item) => item.status)
  assert.ok(statuses.includes('queued'))
  assert.ok(statuses.includes('starting'))
  assert.ok(statuses.includes('running'))
  assert.ok(statuses.includes('completed'))

  const eventTypes = serverClient.events.map((item) => item.payload?.type || item.type)
  assert.ok(eventTypes.includes('session'))
  assert.ok(eventTypes.includes('stdout'))
  assert.ok(eventTypes.includes('session.updated'))
  assert.equal(runManager.getRun('run-1'), null)
})

test('runManager 会在 OpenCode 只于最终结果返回 threadId 时回写 session 身份', async () => {
  const serverClient = createFakeServerClient()
  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt() {
          return {
            child: {
              pid: 4322,
              exitCode: 0,
              signalCode: null,
            },
            result: Promise.resolve({
              sessionId: 'session-opencode-1',
              threadId: 'ses_opencode_final_1',
              message: 'done',
            }),
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-opencode-1',
    taskSlug: 'task-opencode-1',
    sessionId: 'session-opencode-1',
    title: 'OpenCode Session',
    engine: 'opencode',
    cwd: process.cwd(),
    prompt: 'hello',
  })

  await delay(20)

  const completedStatus = [...serverClient.statuses].reverse().find((item) => item.status === 'completed')
  assert.equal(completedStatus?.session?.engineSessionId, 'ses_opencode_final_1')
  assert.equal(completedStatus?.session?.engineThreadId, 'ses_opencode_final_1')
  assert.equal(completedStatus?.session?.codexThreadId, '')

  const sessionUpdatedEvent = serverClient.events.find((item) => item.payload?.type === 'session.updated')
  assert.equal(sessionUpdatedEvent?.payload?.session?.engineSessionId, 'ses_opencode_final_1')
})

test('runManager.getDiagnostics 返回活跃 run、排队信息和统计信息', async () => {
  const runManager = createRunManager({
    serverClient: createFakeServerClient(),
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          return {
            child: {
              pid: 5678,
              exitCode: null,
              signalCode: null,
            },
            result: delay(40).then(() => ({
              sessionId: session.id,
              threadId: 'thread-diag-1',
              message: 'done',
            })),
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-diag-1',
    taskSlug: 'task-diag-1',
    sessionId: 'session-diag-1',
    title: 'Session Diag 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello',
  })

  const diagnosticsWhileRunning = runManager.getDiagnostics()
  assert.equal(diagnosticsWhileRunning.activeRunCount, 1)
  assert.equal(diagnosticsWhileRunning.runningRunCount, 1)
  assert.equal(diagnosticsWhileRunning.trackedRunCount, 1)
  assert.equal(diagnosticsWhileRunning.queuedRunCount, 0)
  assert.equal(diagnosticsWhileRunning.metrics.totalStarted, 1)
  assert.equal(diagnosticsWhileRunning.activeRuns[0]?.runId, 'run-diag-1')
  assert.equal(diagnosticsWhileRunning.activeRuns[0]?.cwd, process.cwd())
  assert.equal(diagnosticsWhileRunning.config.maxConcurrentRuns, 3)

  await delay(70)

  const diagnosticsAfterComplete = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterComplete.activeRunCount, 0)
  assert.equal(diagnosticsAfterComplete.runningRunCount, 0)
  assert.equal(diagnosticsAfterComplete.trackedRunCount, 0)
  assert.equal(diagnosticsAfterComplete.metrics.totalCompleted, 1)
})

test('runManager 会按全局并发上限排队，并在前序 run 完成后拉起后续 run', async () => {
  const serverClient = createFakeServerClient()
  const startOrder = []
  const completions = new Map()
  let pidSeed = 4000

  const runManager = createRunManager({
    serverClient,
    maxConcurrentRuns: 1,
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          startOrder.push(session.id)
          const deferred = createDeferred()
          completions.set(session.id, deferred)
          pidSeed += 1
          return {
            child: {
              pid: pidSeed,
              exitCode: 0,
              signalCode: null,
            },
            result: deferred.promise,
            cancel() {},
          }
        },
      }
    },
  })

  const firstRun = await runManager.startRun({
    runId: 'run-queue-1',
    taskSlug: 'task-queue',
    sessionId: 'session-queue-1',
    title: 'Queue 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello-1',
  })
  const secondRun = await runManager.startRun({
    runId: 'run-queue-2',
    taskSlug: 'task-queue',
    sessionId: 'session-queue-2',
    title: 'Queue 2',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello-2',
  })

  assert.ok(['starting', 'running'].includes(firstRun.status))
  assert.equal(secondRun.status, 'queued')
  assert.deepEqual(startOrder, ['session-queue-1'])

  const diagnosticsWhileQueued = runManager.getDiagnostics()
  assert.equal(diagnosticsWhileQueued.activeRunCount, 1)
  assert.equal(diagnosticsWhileQueued.runningRunCount, 1)
  assert.equal(diagnosticsWhileQueued.trackedRunCount, 2)
  assert.equal(diagnosticsWhileQueued.queuedRunCount, 1)
  assert.equal(diagnosticsWhileQueued.queuedRuns[0]?.runId, 'run-queue-2')
  assert.equal(diagnosticsWhileQueued.metrics.totalStarted, 1)

  completions.get('session-queue-1').resolve({
    sessionId: 'session-queue-1',
    threadId: 'thread-queue-1',
    message: 'done-1',
  })
  await delay(40)

  assert.deepEqual(startOrder, ['session-queue-1', 'session-queue-2'])
  const secondSnapshot = runManager.getRun('run-queue-2')
  assert.ok(secondSnapshot)
  assert.ok(['starting', 'running'].includes(secondSnapshot.status))

  completions.get('session-queue-2').resolve({
    sessionId: 'session-queue-2',
    threadId: 'thread-queue-2',
    message: 'done-2',
  })
  await delay(40)

  const diagnosticsAfterComplete = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterComplete.activeRunCount, 0)
  assert.equal(diagnosticsAfterComplete.runningRunCount, 0)
  assert.equal(diagnosticsAfterComplete.trackedRunCount, 0)
  assert.equal(diagnosticsAfterComplete.queuedRunCount, 0)
  assert.equal(diagnosticsAfterComplete.metrics.totalStarted, 2)
  assert.equal(diagnosticsAfterComplete.metrics.totalCompleted, 2)

  const secondStatuses = serverClient.statuses
    .filter((item) => item.runId === 'run-queue-2')
    .map((item) => item.status)
  assert.deepEqual(secondStatuses.slice(0, 2), ['queued', 'starting'])
})

test('runManager 可以动态更新 maxConcurrentRuns 并立刻继续拉起排队 run', async () => {
  const startOrder = []
  const completions = new Map()

  const runManager = createRunManager({
    serverClient: createFakeServerClient(),
    maxConcurrentRuns: 1,
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          startOrder.push(session.id)
          const deferred = createDeferred()
          completions.set(session.id, deferred)
          return {
            child: {
              pid: 7100 + startOrder.length,
              exitCode: 0,
              signalCode: null,
            },
            result: deferred.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-update-config-1',
    taskSlug: 'task-update-config',
    sessionId: 'session-update-config-1',
    title: 'Update Config 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello-1',
  })
  await runManager.startRun({
    runId: 'run-update-config-2',
    taskSlug: 'task-update-config',
    sessionId: 'session-update-config-2',
    title: 'Update Config 2',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hello-2',
  })

  assert.deepEqual(startOrder, ['session-update-config-1'])
  assert.equal(runManager.getDiagnostics().queuedRunCount, 1)
  assert.equal(runManager.getDiagnostics().trackedRunCount, 2)

  const config = await runManager.updateConfig({
    maxConcurrentRuns: 2,
  })
  await delay(40)

  assert.equal(config.maxConcurrentRuns, 2)
  assert.deepEqual(startOrder, ['session-update-config-1', 'session-update-config-2'])

  completions.get('session-update-config-1').resolve({
    sessionId: 'session-update-config-1',
    threadId: 'thread-update-config-1',
    message: 'done-1',
  })
  completions.get('session-update-config-2').resolve({
    sessionId: 'session-update-config-2',
    threadId: 'thread-update-config-2',
    message: 'done-2',
  })
  await delay(40)

  assert.equal(runManager.getDiagnostics().metrics.totalCompleted, 2)
})

test('runManager 会为 queued run 持续发送心跳，避免被误判为失联', async () => {
  const serverClient = createFakeServerClient()
  const firstCompletion = createDeferred()

  const runManager = createRunManager({
    serverClient,
    maxConcurrentRuns: 1,
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          return {
            child: {
              pid: session.id === 'session-queued-heartbeat-1' ? 7201 : 7202,
              exitCode: 0,
              signalCode: null,
            },
            result: firstCompletion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-queued-heartbeat-1',
    taskSlug: 'task-queued-heartbeat',
    sessionId: 'session-queued-heartbeat-1',
    title: 'Queued Heartbeat 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hold',
  })
  await runManager.startRun({
    runId: 'run-queued-heartbeat-2',
    taskSlug: 'task-queued-heartbeat',
    sessionId: 'session-queued-heartbeat-2',
    title: 'Queued Heartbeat 2',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'queued',
  })

  await delay(1100)

  const queuedStatuses = serverClient.statuses.filter((item) => item.runId === 'run-queued-heartbeat-2')
  const queuedHeartbeatCount = queuedStatuses.filter((item) => item.status === 'queued').length
  assert.equal(queuedHeartbeatCount >= 2, true)

  firstCompletion.resolve({
    sessionId: 'session-queued-heartbeat-1',
    threadId: 'thread-queued-heartbeat-1',
    message: 'done',
  })
  await delay(60)
})

test('runManager 会为长时间静默的 running run 补发可见进度事件', async () => {
  const serverClient = createFakeServerClient()
  const completion = createDeferred()

  const runManager = createRunManager({
    serverClient,
    heartbeatIntervalMs: 120,
    idleProgressEventMs: 180,
    idleProgressEventRepeatMs: 180,
    eventFlushIntervalMs: 30,
    resolveRunner() {
      return {
        streamSessionPrompt() {
          return {
            child: {
              pid: 7301,
              exitCode: 0,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-idle-progress-1',
    taskSlug: 'task-idle-progress',
    sessionId: 'session-idle-progress-1',
    title: 'Idle Progress 1',
    engine: 'claude-code',
    cwd: process.cwd(),
    prompt: 'silent run',
  })

  await delay(420)

  const statusEvents = serverClient.events
    .map((item) => item.payload || {})
    .filter((payload) => payload.type === 'status')

  assert.equal(
    statusEvents.some((payload) => String(payload.message || '').includes('最近暂无新的过程输出')),
    true
  )

  completion.resolve({
    sessionId: 'session-idle-progress-1',
    threadId: 'thread-idle-progress-1',
    message: 'done',
  })
  await delay(80)
})

test('runManager 可以直接停止尚未启动的 queued run', async () => {
  const serverClient = createFakeServerClient()
  const firstCompletion = createDeferred()

  const runManager = createRunManager({
    serverClient,
    maxConcurrentRuns: 1,
    resolveRunner() {
      return {
        streamSessionPrompt(session) {
          return {
            child: {
              pid: session.id === 'session-stop-1' ? 5011 : 5012,
              exitCode: 0,
              signalCode: null,
            },
            result: firstCompletion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-stop-1',
    taskSlug: 'task-stop',
    sessionId: 'session-stop-1',
    title: 'Stop 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'hold',
  })
  await runManager.startRun({
    runId: 'run-stop-2',
    taskSlug: 'task-stop',
    sessionId: 'session-stop-2',
    title: 'Stop 2',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'queued',
  })

  const stoppedSnapshot = await runManager.stopRun('run-stop-2')
  assert.equal(stoppedSnapshot?.status, 'stopped')
  assert.equal(runManager.getRun('run-stop-2'), null)

  const diagnosticsAfterStop = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterStop.activeRunCount, 1)
  assert.equal(diagnosticsAfterStop.runningRunCount, 1)
  assert.equal(diagnosticsAfterStop.trackedRunCount, 1)
  assert.equal(diagnosticsAfterStop.queuedRunCount, 0)
  assert.equal(diagnosticsAfterStop.metrics.totalStarted, 1)
  assert.equal(diagnosticsAfterStop.metrics.totalStopped, 1)
  assert.equal(diagnosticsAfterStop.metrics.stopReasons.queued_cancelled, 1)

  const secondStatuses = serverClient.statuses
    .filter((item) => item.runId === 'run-stop-2')
    .map((item) => item.status)
  assert.deepEqual(secondStatuses, ['queued', 'stopped'])

  firstCompletion.resolve({
    sessionId: 'session-stop-1',
    threadId: 'thread-stop-1',
    message: 'done',
  })
  await delay(40)

  const diagnosticsAfterComplete = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterComplete.metrics.totalCompleted, 1)
  assert.equal(diagnosticsAfterComplete.metrics.totalStopped, 1)
  assert.equal(diagnosticsAfterComplete.metrics.stopReasons.queued_cancelled, 1)
})

test('runManager 会统计运行中 stop 的原因分类', async () => {
  const serverClient = createFakeServerClient()
  const completion = createDeferred()

  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt() {
          return {
            child: {
              pid: 6011,
              exitCode: 0,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-stop-reason-1',
    taskSlug: 'task-stop-reason',
    sessionId: 'session-stop-reason-1',
    title: 'Stop Reason 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'stop me',
  })

  await delay(20)
  const stoppingSnapshot = await runManager.stopRun('run-stop-reason-1')
  assert.equal(stoppingSnapshot?.status, 'stopping')

  completion.resolve({
    sessionId: 'session-stop-reason-1',
    threadId: 'thread-stop-reason-1',
    message: 'cancelled',
  })
  await delay(40)

  const diagnostics = runManager.getDiagnostics()
  assert.equal(diagnostics.metrics.totalStopped, 1)
  assert.equal(diagnostics.metrics.stopReasons.user_requested, 1)
  assert.equal(diagnostics.metrics.stopReasons.user_requested_after_error, 0)
  assert.equal(diagnostics.metrics.stopReasons.stop_timeout, 0)
})

test('runManager 会把 stop 后的执行报错归类为 user_requested', async () => {
  const serverClient = createFakeServerClient()
  const completion = createDeferred()

  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt() {
          return {
            child: {
              pid: 6111,
              exitCode: null,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-stop-error-1',
    taskSlug: 'task-stop-error',
    sessionId: 'session-stop-error-1',
    title: 'Stop Error 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'stop me with error',
  })

  await delay(20)
  await runManager.stopRun('run-stop-error-1')
  completion.reject(new Error('killed by stop'))
  await delay(40)

  const diagnostics = runManager.getDiagnostics()
  assert.equal(diagnostics.metrics.totalStopped, 1)
  assert.equal(diagnostics.metrics.stopReasons.user_requested, 1)
  assert.equal(diagnostics.metrics.stopReasons.user_requested_after_error, 0)
})

test('runManager 会统计 event flush 失败次数', async () => {
  const completion = createDeferred()
  const serverClient = {
    events: [],
    statuses: [],
    postEventAttempts: 0,
    async postEvents(items = []) {
      this.postEventAttempts += 1
      if (this.postEventAttempts === 1) {
        throw new Error('flush failed once')
      }
      this.events.push(...items)
      return { ok: true }
    },
    async postStatus(payload = {}) {
      this.statuses.push(payload)
      return { ok: true }
    },
  }

  const runManager = createRunManager({
    serverClient,
    logger: {
      error() {},
    },
    resolveRunner() {
      return {
        streamSessionPrompt(session, prompt, callbacks = {}) {
          callbacks.onEvent?.({ type: 'stdout', text: `${session.id}:${prompt}` })
          return {
            child: {
              pid: 7011,
              exitCode: 0,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-flush-failure-1',
    taskSlug: 'task-flush-failure',
    sessionId: 'session-flush-failure-1',
    title: 'Flush Failure 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'emit once',
  })

  await delay(320)

  const diagnosticsWhileRunning = runManager.getDiagnostics()
  assert.equal(diagnosticsWhileRunning.metrics.eventFlushFailureCount, 1)
  assert.equal(diagnosticsWhileRunning.metrics.lastEventFlushFailureMessage, 'flush failed once')
  assert.equal(diagnosticsWhileRunning.activeRuns[0]?.eventFlushFailureCount, 1)

  completion.resolve({
    sessionId: 'session-flush-failure-1',
    threadId: 'thread-flush-failure-1',
    message: 'done',
  })
  await delay(60)

  const diagnosticsAfterComplete = runManager.getDiagnostics()
  assert.equal(diagnosticsAfterComplete.metrics.totalCompleted, 1)
  assert.equal(serverClient.postEventAttempts >= 2, true)
})

test('runManager 会按批次拆分较大的事件上报', async () => {
  const completion = createDeferred()
  const serverClient = {
    batches: [],
    statuses: [],
    async postEvents(items = []) {
      this.batches.push(items)
      return { ok: true }
    },
    async postStatus(payload = {}) {
      this.statuses.push(payload)
      return { ok: true }
    },
  }

  const runManager = createRunManager({
    serverClient,
    resolveRunner() {
      return {
        streamSessionPrompt(session, prompt, callbacks = {}) {
          callbacks.onEvent?.({ type: 'stdout', text: `${session.id}:${prompt}` })
          callbacks.onEvent?.({ type: 'stdout', text: 'x'.repeat(350_000) })
          callbacks.onEvent?.({ type: 'stdout', text: 'y'.repeat(350_000) })
          return {
            child: {
              pid: 8011,
              exitCode: 0,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-large-batch-1',
    taskSlug: 'task-large-batch',
    sessionId: 'session-large-batch-1',
    title: 'Large Batch 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'emit large events',
  })

  completion.resolve({
    sessionId: 'session-large-batch-1',
    threadId: 'thread-large-batch-1',
    message: 'done',
  })
  await delay(80)

  assert.equal(serverClient.statuses.some((item) => item.status === 'completed'), true)
  assert.equal(serverClient.batches.length >= 2, true)
  assert.equal(serverClient.batches.flat().some((item) => item.payload?.text?.startsWith('x')), true)
  assert.equal(serverClient.batches.flat().some((item) => item.payload?.text?.startsWith('y')), true)
})

test('runManager 分批上报失败后只重试未成功的批次', async () => {
  const completion = createDeferred()
  const serverClient = {
    events: [],
    statuses: [],
    postEventAttempts: 0,
    async postEvents(items = []) {
      this.postEventAttempts += 1
      if (this.postEventAttempts === 2) {
        throw new Error('second batch failed')
      }
      this.events.push(...items)
      return { ok: true }
    },
    async postStatus(payload = {}) {
      this.statuses.push(payload)
      return { ok: true }
    },
  }

  const runManager = createRunManager({
    serverClient,
    logger: {
      error() {},
    },
    resolveRunner() {
      return {
        streamSessionPrompt(session, prompt, callbacks = {}) {
          callbacks.onEvent?.({ type: 'stdout', text: `${session.id}:${prompt}` })
          callbacks.onEvent?.({ type: 'stdout', text: 'x'.repeat(350_000) })
          callbacks.onEvent?.({ type: 'stdout', text: 'y'.repeat(350_000) })
          callbacks.onEvent?.({ type: 'stdout', text: 'z'.repeat(350_000) })
          return {
            child: {
              pid: 8012,
              exitCode: 0,
              signalCode: null,
            },
            result: completion.promise,
            cancel() {},
          }
        },
      }
    },
  })

  await runManager.startRun({
    runId: 'run-large-batch-retry-1',
    taskSlug: 'task-large-batch-retry',
    sessionId: 'session-large-batch-retry-1',
    title: 'Large Batch Retry 1',
    engine: 'codex',
    cwd: process.cwd(),
    prompt: 'emit large events and retry',
  })

  await delay(420)

  completion.resolve({
    sessionId: 'session-large-batch-retry-1',
    threadId: 'thread-large-batch-retry-1',
    message: 'done',
  })
  await delay(80)

  const seqList = serverClient.events.map((item) => item.seq)
  assert.equal(serverClient.postEventAttempts >= 4, true)
  assert.equal(seqList.length, new Set(seqList).size)
  assert.equal(serverClient.events.some((item) => item.payload?.text?.startsWith('x')), true)
  assert.equal(serverClient.events.some((item) => item.payload?.text?.startsWith('y')), true)
  assert.equal(serverClient.events.some((item) => item.payload?.text?.startsWith('z')), true)
})

test('classifyStopTimeoutPhase 会区分 stop_timeout 的尾部阶段', () => {
  assert.equal(classifyStopTimeoutPhase({}), 'runner_timeout_without_stop_request')
  assert.equal(
    classifyStopTimeoutPhase({
      stopRequestedAt: '2026-03-22T00:00:00.000Z',
      stopStage: 'cancel_failed',
    }),
    'runner_timeout_before_cancel'
  )
  assert.equal(
    classifyStopTimeoutPhase({
      stopRequestedAt: '2026-03-22T00:00:00.000Z',
      child: {
        __promptxStopControl: {
          requestedAt: '2026-03-22T00:00:00.000Z',
          gracefulSignalAt: '2026-03-22T00:00:01.000Z',
          forceKillAttemptedAt: '',
          exitObservedAt: '',
          exitCode: null,
          signalCode: '',
          lastKnownAlive: true,
          cancelErrorMessage: '',
        },
      },
    }),
    'cli_not_exiting'
  )
  assert.equal(
    classifyStopTimeoutPhase({
      stopRequestedAt: '2026-03-22T00:00:00.000Z',
      child: {
        __promptxStopControl: {
          requestedAt: '2026-03-22T00:00:00.000Z',
          gracefulSignalAt: '2026-03-22T00:00:01.000Z',
          forceKillAttemptedAt: '2026-03-22T00:00:03.000Z',
          exitObservedAt: '',
          exitCode: null,
          signalCode: '',
          lastKnownAlive: true,
          cancelErrorMessage: '',
        },
      },
    }),
    'os_kill_slow'
  )
  assert.equal(
    classifyStopTimeoutPhase({
      stopRequestedAt: '2026-03-22T00:00:00.000Z',
      child: {
        __promptxStopControl: {
          requestedAt: '2026-03-22T00:00:00.000Z',
          gracefulSignalAt: '2026-03-22T00:00:01.000Z',
          forceKillAttemptedAt: '2026-03-22T00:00:03.000Z',
          exitObservedAt: '2026-03-22T00:00:04.000Z',
          exitCode: null,
          signalCode: '',
          lastKnownAlive: false,
          cancelErrorMessage: '',
        },
      },
    }),
    'runner_finalize_after_exit'
  )
})
