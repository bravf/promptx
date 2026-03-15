import { nanoid } from 'nanoid'
import { all, get, run, transaction } from './db.js'
import { getPromptxCodexSessionById } from './codexSessions.js'
import { getTaskBySlug, updateTaskCodexSession } from './repository.js'

const TERMINAL_RUN_STATUSES = new Set(['completed', 'error', 'stopped', 'interrupted'])

function parseEventPayload(rawValue = '{}') {
  try {
    return JSON.parse(rawValue || '{}')
  } catch {
    return {}
  }
}

function toCodexRunEvent(row) {
  return {
    id: Number(row.id),
    seq: Number(row.seq),
    eventType: String(row.event_type || '').trim() || 'event',
    payload: parseEventPayload(row.payload_json),
    createdAt: row.created_at,
  }
}

function toCodexRun(row, events = []) {
  if (!row) {
    return null
  }

  return {
    id: row.id,
    taskSlug: row.task_slug,
    sessionId: row.session_id,
    prompt: row.prompt || '',
    status: row.status || 'running',
    responseMessage: row.response_message || '',
    errorMessage: row.error_message || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    startedAt: row.started_at || row.created_at,
    finishedAt: row.finished_at || '',
    completed: TERMINAL_RUN_STATUSES.has(String(row.status || '')),
    events,
  }
}

function loadEventsForRunIds(runIds = [], afterSeq = 0) {
  if (!runIds.length) {
    return new Map()
  }

  const placeholders = runIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT id, run_id, seq, event_type, payload_json, created_at
     FROM codex_run_events
     WHERE run_id IN (${placeholders})
       AND seq > ?
     ORDER BY run_id ASC, seq ASC, id ASC`,
    [...runIds, Math.max(0, Number(afterSeq) || 0)]
  )

  const grouped = new Map()
  rows.forEach((row) => {
    const runId = row.run_id
    if (!grouped.has(runId)) {
      grouped.set(runId, [])
    }
    grouped.get(runId).push(toCodexRunEvent(row))
  })

  return grouped
}

function getTaskRowBySlug(slug) {
  const targetSlug = String(slug || '').trim()
  if (!targetSlug) {
    return null
  }

  return get(
    `SELECT id, slug
     FROM tasks
     WHERE slug = ?`,
    [targetSlug]
  )
}

function getRunRowById(runId) {
  const targetId = String(runId || '').trim()
  if (!targetId) {
    return null
  }

  return get(
    `SELECT id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE id = ?`,
    [targetId]
  )
}

export function isTerminalRunStatus(status = '') {
  return TERMINAL_RUN_STATUSES.has(String(status || '').trim())
}

export function getCodexRunById(runId, options = {}) {
  const row = getRunRowById(runId)
  if (!row) {
    return null
  }

  if (!options.withEvents) {
    return toCodexRun(row)
  }

  const events = loadEventsForRunIds([row.id]).get(row.id) || []
  return toCodexRun(row, events)
}

export function listTaskCodexRuns(taskSlug, limit = 20) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return null
  }

  const rows = all(
    `SELECT id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE task_slug = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [task.slug, Math.max(1, Number(limit) || 20)]
  )

  const eventsByRunId = loadEventsForRunIds(rows.map((row) => row.id))
  return rows.map((row) => toCodexRun(row, eventsByRunId.get(row.id) || []))
}

export function listCodexRunEvents(runId, options = {}) {
  const targetRun = getRunRowById(runId)
  if (!targetRun) {
    return null
  }

  const afterSeq = Math.max(0, Number(options.afterSeq) || 0)
  const limit = Math.max(1, Number(options.limit) || 500)
  const rows = all(
    `SELECT id, run_id, seq, event_type, payload_json, created_at
     FROM codex_run_events
     WHERE run_id = ?
       AND seq > ?
     ORDER BY seq ASC, id ASC
     LIMIT ?`,
    [targetRun.id, afterSeq, limit]
  )

  return rows.map(toCodexRunEvent)
}

export function createCodexRun(input = {}) {
  const taskSlug = String(input.taskSlug || '').trim()
  const sessionId = String(input.sessionId || '').trim()
  const prompt = String(input.prompt || '').trim()

  if (!taskSlug) {
    throw new Error('缺少任务。')
  }
  if (!sessionId) {
    throw new Error('请先选择 PromptX 会话。')
  }
  if (!prompt) {
    throw new Error('没有可发送的提示词。')
  }

  const task = getTaskBySlug(taskSlug)
  if (!task || task.expired) {
    throw new Error('任务不存在。')
  }

  const session = getPromptxCodexSessionById(sessionId)
  if (!session) {
    throw new Error('没有找到对应的 PromptX 会话。')
  }

  const now = new Date().toISOString()
  const runId = `pxcr_${nanoid(12)}`

  transaction(() => {
    run(
      `INSERT INTO codex_runs (
         id, task_slug, session_id, prompt, status,
         response_message, error_message, created_at, updated_at, started_at, finished_at
       )
       VALUES (?, ?, ?, ?, 'running', '', '', ?, ?, ?, NULL)`,
      [runId, task.slug, session.id, prompt, now, now, now]
    )
  })

  updateTaskCodexSession(task.slug, session.id)

  return getCodexRunById(runId, { withEvents: true })
}

export function appendCodexRunEvent(runId, payloadOrSeq = {}, maybeSeqOrPayload = 1) {
  const targetRun = getRunRowById(runId)
  if (!targetRun) {
    return null
  }

  const seqFirst = typeof payloadOrSeq === 'number'
  const seq = Math.max(1, Number(seqFirst ? payloadOrSeq : maybeSeqOrPayload) || 1)
  const rawPayload = seqFirst ? maybeSeqOrPayload : payloadOrSeq
  const normalizedPayload = rawPayload && typeof rawPayload === 'object'
    ? rawPayload
    : { type: 'info', message: String(rawPayload || '') }
  const now = new Date().toISOString()
  const eventType = String(normalizedPayload.type || '').trim() || 'event'

  transaction(() => {
    run(
      `INSERT INTO codex_run_events (run_id, seq, event_type, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [targetRun.id, seq, eventType, JSON.stringify(normalizedPayload), now]
    )
  })

  return {
    id: Number(
      get(
        `SELECT id
         FROM codex_run_events
         WHERE run_id = ? AND seq = ?`,
        [targetRun.id, seq]
      )?.id || 0
    ),
    seq,
    eventType,
    payload: normalizedPayload,
    createdAt: now,
  }
}

export function updateCodexRun(runId, patch = {}) {
  const existing = getRunRowById(runId)
  if (!existing) {
    return null
  }

  const status = String(patch.status || existing.status || 'running').trim() || 'running'
  const responseMessage = Object.prototype.hasOwnProperty.call(patch, 'responseMessage')
    ? String(patch.responseMessage || '')
    : String(existing.response_message || '')
  const errorMessage = Object.prototype.hasOwnProperty.call(patch, 'errorMessage')
    ? String(patch.errorMessage || '')
    : String(existing.error_message || '')
  const finishedAt = Object.prototype.hasOwnProperty.call(patch, 'finishedAt')
    ? String(patch.finishedAt || '')
    : String(existing.finished_at || '')
  const updatedAt = patch.updatedAt || new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_runs
       SET status = ?, response_message = ?, error_message = ?, finished_at = ?, updated_at = ?
       WHERE id = ?`,
      [status, responseMessage, errorMessage, finishedAt || null, updatedAt, existing.id]
    )
  })

  return getCodexRunById(existing.id, { withEvents: true })
}

export function listRunningCodexSessionIds() {
  return all(
    `SELECT DISTINCT session_id
     FROM codex_runs
     WHERE status = 'running'`
  ).map((row) => String(row.session_id || '').trim()).filter(Boolean)
}

export function listRunningCodexTaskSlugs() {
  return all(
    `SELECT DISTINCT task_slug
     FROM codex_runs
     WHERE status = 'running'`
  ).map((row) => String(row.task_slug || '').trim()).filter(Boolean)
}

export function getRunningCodexRunBySessionId(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  const row = get(
    `SELECT id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE session_id = ?
       AND status = 'running'
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetId]
  )

  return toCodexRun(row)
}

export function getRunningCodexRunByTaskSlug(taskSlug) {
  const targetSlug = String(taskSlug || '').trim()
  if (!targetSlug) {
    return null
  }

  const row = get(
    `SELECT id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at
     FROM codex_runs
     WHERE task_slug = ?
       AND status = 'running'
     ORDER BY created_at DESC
     LIMIT 1`,
    [targetSlug]
  )

  return toCodexRun(row)
}

export function hasRunningCodexRunsForTask(taskSlug) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return false
  }

  return Boolean(
    get(
      `SELECT 1
       FROM codex_runs
       WHERE task_slug = ?
         AND status = 'running'
       LIMIT 1`,
      [task.slug]
    )
  )
}

export function deleteTaskCodexRuns(taskSlug) {
  const task = getTaskRowBySlug(taskSlug)
  if (!task) {
    return { error: 'not_found' }
  }

  transaction(() => {
    run('DELETE FROM codex_runs WHERE task_slug = ?', [task.slug])
  })

  return { ok: true }
}

export function markRunningCodexRunsInterrupted(message = '服务已重启，之前的执行已中断。') {
  const runningRuns = all(
    `SELECT id
     FROM codex_runs
     WHERE status = 'running'
     ORDER BY created_at ASC`
  )

  runningRuns.forEach((row) => {
    const existingEvents = listCodexRunEvents(row.id) || []
    const nextSeq = existingEvents.length
      ? Math.max(...existingEvents.map((item) => Number(item.seq) || 0)) + 1
      : 1

    appendCodexRunEvent(row.id, {
      type: 'interrupted',
      message,
    }, nextSeq)

    updateCodexRun(row.id, {
      status: 'interrupted',
      errorMessage: message,
      finishedAt: new Date().toISOString(),
    })
  })

  return runningRuns.length
}

export function markInterruptedCodexRuns(message) {
  return markRunningCodexRunsInterrupted(message)
}
