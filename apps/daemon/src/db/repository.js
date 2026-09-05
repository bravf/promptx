import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { DEFAULT_AGENT_TITLE } from '../agent/sessionTitle.js'

function parseJson(value, fallback = {}) {
  try {
    return JSON.parse(String(value || ''))
  } catch {
    return fallback
  }
}

function nowIso() {
  return new Date().toISOString()
}

function mapAgent(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    projectId: row.project_id,
    providerId: row.provider_id,
    title: row.title,
    lifecycle: row.lifecycle,
    modelId: row.model_id,
    modeId: row.mode_id,
    config: parseJson(row.config_json),
    capabilities: parseJson(row.capabilities_json),
    nativeHandle: parseJson(row.native_handle_json),
    timelineEpoch: row.timeline_epoch,
    timelineNextSeq: row.timeline_next_seq,
    lastError: row.last_error,
    requiresAttention: Boolean(row.requires_attention),
    attentionReason: row.attention_reason,
    attentionAt: row.attention_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at,
    archivedAt: row.archived_at,
  }
}

function mapTurn(row) {
  if (!row) return null
  return {
    id: row.id,
    agentSessionId: row.agent_session_id,
    taskId: row.task_id,
    clientMessageId: row.client_message_id,
    nativeTurnId: row.native_turn_id,
    status: row.status,
    errorMessage: row.error_message,
    usage: parseJson(row.usage_json),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }
}

function mapAsset(row) {
  if (!row) return null
  return {
    id: row.id,
    taskId: row.task_id,
    name: row.file_name,
    mimeType: row.mime_type,
    size: row.byte_size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  }
}

function mapTimelineRow(row) {
  if (!row) return null
  return {
    seq: row.seq,
    timestamp: row.timestamp,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
    item: parseJson(row.item_json, { type: 'error', code: 'invalid_timeline_item', message: 'Timeline 数据损坏。' }),
  }
}

export function normalizeDirectory(input) {
  const resolved = fs.realpathSync(path.resolve(String(input || '').trim()))
  if (!fs.statSync(resolved).isDirectory()) throw new Error('工作区路径不是目录。')
  const normalized = path.parse(resolved).root === resolved ? resolved : resolved.replace(/[\\/]+$/, '')
  return {
    cwd: normalized,
    pathKey: process.platform === 'win32' ? normalized.toLowerCase() : normalized,
  }
}


export function directoryKey(value) {
  const normalized = path.resolve(value)
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

const AGENT_SELECT = `SELECT a.*, t.project_id, t.title, t.last_active_at, t.archived_at,
  t.timeline_epoch, t.timeline_next_seq FROM agent_sessions a JOIN tasks t ON t.id = a.task_id`

function mapProject(row) {
  return row ? { id: row.id, repositoryRoot: row.repository_root, displayName: row.display_name,
    defaultBranch: row.default_branch, createdAt: row.created_at, updatedAt: row.updated_at, lastOpenedAt: row.last_opened_at } : null
}

function mapEnvironment(row) {
  return row ? { id: row.id, kind: row.kind, cwd: row.cwd, repositoryRoot: row.repository_root,
    branchName: row.branch_name, baseRef: row.base_ref, worktreePath: row.worktree_path,
    ownership: row.ownership, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at } : null
}

function mapTask(row) {
  return row ? { id: row.id, projectId: row.project_id, title: row.title, lifecycle: row.lifecycle,
    providerId: row.provider_id || '',
    environmentId: row.environment_id, createdAt: row.created_at, updatedAt: row.updated_at,
    lastActiveAt: row.last_active_at, archivedAt: row.archived_at } : null
}

export function createRepository(db) {
  const insertTimeline = db.transaction((taskId, turnId, item, options = {}) => {
    const task = db.prepare('SELECT timeline_next_seq FROM tasks WHERE id = ?').get(taskId)
    if (!task) throw new Error('会话不存在。')
    const seq = Number(task.timeline_next_seq)
    const timestamp = options.timestamp || nowIso()
    db.prepare(`INSERT INTO agent_timeline_rows
      (task_id, seq, timestamp, turn_id, provider_message_id, item_type, item_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(taskId, seq, timestamp, turnId || null, options.providerMessageId || null, item.type, JSON.stringify(item))
    db.prepare('UPDATE tasks SET timeline_next_seq = ?, updated_at = ?, last_active_at = ? WHERE id = ?')
      .run(seq + 1, timestamp, timestamp, taskId)
    return { seq, timestamp, ...(turnId ? { turnId } : {}), ...(options.providerMessageId ? { providerMessageId: options.providerMessageId } : {}), item }
  })
  const applyTimelineSync = db.transaction((taskId, input) => {
    const agent = db.prepare('SELECT timeline_epoch, timeline_next_seq FROM tasks WHERE id = ?').get(taskId)
    if (!agent) throw new Error('Agent 不存在。')
    if (input.expectedNextSeq !== undefined && Number(agent.timeline_next_seq) !== input.expectedNextSeq) {
      const error = new Error('Timeline 在同步期间发生变化，需要重新对账。')
      error.code = 'TIMELINE_SYNC_STALE'
      throw error
    }
    const previousSync = db.prepare(
      'SELECT manifest_json FROM agent_timeline_sync_state WHERE task_id = ?',
    ).get(taskId)
    const previousManifest = parseJson(previousSync?.manifest_json, { turns: [] })

    const turnIds = new Map()
    for (const turn of input.turns || []) {
      let current = turn.localTurnId
        ? mapTurn(db.prepare('SELECT * FROM agent_turns WHERE id = ? AND task_id = ?').get(turn.localTurnId, taskId))
        : null
      if (!current) current = mapTurn(db.prepare(
        'SELECT * FROM agent_turns WHERE task_id = ? AND native_turn_id = ?',
      ).get(taskId, turn.sourceTurnId))
      if (!current && turn.clientMessageId) {
        current = mapTurn(db.prepare(
          'SELECT * FROM agent_turns WHERE task_id = ? AND client_message_id = ?',
        ).get(taskId, turn.clientMessageId))
      }
      if (!current) {
        const id = randomUUID()
        db.prepare(`INSERT INTO agent_turns
          (id, task_id, agent_session_id, client_message_id, native_turn_id, status, error_message,
           usage_json, created_at, started_at, finished_at)
          VALUES (?, ?, (SELECT id FROM agent_sessions WHERE task_id = ?), ?, ?, ?, ?, '{}', ?, ?, ?)`).run(
          id,
          taskId,
          taskId,
          turn.clientMessageId || `provider:${input.providerId}:${turn.sourceTurnId}`,
          turn.sourceTurnId,
          turn.status || 'completed',
          turn.errorMessage || '',
          turn.startedAt || turn.finishedAt || nowIso(),
          turn.startedAt || null,
          turn.finishedAt || null,
        )
        current = mapTurn(db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(id))
      } else {
        db.prepare(`UPDATE agent_turns SET native_turn_id = ?, status = ?, error_message = ?,
          started_at = COALESCE(?, started_at), finished_at = COALESCE(?, finished_at)
          WHERE id = ?`).run(
          turn.sourceTurnId,
          turn.status || current.status,
          turn.errorMessage || '',
          turn.startedAt || null,
          turn.finishedAt || null,
          current.id,
        )
      }
      turnIds.set(turn.sourceTurnId, current.id)
    }

    let epoch = agent.timeline_epoch
    let nextSeq = Number(agent.timeline_next_seq)
    if (input.mode === 'replace') {
      db.prepare('DELETE FROM agent_timeline_rows WHERE task_id = ?').run(taskId)
      const nextSourceTurnIds = new Set((input.turns || []).map((turn) => turn.sourceTurnId))
      for (const previous of previousManifest.turns || []) {
        if (!previous.sourceTurnId || nextSourceTurnIds.has(previous.sourceTurnId)) continue
        db.prepare(`DELETE FROM agent_turns WHERE task_id = ? AND native_turn_id = ?
          AND status NOT IN ('queued', 'running')`).run(taskId, previous.sourceTurnId)
      }
      epoch = randomUUID()
      nextSeq = 1
    }

    const inserted = []
    for (const entry of input.rows || []) {
      const turnId = entry.localTurnId || turnIds.get(entry.sourceTurnId) || null
      if (entry.providerMessageId) {
        const existing = db.prepare(`SELECT seq FROM agent_timeline_rows
          WHERE task_id = ? AND provider_message_id = ?`).get(taskId, entry.providerMessageId)
        if (existing) continue
      }
      const timestamp = entry.timestamp || nowIso()
      db.prepare(`INSERT INTO agent_timeline_rows
        (task_id, seq, timestamp, turn_id, provider_message_id, item_type, item_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        taskId,
        nextSeq,
        timestamp,
        turnId,
        entry.providerMessageId || null,
        entry.item.type,
        JSON.stringify(entry.item),
      )
      inserted.push({
        seq: nextSeq,
        timestamp,
        ...(turnId ? { turnId } : {}),
        ...(entry.providerMessageId ? { providerMessageId: entry.providerMessageId } : {}),
        item: entry.item,
      })
      nextSeq += 1
    }

    const syncedAt = nowIso()
    db.prepare(`INSERT INTO agent_timeline_sync_state
      (task_id, provider_id, source_id, manifest_json, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET provider_id = excluded.provider_id,
        source_id = excluded.source_id, manifest_json = excluded.manifest_json,
        synced_at = excluded.synced_at`).run(
      taskId,
      input.providerId,
      input.sourceId,
      JSON.stringify(input.manifest || {}),
      syncedAt,
    )
    db.prepare(`UPDATE tasks SET timeline_epoch = ?, timeline_next_seq = ?,
      updated_at = ?, last_active_at = ? WHERE id = ?`).run(epoch, nextSeq, syncedAt, syncedAt, taskId)
    return { mode: input.mode, epoch, rows: inserted, syncedAt }
  })

  return {
    transaction(callback) { return db.transaction(callback)() },
    listProjects() {
      return db.prepare('SELECT * FROM projects ORDER BY last_opened_at DESC').all().map(mapProject)
    },
    getProject(id) { return mapProject(db.prepare('SELECT * FROM projects WHERE id = ?').get(id)) },
    getProjectByRoot(root) { return mapProject(db.prepare('SELECT * FROM projects WHERE path_key = ?').get(directoryKey(root))) },
    createProject(input) {
      const id = randomUUID()
      const now = nowIso()
      const root = path.resolve(input.repositoryRoot)
      db.prepare(`INSERT INTO projects
        (id, repository_root, path_key, display_name, default_branch, created_at, updated_at, last_opened_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(path_key) DO UPDATE SET last_opened_at = excluded.last_opened_at`)
        .run(id, root, directoryKey(root), input.displayName || path.basename(root) || root, input.defaultBranch || '', now, now, now)
      return this.getProjectByRoot(root)
    },
    updateProject(id, input = {}) {
      const current = this.getProject(id)
      if (!current) return null
      const now = nowIso()
      db.prepare('UPDATE projects SET display_name = ?, default_branch = ?, updated_at = ?, last_opened_at = ? WHERE id = ?')
        .run(input.displayName ?? current.displayName, input.defaultBranch ?? current.defaultBranch, now, now, id)
      return this.getProject(id)
    },
    deleteProject(id) { return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0 },
    createEnvironment(input) {
      const id = input.id || randomUUID()
      const now = nowIso()
      db.prepare(`INSERT INTO execution_environments
        (id, kind, cwd, path_key, repository_root, branch_name, base_ref, worktree_path, ownership, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, input.kind || 'local', input.cwd, directoryKey(input.cwd), input.repositoryRoot,
          input.branchName || '', input.baseRef || '', input.worktreePath || null, input.ownership || 'external', input.status || 'ready', now, now)
      return this.getEnvironment(id)
    },
    getEnvironment(id) { return mapEnvironment(db.prepare('SELECT * FROM execution_environments WHERE id = ?').get(id)) },
    listEnvironments() { return db.prepare('SELECT * FROM execution_environments').all().map(mapEnvironment) },
    updateEnvironment(id, patch = {}) {
      const current = this.getEnvironment(id)
      if (!current) return null
      db.prepare('UPDATE execution_environments SET status = ?, updated_at = ? WHERE id = ?')
        .run(patch.status ?? current.status, nowIso(), id)
      return this.getEnvironment(id)
    },
    rebindEnvironment(id, input) {
      const current = this.getEnvironment(id)
      if (!current) return null
      db.prepare(`UPDATE execution_environments SET cwd = ?, path_key = ?, repository_root = ?, kind = ?,
        worktree_path = ?, branch_name = ?, base_ref = ?, ownership = ?, status = ?, updated_at = ? WHERE id = ?`)
        .run(input.cwd, directoryKey(input.cwd), input.repositoryRoot || current.repositoryRoot, input.kind || 'local',
          input.worktreePath || null, input.branchName || '', input.baseRef || '', input.ownership || 'external', input.status || 'ready', nowIso(), id)
      return this.getEnvironment(id)
    },
    deleteEnvironment(id) { return db.prepare('DELETE FROM execution_environments WHERE id = ?').run(id).changes > 0 },
    createTask(input) {
      const id = randomUUID()
      const now = nowIso()
      db.prepare(`INSERT INTO tasks
        (id, project_id, environment_id, title, lifecycle, timeline_epoch, created_at, updated_at, last_active_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?)`)
        .run(id, input.projectId, input.environmentId, input.title || DEFAULT_AGENT_TITLE, randomUUID(), now, now, now)
      return this.getTask(id)
    },
    getTask(id) {
      return mapTask(db.prepare(`SELECT t.*, a.provider_id FROM tasks t
        LEFT JOIN agent_sessions a ON a.task_id = t.id WHERE t.id = ?`).get(id))
    },
    listTasks(projectId, includeArchived = false) {
      return db.prepare(`SELECT t.*, a.provider_id FROM tasks t LEFT JOIN agent_sessions a ON a.task_id = t.id
        WHERE t.project_id = ? ${includeArchived ? '' : 'AND t.archived_at IS NULL'}
        ORDER BY last_active_at DESC`).all(projectId).map(mapTask)
    },
    updateTask(id, patch = {}) {
      const task = this.getTask(id)
      if (!task) return null
      db.prepare('UPDATE tasks SET title = ?, last_active_at = ?, updated_at = ? WHERE id = ?')
        .run(patch.title ?? task.title, patch.lastActiveAt ?? task.lastActiveAt, nowIso(), id)
      return this.getTask(id)
    },
    archiveTask(id) {
      const now = nowIso()
      db.prepare("UPDATE tasks SET lifecycle = 'archived', archived_at = ?, updated_at = ? WHERE id = ?").run(now, now, id)
      return this.getTask(id)
    },
    deleteTask(id) { return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0 },
    createAsset(taskId, input) {
      const id = input.id || randomUUID()
      db.prepare(`INSERT INTO task_assets (id, task_id, file_name, mime_type, byte_size, sha256, storage_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, taskId, input.name, input.mimeType, input.size, input.sha256, input.storagePath, input.createdAt || nowIso())
      return this.getAsset(id)
    },
    getAsset(id) { return mapAsset(db.prepare('SELECT * FROM task_assets WHERE id = ?').get(id)) },
    listTaskAssets(taskId) {
      return db.prepare('SELECT * FROM task_assets WHERE task_id = ? ORDER BY created_at DESC').all(taskId).map(mapAsset)
    },
    listAllAgents(includeArchived = false) {
      return db.prepare(`${AGENT_SELECT} ${includeArchived ? '' : 'WHERE t.archived_at IS NULL'} ORDER BY t.last_active_at DESC`).all().map(mapAgent)
    },
    getAgent(id) { return mapAgent(db.prepare(`${AGENT_SELECT} WHERE a.id = ?`).get(id)) },
    getTaskAgent(taskId) { return mapAgent(db.prepare(`${AGENT_SELECT} WHERE a.task_id = ?`).get(taskId)) },
    createAgent(taskId, input, capabilities = {}) {
      const id = randomUUID()
      const now = nowIso()
      const handle = input.nativeHandle || {}
      db.prepare(`INSERT INTO agent_sessions
        (id, task_id, provider_id, lifecycle, model_id, mode_id, config_json, capabilities_json,
         native_handle_json, native_source_id, created_at, updated_at)
        VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, taskId, input.providerId, input.modelId || '', input.modeId || '', JSON.stringify(input.providerConfig || {}),
          JSON.stringify(capabilities), JSON.stringify(handle), handle.threadId || handle.sessionId || null, now, now)
      return this.getAgent(id)
    },
    findAgentByProviderHandle(providerId, handle = {}) {
      const source = providerId === 'codex' ? handle.threadId : handle.sessionId
      return source ? mapAgent(db.prepare(`${AGENT_SELECT} WHERE a.provider_id = ? AND a.native_source_id = ?`).get(providerId, source)) : null
    },
    updateAgent(id, patch = {}) {
      const current = this.getAgent(id)
      if (!current) return null
      const next = { ...current, ...patch, updatedAt: nowIso() }
      db.prepare(`UPDATE agent_sessions SET lifecycle = ?, model_id = ?, mode_id = ?, config_json = ?,
        capabilities_json = ?, native_handle_json = ?, native_source_id = ?, last_error = ?, updated_at = ?,
        requires_attention = ?, attention_reason = ?, attention_at = ? WHERE id = ?`)
        .run(next.lifecycle, next.modelId, next.modeId, JSON.stringify(next.config || {}), JSON.stringify(next.capabilities || {}),
          JSON.stringify(next.nativeHandle || {}), next.nativeHandle?.threadId || next.nativeHandle?.sessionId || null,
          next.lastError || '', next.updatedAt, next.requiresAttention ? 1 : 0, next.attentionReason || null, next.attentionAt || null, id)
      return this.getAgent(id)
    },
    clearAgentAttention(id) {
      return this.updateAgent(id, { requiresAttention: false, attentionReason: null, attentionAt: null })
    },
    getTurn(id) { return mapTurn(db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(id)) },
    getTurnByClientMessage(taskId, clientMessageId) {
      return mapTurn(db.prepare('SELECT * FROM agent_turns WHERE task_id = ? AND client_message_id = ?').get(taskId, clientMessageId))
    },
    hasTurns(taskId) { return Boolean(db.prepare('SELECT 1 FROM agent_turns WHERE task_id = ? LIMIT 1').get(taskId)) },
    listTurns(taskId, limit = 100) {
      return db.prepare('SELECT * FROM agent_turns WHERE task_id = ? ORDER BY created_at DESC LIMIT ?').all(taskId, limit).map(mapTurn)
    },
    createTurn(taskId, clientMessageId) {
      const existing = this.getTurnByClientMessage(taskId, clientMessageId)
      if (existing) return existing
      const id = randomUUID()
      db.prepare(`INSERT INTO agent_turns (id, task_id, agent_session_id, client_message_id, status, created_at)
        VALUES (?, ?, (SELECT id FROM agent_sessions WHERE task_id = ?), ?, 'queued', ?)`)
        .run(id, taskId, taskId, clientMessageId, nowIso())
      return this.getTurn(id)
    },
    updateTurn(id, patch = {}) {
      const current = this.getTurn(id)
      if (!current) return null
      const next = { ...current, ...patch }
      db.prepare(`UPDATE agent_turns SET native_turn_id = ?, status = ?, error_message = ?,
        usage_json = ?, started_at = ?, finished_at = ? WHERE id = ?`)
        .run(next.nativeTurnId || '', next.status, next.errorMessage || '', JSON.stringify(next.usage || {}),
          next.startedAt || null, next.finishedAt || null, id)
      return this.getTurn(id)
    },
    failActiveTurnsOnStartup() {
      const now = nowIso()
      db.prepare(`UPDATE agent_sessions SET lifecycle = 'ready', updated_at = ?, requires_attention = 1,
        attention_reason = 'error', attention_at = ? WHERE task_id IN
        (SELECT task_id FROM agent_turns WHERE status IN ('queued', 'running')) OR lifecycle IN ('running', 'stopping')`).run(now, now)
      db.prepare(`UPDATE agent_turns SET status = 'failed', error_message = 'daemon_restarted', finished_at = ?
        WHERE status IN ('queued', 'running')`).run(now)
    },
    appendTimeline(taskId, turnId, item, options) { return insertTimeline(taskId, turnId, item, options) },
    getTimelineSyncState(taskId) {
      const row = db.prepare('SELECT * FROM agent_timeline_sync_state WHERE task_id = ?').get(taskId)
      return row ? { providerId: row.provider_id, sourceId: row.source_id, manifest: parseJson(row.manifest_json), syncedAt: row.synced_at } : null
    },
    applyTimelineSync(taskId, input) { return applyTimelineSync(taskId, input) },
    getTimelineState(taskId) {
      const row = db.prepare('SELECT timeline_epoch, timeline_next_seq FROM tasks WHERE id = ?').get(taskId)
      return row ? { epoch: row.timeline_epoch, nextSeq: row.timeline_next_seq } : null
    },
    getTimelineBounds(taskId) {
      const row = db.prepare(`SELECT COUNT(*) AS row_count, MIN(seq) AS min_seq, MAX(seq) AS max_seq
        FROM agent_timeline_rows WHERE task_id = ?`).get(taskId)
      return { count: Number(row.row_count), minSeq: Number(row.min_seq || 0), maxSeq: Number(row.max_seq || 0) }
    },
    listTimelineWindow(taskId, { direction = 'tail', seq = 0, limit = 200 } = {}) {
      const safeLimit = Math.max(1, Number(limit) || 200)
      if (direction === 'after') {
        return db.prepare('SELECT * FROM agent_timeline_rows WHERE task_id = ? AND seq > ? ORDER BY seq LIMIT ?')
          .all(taskId, seq, safeLimit).map(mapTimelineRow)
      }
      const rows = direction === 'before'
        ? db.prepare('SELECT * FROM agent_timeline_rows WHERE task_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?').all(taskId, seq, safeLimit)
        : db.prepare('SELECT * FROM agent_timeline_rows WHERE task_id = ? ORDER BY seq DESC LIMIT ?').all(taskId, safeLimit)
      return rows.reverse().map(mapTimelineRow)
    },
    listTimelineRows(taskId) {
      return db.prepare('SELECT * FROM agent_timeline_rows WHERE task_id = ? ORDER BY seq').all(taskId).map(mapTimelineRow)
    },
  }
}
