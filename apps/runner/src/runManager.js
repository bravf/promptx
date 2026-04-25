import {
  createSessionEnvelopeEvent,
  createSessionUpdatedEnvelopeEvent,
  createStatusEnvelopeEvent,
  createStoppedEnvelopeEvent,
  getAgentEngineLabel,
} from '../../../packages/shared/src/index.js'
import { assertAgentRunner } from './engines/index.js'
import { getChildStopDiagnostics } from './processControl.js'

const EVENT_FLUSH_INTERVAL_MS = Math.max(50, Number(process.env.PROMPTX_RUNNER_EVENT_FLUSH_MS) || 250)
const HEARTBEAT_INTERVAL_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_HEARTBEAT_MS) || 3000)
const STOPPING_HEARTBEAT_INTERVAL_MS = Math.max(
  250,
  Number(process.env.PROMPTX_RUNNER_STOP_HEARTBEAT_MS) || Math.min(HEARTBEAT_INTERVAL_MS, 500)
)
const QUEUED_HEARTBEAT_INTERVAL_MS = Math.max(
  250,
  Number(process.env.PROMPTX_RUNNER_QUEUE_HEARTBEAT_MS) || Math.min(HEARTBEAT_INTERVAL_MS, STOPPING_HEARTBEAT_INTERVAL_MS, 1000)
)
const DEFAULT_STOP_TIMEOUT_MS = Math.max(1000, Number(process.env.PROMPTX_RUNNER_STOP_TIMEOUT_MS) || 10000)
const STOP_TIMEOUT_BUFFER_MS = Math.max(500, Number(process.env.PROMPTX_RUNNER_STOP_TIMEOUT_BUFFER_MS) || 2000)
const DEFAULT_MAX_CONCURRENT_RUNS = Math.max(1, Number(process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS) || 3)
const DEFAULT_EVENT_BATCH_BYTES = Math.max(
  64 * 1024,
  Number(process.env.PROMPTX_RUNNER_EVENT_BATCH_BYTES) || 512 * 1024
)
const DEFAULT_IDLE_PROGRESS_EVENT_MS = Math.max(
  5000,
  Number(process.env.PROMPTX_RUNNER_IDLE_PROGRESS_EVENT_MS) || 15000
)
const DEFAULT_IDLE_PROGRESS_EVENT_REPEAT_MS = Math.max(
  DEFAULT_IDLE_PROGRESS_EVENT_MS,
  Number(process.env.PROMPTX_RUNNER_IDLE_PROGRESS_EVENT_REPEAT_MS) || DEFAULT_IDLE_PROGRESS_EVENT_MS
)
const RUNNER_ID = String(process.env.PROMPTX_RUNNER_ID || 'local-runner').trim() || 'local-runner'
const DISPOSE_POLL_INTERVAL_MS = Math.max(50, Number(process.env.PROMPTX_RUNNER_DISPOSE_POLL_MS) || 100)

function nowIso() {
  return new Date().toISOString()
}

function estimateJsonBytes(value) {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8')
  } catch {
    return Buffer.byteLength(String(value || ''), 'utf8')
  }
}

function splitEventItemsIntoBatches(items = [], metadata = {}, maxBatchBytes = DEFAULT_EVENT_BATCH_BYTES) {
  const normalizedLimit = Math.max(16 * 1024, Number(maxBatchBytes) || DEFAULT_EVENT_BATCH_BYTES)
  const normalizedItems = Array.isArray(items) ? items.filter(Boolean) : []
  if (!normalizedItems.length) {
    return []
  }

  const metadataBytes = estimateJsonBytes(metadata)
  const batches = []
  let currentBatch = []
  let currentBytes = metadataBytes

  normalizedItems.forEach((item) => {
    const itemBytes = estimateJsonBytes(item) + 1
    if (currentBatch.length && currentBytes + itemBytes > normalizedLimit) {
      batches.push(currentBatch)
      currentBatch = [item]
      currentBytes = metadataBytes + itemBytes
      return
    }

    currentBatch.push(item)
    currentBytes += itemBytes
  })

  if (currentBatch.length) {
    batches.push(currentBatch)
  }

  return batches
}

function normalizeMaxConcurrentRuns(value, fallback = DEFAULT_MAX_CONCURRENT_RUNS) {
  const normalizedFallback = Math.max(1, Number(fallback) || DEFAULT_MAX_CONCURRENT_RUNS)
  return Math.max(1, Number(value) || normalizedFallback)
}

function normalizeSession(payload = {}) {
  const engine = String(payload.engine || '').trim() || 'codex'
  const isShellEngine = engine === 'shell'
  return {
    id: String(payload.sessionId || payload.id || '').trim(),
    title: String(payload.sessionTitle || payload.title || '').trim(),
    engine,
    cwd: String(payload.cwd || '').trim(),
    codexThreadId: isShellEngine ? '' : String(payload.codexThreadId || payload.engineThreadId || '').trim(),
    engineSessionId: isShellEngine ? '' : String(payload.engineSessionId || '').trim(),
    engineThreadId: isShellEngine ? '' : String(payload.engineThreadId || payload.codexThreadId || '').trim(),
    engineMeta: isShellEngine
      ? {}
      : (payload.engineMeta && typeof payload.engineMeta === 'object' ? payload.engineMeta : {}),
    running: true,
    started: isShellEngine ? false : Boolean(String(payload.engineThreadId || payload.codexThreadId || '').trim()),
    createdAt: String(payload.sessionCreatedAt || '').trim(),
    updatedAt: String(payload.sessionUpdatedAt || '').trim(),
  }
}

function applyThreadIdentity(session = {}, threadId = '') {
  const value = String(threadId || '').trim()
  if (!value) {
    return session
  }

  const engine = String(session?.engine || '').trim() || 'codex'
  if (engine === 'codex') {
    return {
      ...session,
      codexThreadId: value,
      engineThreadId: value,
      running: true,
      started: true,
      updatedAt: nowIso(),
    }
  }

  return {
    ...session,
    engineSessionId: value,
    engineThreadId: value,
    running: true,
    started: true,
    updatedAt: nowIso(),
  }
}

function createRunSnapshot(context = {}) {
  const stopControl = getChildStopDiagnostics(context.child)
  return {
    runId: context.runId,
    taskSlug: context.taskSlug,
    sessionId: context.session?.id || '',
    engine: context.engine,
    status: context.status,
    pid: Number(context.child?.pid || context.pid || 0) || 0,
    stopRequested: Boolean(context.stopRequestedAt),
    stopRequestedAt: context.stopRequestedAt || '',
    stopReason: String(context.stopReason || '').trim(),
    stopStage: String(context.stopStage || '').trim(),
    stopTimeoutPhase: String(context.stopTimeoutPhase || '').trim(),
    stopCancelErrorMessage: String(context.stopCancelErrorMessage || '').trim(),
    startedAt: context.startedAt || '',
    finishedAt: context.finishedAt || '',
    lastHeartbeatAt: context.lastHeartbeatAt || '',
    lastSeq: Math.max(0, Number(context.lastSeq) || 0),
    eventFlushFailureCount: Math.max(0, Number(context.eventFlushFailureCount) || 0),
    stopControl,
  }
}

export function classifyStopTimeoutPhase(context = {}) {
  if (!context?.stopRequestedAt) {
    return 'runner_timeout_without_stop_request'
  }

  if (String(context.stopStage || '').trim() === 'cancel_failed') {
    return 'runner_timeout_before_cancel'
  }

  const stopControl = getChildStopDiagnostics(context.child)
  if (stopControl.exitObservedAt) {
    return 'runner_finalize_after_exit'
  }
  if (stopControl.forceKillAttemptedAt) {
    return 'os_kill_slow'
  }
  if (stopControl.gracefulSignalAt) {
    return 'cli_not_exiting'
  }
  return 'runner_timeout_before_cancel'
}

function classifyStoppedErrorReason(context = {}) {
  if (!context?.stopRequestedAt) {
    return 'user_requested_after_error'
  }

  const stopControl = getChildStopDiagnostics(context.child)
  if (
    stopControl.gracefulSignalAt
    || stopControl.forceKillAttemptedAt
    || stopControl.exitObservedAt
    || String(context.stopStage || '').trim() === 'cancel_signaled'
  ) {
    return 'user_requested'
  }

  return 'user_requested_after_error'
}

function sleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, Math.max(0, Number(ms) || 0))
    timer.unref?.()
  })
}

function isProgressPayload(payload = {}) {
  const type = String(payload?.type || '').trim()
  return !['status', 'session', 'session.updated'].includes(type)
}

function createIdleProgressEvent(context = {}) {
  const status = String(context.status || '').trim()
  if (status === 'queued') {
    return createStatusEnvelopeEvent({
      stage: 'queued',
      message: '当前仍在排队，等待 runner 空闲后开始执行。',
      messageKey: 'runner.status.queued',
    })
  }

  if (status === 'stopping') {
    return createStatusEnvelopeEvent({
      stage: 'stopping',
      message: '正在停止执行，等待引擎退出...',
      messageKey: 'runner.status.stopping',
    })
  }

  const agentLabel = getAgentEngineLabel(context.engine || 'codex')
  return createStatusEnvelopeEvent({
    stage: 'running',
    message: `${agentLabel} 正在思考中...`,
    messageKey: 'runner.status.thinking',
    messageParams: { agentLabel },
  })
}

export function createRunManager(options = {}) {
  const serverClient = options.serverClient
  const logger = options.logger || console
  const resolveRunner = typeof options.resolveRunner === 'function' ? options.resolveRunner : assertAgentRunner
  const eventFlushIntervalMs = Math.max(20, Number(options.eventFlushIntervalMs) || EVENT_FLUSH_INTERVAL_MS)
  const heartbeatIntervalMs = Math.max(100, Number(options.heartbeatIntervalMs) || HEARTBEAT_INTERVAL_MS)
  const stoppingHeartbeatIntervalMs = Math.max(
    100,
    Number(options.stoppingHeartbeatIntervalMs) || STOPPING_HEARTBEAT_INTERVAL_MS
  )
  const queuedHeartbeatIntervalMs = Math.max(
    100,
    Number(options.queuedHeartbeatIntervalMs) || QUEUED_HEARTBEAT_INTERVAL_MS
  )
  const defaultStopTimeoutMs = Math.max(1000, Number(options.defaultStopTimeoutMs) || DEFAULT_STOP_TIMEOUT_MS)
  const stopTimeoutBufferMs = Math.max(200, Number(options.stopTimeoutBufferMs) || STOP_TIMEOUT_BUFFER_MS)
  const idleProgressEventMs = Math.max(
    heartbeatIntervalMs,
    Number(options.idleProgressEventMs) || DEFAULT_IDLE_PROGRESS_EVENT_MS
  )
  const idleProgressEventRepeatMs = Math.max(
    idleProgressEventMs,
    Number(options.idleProgressEventRepeatMs) || DEFAULT_IDLE_PROGRESS_EVENT_REPEAT_MS
  )
  const runtimeConfig = {
    maxConcurrentRuns: normalizeMaxConcurrentRuns(options.maxConcurrentRuns, DEFAULT_MAX_CONCURRENT_RUNS),
  }
  const activeRuns = new Map()
  const queuedRunIds = []
  const startedAt = nowIso()
  const metrics = {
    totalStarted: 0,
    totalCompleted: 0,
    totalErrored: 0,
    totalStopped: 0,
    totalStopTimeout: 0,
    eventFlushFailureCount: 0,
    lastEventFlushFailureAt: '',
    lastEventFlushFailureMessage: '',
    stopReasons: {
      queued_cancelled: 0,
      user_requested: 0,
      user_requested_after_error: 0,
      stop_timeout: 0,
    },
    stopTimeoutPhases: {
      runner_timeout_without_stop_request: 0,
      runner_timeout_before_cancel: 0,
      cli_not_exiting: 0,
      os_kill_slow: 0,
      runner_finalize_after_exit: 0,
    },
  }

  function recordStopReason(reason = '') {
    const normalizedReason = String(reason || '').trim()
    if (!normalizedReason || !Object.prototype.hasOwnProperty.call(metrics.stopReasons, normalizedReason)) {
      return
    }
    metrics.stopReasons[normalizedReason] += 1
  }

  function recordStopTimeoutPhase(phase = '') {
    const normalizedPhase = String(phase || '').trim()
    if (!normalizedPhase || !Object.prototype.hasOwnProperty.call(metrics.stopTimeoutPhases, normalizedPhase)) {
      return
    }
    metrics.stopTimeoutPhases[normalizedPhase] += 1
  }

  async function postStatus(context, payload = {}) {
    context.lastHeartbeatAt = nowIso()
    try {
      await serverClient.postStatus({
        runnerId: RUNNER_ID,
        runId: context.runId,
        taskSlug: context.taskSlug,
        sessionId: context.session?.id || '',
        status: context.status,
        pid: Number(context.child?.pid || context.pid || 0) || 0,
        heartbeatAt: context.lastHeartbeatAt,
        ...payload,
      })
    } catch (error) {
      logger.error?.(error, 'runner status push failed')
    }
  }

  function queueEvent(context, payload = {}) {
    const normalizedPayload = payload && typeof payload === 'object'
      ? payload
      : { type: 'status', message: String(payload || '') }

    if (isProgressPayload(normalizedPayload)) {
      context.lastProgressEventAt = Date.now()
      context.lastIdleProgressEventAt = 0
    }

    context.lastSeq += 1
    context.eventBuffer.push({
      runId: context.runId,
      seq: context.lastSeq,
      type: String(normalizedPayload.type || '').trim() || 'event',
      ts: nowIso(),
      payload: normalizedPayload,
    })
    scheduleFlush(context)
  }

  function isQueuedRunStatus(status = '') {
    return String(status || '').trim() === 'queued'
  }

  function countsTowardConcurrency(context) {
    if (!context || context.finalized) {
      return false
    }
    const status = String(context.status || '').trim()
    return status === 'starting' || status === 'running' || status === 'stopping'
  }

  function getRunningSlotCount() {
    return [...activeRuns.values()].reduce((count, context) => count + (countsTowardConcurrency(context) ? 1 : 0), 0)
  }

  function enqueueRun(context) {
    if (!context?.runId) {
      return
    }
    if (!queuedRunIds.includes(context.runId)) {
      queuedRunIds.push(context.runId)
    }
  }

  function dequeueRun(runId = '') {
    const index = queuedRunIds.indexOf(String(runId || '').trim())
    if (index >= 0) {
      queuedRunIds.splice(index, 1)
    }
  }

  async function flushEvents(context, force = false) {
    if (!context) {
      return 0
    }

    if (!force && context.flushing) {
      return 0
    }

    if (!context.eventBuffer.length) {
      if (context.flushTimer) {
        clearTimeout(context.flushTimer)
        context.flushTimer = null
      }
      return 0
    }

    if (context.flushTimer) {
      clearTimeout(context.flushTimer)
      context.flushTimer = null
    }

    const pendingItems = context.eventBuffer.splice(0, context.eventBuffer.length)
    const batches = splitEventItemsIntoBatches(pendingItems, { runnerId: RUNNER_ID })
    context.flushing = true

    let batchIndex = 0
    try {
      for (batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
        const batch = batches[batchIndex]
        await serverClient.postEvents(batch, { runnerId: RUNNER_ID })
      }
      return pendingItems.length
    } catch (error) {
      const remainingItems = batches.slice(batchIndex).flat()
      context.eventBuffer.unshift(...remainingItems)
      context.eventFlushFailureCount = Math.max(0, Number(context.eventFlushFailureCount) || 0) + 1
      context.lastEventFlushFailureAt = nowIso()
      context.lastEventFlushFailureMessage = String(error?.message || error || '').trim()
      metrics.eventFlushFailureCount += 1
      metrics.lastEventFlushFailureAt = context.lastEventFlushFailureAt
      metrics.lastEventFlushFailureMessage = context.lastEventFlushFailureMessage
      logger.error?.(error, 'runner event flush failed')
      if (!context.finalized) {
        scheduleFlush(context)
      }
      return 0
    } finally {
      context.flushing = false
    }
  }

  function scheduleFlush(context) {
    if (context.flushTimer) {
      return
    }

    context.flushTimer = setTimeout(() => {
      context.flushTimer = null
      flushEvents(context).catch(() => {})
    }, eventFlushIntervalMs)
    context.flushTimer.unref?.()
  }

  function maybeQueueIdleProgressEvent(context) {
    if (!context || context.finalized) {
      return
    }

    const status = String(context.status || '').trim()
    if (!['queued', 'starting', 'running', 'stopping'].includes(status)) {
      return
    }

    const now = Date.now()
    const lastProgressAt = Math.max(
      0,
      Number(context.lastProgressEventAt) || 0,
      Date.parse(String(context.startedAt || '')) || 0
    )
    const lastIdleProgressEventAt = Math.max(0, Number(context.lastIdleProgressEventAt) || 0)

    if (!lastProgressAt || now - lastProgressAt < idleProgressEventMs) {
      return
    }

    if (lastIdleProgressEventAt && now - lastIdleProgressEventAt < idleProgressEventRepeatMs) {
      return
    }

    queueEvent(context, createIdleProgressEvent(context))
    context.lastIdleProgressEventAt = now
  }

  function startHeartbeat(context) {
    if (context.heartbeatTimer) {
      return
    }

    context.heartbeatTimer = setInterval(() => {
      if (context.finalized) {
        return
      }
      maybeQueueIdleProgressEvent(context)
      postStatus(context).catch(() => {})
    }, heartbeatIntervalMs)
    context.heartbeatTimer.unref?.()
  }

  function stopHeartbeat(context) {
    if (context.heartbeatTimer) {
      clearInterval(context.heartbeatTimer)
      context.heartbeatTimer = null
    }
  }

  function startQueuedHeartbeat(context) {
    if (context.queueHeartbeatTimer) {
      return
    }

    context.queueHeartbeatTimer = setInterval(() => {
      if (context.finalized || !isQueuedRunStatus(context.status)) {
        return
      }
      maybeQueueIdleProgressEvent(context)
      postStatus(context).catch(() => {})
    }, queuedHeartbeatIntervalMs)
    context.queueHeartbeatTimer.unref?.()
  }

  function stopQueuedHeartbeat(context) {
    if (context.queueHeartbeatTimer) {
      clearInterval(context.queueHeartbeatTimer)
      context.queueHeartbeatTimer = null
    }
  }

  function startStopProgressHeartbeat(context) {
    if (context.stopProgressTimer) {
      return
    }

    context.stopProgressTimer = setInterval(() => {
      if (context.finalized || !context.stopRequestedAt) {
        return
      }
      maybeQueueIdleProgressEvent(context)
      postStatus(context, {
        stopRequestedAt: context.stopRequestedAt,
      }).catch(() => {})
    }, stoppingHeartbeatIntervalMs)
    context.stopProgressTimer.unref?.()
  }

  function stopStopProgressHeartbeat(context) {
    if (context.stopProgressTimer) {
      clearInterval(context.stopProgressTimer)
      context.stopProgressTimer = null
    }
  }

  async function finalizeRun(context, nextStatus, payload = {}) {
    if (!context || context.finalized) {
      return createRunSnapshot(context)
    }

    context.finalized = true
    context.status = String(nextStatus || context.status || 'completed').trim() || 'completed'
    context.finishedAt = payload.finishedAt || nowIso()
    context.stopReason = String(payload.stopReason || context.stopReason || '').trim()
    context.stopStage = String(payload.stopStage || context.stopStage || '').trim()
    context.stopTimeoutPhase = String(payload.stopTimeoutPhase || context.stopTimeoutPhase || '').trim()

    if (context.status === 'completed') {
      metrics.totalCompleted += 1
    } else if (context.status === 'error') {
      metrics.totalErrored += 1
    } else if (context.status === 'stopped') {
      metrics.totalStopped += 1
    } else if (context.status === 'stop_timeout') {
      metrics.totalStopTimeout += 1
    }
    if (context.status === 'stopped' || context.status === 'stop_timeout') {
      recordStopReason(context.stopReason || (context.status === 'stop_timeout' ? 'stop_timeout' : ''))
    }
    if (context.status === 'stop_timeout') {
      recordStopTimeoutPhase(context.stopTimeoutPhase)
    }

    stopHeartbeat(context)
    stopQueuedHeartbeat(context)
    stopStopProgressHeartbeat(context)

    if (context.stopTimeoutTimer) {
      clearTimeout(context.stopTimeoutTimer)
      context.stopTimeoutTimer = null
    }

    if (payload.event) {
      queueEvent(context, payload.event)
    }

    await flushEvents(context, true)
    await postStatus(context, {
      exitCode: payload.exitCode ?? context.child?.exitCode ?? null,
      signal: payload.signal ?? context.child?.signalCode ?? null,
      responseMessage: String(payload.responseMessage || '').trim(),
      errorMessage: String(payload.errorMessage || '').trim(),
      finishedAt: context.finishedAt,
      session: context.session,
    })

    activeRuns.delete(context.runId)
    dequeueRun(context.runId)
    drainQueuedRuns().catch((error) => {
      logger.error?.(error, 'runner queue drain failed')
    })
    return createRunSnapshot(context)
  }

  async function handleStreamCompletion(context, result = {}) {
    const completedThreadId = String(result?.threadId || '').trim()
    if (completedThreadId) {
      const nextSession = applyThreadIdentity(context.session, completedThreadId)
      if (nextSession !== context.session) {
        context.session = nextSession
        queueEvent(context, createSessionUpdatedEnvelopeEvent(context.session))
      }
    }

    if (context.stopRequestedAt) {
      await finalizeRun(context, 'stopped', {
        responseMessage: String(result?.message || '').trim(),
        stopReason: 'user_requested',
        stopStage: 'completed_after_stop',
        event: createStoppedEnvelopeEvent('执行已手动停止'),
      })
      return
    }

    await flushEvents(context, true)
    await finalizeRun(context, 'completed', {
      responseMessage: String(result?.message || '').trim(),
    })
  }

  async function handleStreamError(context, error) {
    const errorOutput = String(error?.output || '').trim()
    const errorMessage = [String(error?.message || '执行引擎运行失败。').trim(), errorOutput]
      .filter(Boolean)
      .join('\n\n')

    if (context.stopRequestedAt) {
      const stopReason = classifyStoppedErrorReason(context)
      await finalizeRun(context, 'stopped', {
        stopReason,
        stopStage: stopReason === 'user_requested'
          ? 'terminated_after_stop_signal'
          : 'errored_after_stop',
        event: createStoppedEnvelopeEvent('执行已手动停止'),
      })
      return
    }

    await finalizeRun(context, 'error', {
      errorMessage,
    })
  }

  async function executeRun(context) {
    let runner
    try {
      runner = resolveRunner(context.engine)
    } catch (error) {
      await finalizeRun(context, 'error', {
        errorMessage: error.message || '当前执行引擎不可用。',
      })
      return
    }

    queueEvent(context, createSessionEnvelopeEvent(context.session))

    try {
      const stream = runner.streamSessionPrompt(context.session, context.prompt, {
        onEvent(event) {
          queueEvent(context, event)
        },
        onThreadStarted(threadId) {
          const value = String(threadId || '').trim()
          if (!value) {
            return
          }

          context.session = applyThreadIdentity(context.session, value)
          queueEvent(context, createSessionUpdatedEnvelopeEvent(context.session))
        },
      })

      context.stream = stream
      context.child = stream.child || null
      context.pid = Number(stream.child?.pid || 0) || 0
      context.startedAt = nowIso()
      context.status = 'running'
      context.stopStage = context.stopRequestedAt ? 'stop_pending_before_stream_ready' : ''

      startHeartbeat(context)
      await postStatus(context, {
        startedAt: context.startedAt,
        session: context.session,
      })

      if (context.stopRequestedAt) {
        try {
          context.stopStage = 'cancel_signaled'
          stream.cancel({
            graceMs: context.stopGraceMs,
          })
        } catch (error) {
          context.stopStage = 'cancel_failed'
          context.stopCancelErrorMessage = String(error?.message || error || '').trim()
          // Ignore cancel failures here; stop timeout will handle the rest.
        }
      }

      const result = await stream.result
      await handleStreamCompletion(context, result)
    } catch (error) {
      await handleStreamError(context, error)
    }
  }

  async function startQueuedRun(context) {
    if (!context || context.finalized || !isQueuedRunStatus(context.status) || context.launching) {
      return false
    }

    context.launching = true
    dequeueRun(context.runId)
    stopQueuedHeartbeat(context)
    context.status = 'starting'
    metrics.totalStarted += 1
    await postStatus(context, {
      session: context.session,
    })
    executeRun(context).catch((error) => {
      logger.error?.(error, 'runner execute failed unexpectedly')
    }).finally(() => {
      context.launching = false
    })
    return true
  }

  async function drainQueuedRuns() {
    while (getRunningSlotCount() < runtimeConfig.maxConcurrentRuns) {
      const nextRunId = queuedRunIds[0]
      if (!nextRunId) {
        return
      }

      const nextContext = activeRuns.get(nextRunId)
      if (!nextContext || nextContext.finalized || !isQueuedRunStatus(nextContext.status)) {
        dequeueRun(nextRunId)
        continue
      }

      const started = await startQueuedRun(nextContext)
      if (!started) {
        dequeueRun(nextRunId)
      }
    }
  }

  function ensureStopTimeout(context, stopTimeoutMs) {
    if (context.stopTimeoutTimer) {
      return
    }

    context.stopTimeoutTimer = setTimeout(() => {
      const stopTimeoutPhase = classifyStopTimeoutPhase(context)
      finalizeRun(context, 'stop_timeout', {
        stopReason: 'stop_timeout',
        stopStage: 'stop_timeout',
        stopTimeoutPhase,
        errorMessage: '停止超时，runner 未能在限定时间内完成回收。',
      }).catch(() => {})
    }, stopTimeoutMs)
    context.stopTimeoutTimer.unref?.()
  }

  return {
    getRun(runId = '') {
      const context = activeRuns.get(String(runId || '').trim())
      return context ? createRunSnapshot(context) : null
    },
    getDiagnostics() {
      const runningRunCount = getRunningSlotCount()
      return {
        runnerId: RUNNER_ID,
        startedAt,
        activeRunCount: runningRunCount,
        runningRunCount,
        trackedRunCount: activeRuns.size,
        queuedRunCount: queuedRunIds.length,
        activeRuns: [...activeRuns.values()].map((context) => ({
          ...createRunSnapshot(context),
          cwd: String(context.session?.cwd || '').trim(),
          title: String(context.session?.title || '').trim(),
        })),
        queuedRuns: queuedRunIds
          .map((runId) => activeRuns.get(runId))
          .filter(Boolean)
          .map((context) => ({
            ...createRunSnapshot(context),
            cwd: String(context.session?.cwd || '').trim(),
            title: String(context.session?.title || '').trim(),
          })),
        metrics: {
          ...metrics,
          stopReasons: {
            ...metrics.stopReasons,
          },
          stopTimeoutPhases: {
            ...metrics.stopTimeoutPhases,
          },
        },
        config: {
          maxConcurrentRuns: runtimeConfig.maxConcurrentRuns,
          eventFlushIntervalMs,
          heartbeatIntervalMs,
          queuedHeartbeatIntervalMs,
          stoppingHeartbeatIntervalMs,
          idleProgressEventMs,
          idleProgressEventRepeatMs,
          defaultStopTimeoutMs,
        },
      }
    },
    async updateConfig(patch = {}) {
      const nextMaxConcurrentRuns = normalizeMaxConcurrentRuns(
        patch.maxConcurrentRuns,
        runtimeConfig.maxConcurrentRuns
      )

      runtimeConfig.maxConcurrentRuns = nextMaxConcurrentRuns
      await drainQueuedRuns()
      return this.getDiagnostics().config
    },
    async startRun(payload = {}) {
      const runId = String(payload.runId || '').trim()
      if (!runId) {
        throw new Error('缺少 runId')
      }

      const existing = activeRuns.get(runId)
      if (existing) {
        return createRunSnapshot(existing)
      }

      const session = normalizeSession(payload)
      if (!session.id || !session.cwd) {
        throw new Error('缺少 PromptX 项目上下文')
      }

      const context = {
        runId,
        taskSlug: String(payload.taskSlug || '').trim(),
        prompt: String(payload.prompt || '').trim(),
        promptBlocks: Array.isArray(payload.promptBlocks) ? payload.promptBlocks : [],
        engine: String(payload.engine || session.engine || 'codex').trim() || 'codex',
        session,
        status: 'queued',
        startedAt: '',
        finishedAt: '',
        stopRequestedAt: '',
        lastHeartbeatAt: '',
        lastProgressEventAt: Date.now(),
        lastIdleProgressEventAt: 0,
        lastSeq: 0,
        eventBuffer: [],
        flushTimer: null,
        flushing: false,
        heartbeatTimer: null,
        queueHeartbeatTimer: null,
        stopProgressTimer: null,
        stopTimeoutTimer: null,
        stopGraceMs: 0,
        stopReason: '',
        stopStage: '',
        stopTimeoutPhase: '',
        stopCancelErrorMessage: '',
        finalized: false,
        launching: false,
        child: null,
        stream: null,
        eventFlushFailureCount: 0,
        lastEventFlushFailureAt: '',
        lastEventFlushFailureMessage: '',
      }

      activeRuns.set(runId, context)
      enqueueRun(context)
      await postStatus(context, {
        session: context.session,
      })
      startQueuedHeartbeat(context)
      await drainQueuedRuns()
      return createRunSnapshot(context)
    },
    async stopRun(runId = '', options = {}) {
      const context = activeRuns.get(String(runId || '').trim())
      if (!context) {
        return null
      }

      if (context.finalized) {
        return createRunSnapshot(context)
      }

      if (context.stopRequestedAt) {
        return createRunSnapshot(context)
      }

      context.stopRequestedAt = nowIso()
      context.stopStage = 'stop_requested'

      if (isQueuedRunStatus(context.status)) {
        return finalizeRun(context, 'stopped', {
          stopReason: 'queued_cancelled',
          stopStage: 'cancelled_before_start',
          responseMessage: '执行在启动前已取消。',
          finishedAt: nowIso(),
          event: createStoppedEnvelopeEvent('执行在启动前已取消。'),
        })
      }

      context.status = 'stopping'
      await postStatus(context, {
        stopRequestedAt: context.stopRequestedAt,
      })
      startStopProgressHeartbeat(context)

      const stopGraceMs = Math.max(200, Number(options.forceAfterMs) || 1500)
      context.stopGraceMs = stopGraceMs
      const stopTimeoutMs = Math.max(defaultStopTimeoutMs, stopGraceMs + stopTimeoutBufferMs)
      ensureStopTimeout(context, stopTimeoutMs)

      try {
        context.stopStage = 'cancel_signaled'
        context.stream?.cancel?.({
          graceMs: stopGraceMs,
        })
      } catch (error) {
        context.stopStage = 'cancel_failed'
        context.stopCancelErrorMessage = String(error?.message || error || '').trim()
        // Ignore runner cancel failures and rely on timeout handling.
      }

      return createRunSnapshot(context)
    },
    async dispose() {
      await Promise.all(
        [...activeRuns.values()].map((context) =>
          this.stopRun(context.runId, { forceAfterMs: 1000 }).catch(() => null)
        )
      )

      const deadline = Date.now() + defaultStopTimeoutMs + stopTimeoutBufferMs
      while (activeRuns.size && Date.now() < deadline) {
        await sleep(DISPOSE_POLL_INTERVAL_MS)
      }

      if (activeRuns.size) {
        logger.warn?.({
          activeRunCount: activeRuns.size,
          runIds: [...activeRuns.keys()],
        }, 'runner dispose timed out before all active runs settled')
      }
    },
  }
}
