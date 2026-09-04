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

function mapWorkspace(row) {
  if (!row) return null
  return {
    id: row.id,
    cwd: row.cwd,
    title: row.title,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
  }
}

function mapAgent(row) {
  if (!row) return null
  return {
    id: row.id,
    workspaceId: row.workspace_id,
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
    workspaceId: row.workspace_id,
    name: row.file_name,
    mimeType: row.mime_type,
    size: row.byte_size,
    sha256: row.sha256,
    storagePath: row.storage_path,
    createdAt: row.created_at,
  }
}

export function normalizeWorkspacePath(input) {
  const resolved = fs.realpathSync(path.resolve(String(input || '').trim()))
  if (!fs.statSync(resolved).isDirectory()) throw new Error('工作区路径不是目录。')
  const normalized = path.parse(resolved).root === resolved ? resolved : resolved.replace(/[\\/]+$/, '')
  return {
    cwd: normalized,
    pathKey: process.platform === 'win32' ? normalized.toLowerCase() : normalized,
  }
}

export function createRepository(db) {
  const insertTimeline = db.transaction((agentId, turnId, item, options = {}) => {
    const agent = db.prepare('SELECT timeline_next_seq FROM agent_sessions WHERE id = ?').get(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    const seq = Number(agent.timeline_next_seq)
    const timestamp = options.timestamp || nowIso()
    db.prepare(`INSERT INTO agent_timeline_rows
      (agent_session_id, seq, timestamp, turn_id, provider_message_id, item_type, item_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(agentId, seq, timestamp, turnId || null, options.providerMessageId || null, item.type, JSON.stringify(item))
    db.prepare('UPDATE agent_sessions SET timeline_next_seq = ?, updated_at = ?, last_active_at = ? WHERE id = ?')
      .run(seq + 1, timestamp, timestamp, agentId)
    return { seq, timestamp, ...(turnId ? { turnId } : {}), ...(options.providerMessageId ? { providerMessageId: options.providerMessageId } : {}), item }
  })

  const applyTimelineSync = db.transaction((agentId, input) => {
    const agent = db.prepare('SELECT timeline_epoch, timeline_next_seq FROM agent_sessions WHERE id = ?').get(agentId)
    if (!agent) throw new Error('Agent 不存在。')
    if (input.expectedNextSeq !== undefined && Number(agent.timeline_next_seq) !== input.expectedNextSeq) {
      const error = new Error('Timeline 在同步期间发生变化，需要重新对账。')
      error.code = 'TIMELINE_SYNC_STALE'
      throw error
    }
    const previousSync = db.prepare(
      'SELECT manifest_json FROM agent_timeline_sync_state WHERE agent_session_id = ?',
    ).get(agentId)
    const previousManifest = parseJson(previousSync?.manifest_json, { turns: [] })

    const turnIds = new Map()
    for (const turn of input.turns || []) {
      let current = turn.localTurnId
        ? mapTurn(db.prepare('SELECT * FROM agent_turns WHERE id = ? AND agent_session_id = ?').get(turn.localTurnId, agentId))
        : null
      if (!current) current = mapTurn(db.prepare(
        'SELECT * FROM agent_turns WHERE agent_session_id = ? AND native_turn_id = ?',
      ).get(agentId, turn.sourceTurnId))
      if (!current && turn.clientMessageId) {
        current = mapTurn(db.prepare(
          'SELECT * FROM agent_turns WHERE agent_session_id = ? AND client_message_id = ?',
        ).get(agentId, turn.clientMessageId))
      }
      if (!current) {
        const id = randomUUID()
        db.prepare(`INSERT INTO agent_turns
          (id, agent_session_id, client_message_id, native_turn_id, status, error_message,
           usage_json, created_at, started_at, finished_at)
          VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`).run(
          id,
          agentId,
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
      db.prepare('DELETE FROM agent_timeline_rows WHERE agent_session_id = ?').run(agentId)
      const nextSourceTurnIds = new Set((input.turns || []).map((turn) => turn.sourceTurnId))
      for (const previous of previousManifest.turns || []) {
        if (!previous.sourceTurnId || nextSourceTurnIds.has(previous.sourceTurnId)) continue
        db.prepare(`DELETE FROM agent_turns WHERE agent_session_id = ? AND native_turn_id = ?
          AND status NOT IN ('queued', 'running')`).run(agentId, previous.sourceTurnId)
      }
      epoch = randomUUID()
      nextSeq = 1
    }

    const inserted = []
    for (const entry of input.rows || []) {
      const turnId = entry.localTurnId || turnIds.get(entry.sourceTurnId) || null
      if (entry.providerMessageId) {
        const existing = db.prepare(`SELECT seq FROM agent_timeline_rows
          WHERE agent_session_id = ? AND provider_message_id = ?`).get(agentId, entry.providerMessageId)
        if (existing) continue
      }
      const timestamp = entry.timestamp || nowIso()
      db.prepare(`INSERT INTO agent_timeline_rows
        (agent_session_id, seq, timestamp, turn_id, provider_message_id, item_type, item_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
        agentId,
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
      (agent_session_id, provider_id, source_id, manifest_json, synced_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(agent_session_id) DO UPDATE SET provider_id = excluded.provider_id,
        source_id = excluded.source_id, manifest_json = excluded.manifest_json,
        synced_at = excluded.synced_at`).run(
      agentId,
      input.providerId,
      input.sourceId,
      JSON.stringify(input.manifest || {}),
      syncedAt,
    )
    db.prepare(`UPDATE agent_sessions SET timeline_epoch = ?, timeline_next_seq = ?,
      updated_at = ?, last_active_at = ? WHERE id = ?`).run(epoch, nextSeq, syncedAt, syncedAt, agentId)
    return { mode: input.mode, epoch, rows: inserted, syncedAt }
  })

  return {
    listWorkspaces() {
      return db.prepare('SELECT * FROM workspaces ORDER BY sort_order ASC, last_opened_at DESC').all().map(mapWorkspace)
    },
    getWorkspace(id) {
      return mapWorkspace(db.prepare('SELECT * FROM workspaces WHERE id = ?').get(id))
    },
    createWorkspace(input) {
      const { cwd, pathKey } = normalizeWorkspacePath(input.cwd)
      const existing = mapWorkspace(db.prepare('SELECT * FROM workspaces WHERE path_key = ?').get(pathKey))
      if (existing) return existing
      const id = randomUUID()
      const now = nowIso()
      const title = String(input.title || path.basename(cwd) || cwd).trim()
      db.prepare(`INSERT INTO workspaces
        (id, cwd, path_key, title, sort_order, created_at, updated_at, last_opened_at)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?)`)
        .run(id, cwd, pathKey, title, now, now, now)
      return this.getWorkspace(id)
    },
    updateWorkspace(id, input) {
      const now = nowIso()
      db.prepare('UPDATE workspaces SET title = ?, updated_at = ? WHERE id = ?').run(input.title, now, id)
      return this.getWorkspace(id)
    },
    deleteWorkspace(id) {
      return db.prepare('DELETE FROM workspaces WHERE id = ?').run(id).changes > 0
    },
    createAsset(workspaceId, input) {
      const id = input.id || randomUUID()
      const createdAt = input.createdAt || nowIso()
      db.prepare(`INSERT INTO workspace_assets
        (id, workspace_id, file_name, mime_type, byte_size, sha256, storage_path, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, workspaceId, input.name, input.mimeType, input.size, input.sha256, input.storagePath, createdAt)
      return this.getAsset(id)
    },
    getAsset(id) {
      return mapAsset(db.prepare('SELECT * FROM workspace_assets WHERE id = ?').get(id))
    },
    listWorkspaceAssets(workspaceId) {
      return db.prepare('SELECT * FROM workspace_assets WHERE workspace_id = ? ORDER BY created_at DESC')
        .all(workspaceId)
        .map(mapAsset)
    },
    listAgents(workspaceId, includeArchived = false) {
      const sql = includeArchived
        ? 'SELECT * FROM agent_sessions WHERE workspace_id = ? ORDER BY last_active_at DESC'
        : 'SELECT * FROM agent_sessions WHERE workspace_id = ? AND archived_at IS NULL ORDER BY last_active_at DESC'
      return db.prepare(sql).all(workspaceId).map(mapAgent)
    },
    listAllAgents(includeArchived = false) {
      const sql = includeArchived
        ? 'SELECT * FROM agent_sessions ORDER BY last_active_at DESC'
        : 'SELECT * FROM agent_sessions WHERE archived_at IS NULL ORDER BY last_active_at DESC'
      return db.prepare(sql).all().map(mapAgent)
    },
    getAgent(id) {
      return mapAgent(db.prepare('SELECT * FROM agent_sessions WHERE id = ?').get(id))
    },
    createAgent(workspaceId, input, capabilities = {}) {
      const id = randomUUID()
      const now = nowIso()
      db.prepare(`INSERT INTO agent_sessions
        (id, workspace_id, provider_id, title, lifecycle, model_id, mode_id, config_json,
         capabilities_json, native_handle_json, timeline_epoch, timeline_next_seq, last_error,
         requires_attention, attention_reason, attention_at, created_at, updated_at, last_active_at)
        VALUES (?, ?, ?, ?, 'initializing', ?, ?, ?, ?, ?, ?, 1, '', 0, NULL, NULL, ?, ?, ?)`)
        .run(id, workspaceId, input.providerId, input.title || DEFAULT_AGENT_TITLE, input.modelId || '', input.modeId || '',
          JSON.stringify(input.providerConfig || {}), JSON.stringify(capabilities), JSON.stringify(input.nativeHandle || {}), randomUUID(), now, now, now)
      return this.getAgent(id)
    },
    findAgentByProviderHandle(providerId, nativeHandle = {}) {
      const key = providerId === 'codex' ? nativeHandle.threadId : nativeHandle.sessionId
      if (!key) return null
      const rows = db.prepare('SELECT * FROM agent_sessions WHERE provider_id = ? AND native_handle_json LIKE ?').all(providerId, `%${key}%`)
      return mapAgent(rows.find((row) => parseJson(row.native_handle_json)?.[providerId === 'codex' ? 'threadId' : 'sessionId'] === key))
    },
    updateAgent(id, patch = {}) {
      const current = this.getAgent(id)
      if (!current) return null
      const next = { ...current, ...patch, updatedAt: nowIso() }
      db.prepare(`UPDATE agent_sessions SET title = ?, lifecycle = ?, model_id = ?, mode_id = ?,
        config_json = ?, capabilities_json = ?, native_handle_json = ?, last_error = ?, updated_at = ?,
        last_active_at = ?, archived_at = ?, requires_attention = ?, attention_reason = ?, attention_at = ? WHERE id = ?`)
        .run(next.title, next.lifecycle, next.modelId, next.modeId, JSON.stringify(next.config || {}),
          JSON.stringify(next.capabilities || {}), JSON.stringify(next.nativeHandle || {}), next.lastError || '',
          next.updatedAt, next.lastActiveAt || next.updatedAt, next.archivedAt || null,
          next.requiresAttention ? 1 : 0, next.attentionReason || null, next.attentionAt || null, id)
      return this.getAgent(id)
    },
    clearAgentAttention(id) {
      const current = this.getAgent(id)
      if (!current) return null
      if (!current.requiresAttention && !current.attentionReason && !current.attentionAt) return current
      return this.updateAgent(id, {
        requiresAttention: false,
        attentionReason: null,
        attentionAt: null,
      })
    },
    deleteAgent(id) {
      return db.prepare('DELETE FROM agent_sessions WHERE id = ?').run(id).changes > 0
    },
    getTurn(id) {
      return mapTurn(db.prepare('SELECT * FROM agent_turns WHERE id = ?').get(id))
    },
    getTurnByClientMessage(agentId, clientMessageId) {
      return mapTurn(db.prepare('SELECT * FROM agent_turns WHERE agent_session_id = ? AND client_message_id = ?').get(agentId, clientMessageId))
    },
    hasTurns(agentId) {
      return Boolean(db.prepare('SELECT 1 FROM agent_turns WHERE agent_session_id = ? LIMIT 1').get(agentId))
    },
    listTurns(agentId, limit = 100) {
      return db.prepare('SELECT * FROM agent_turns WHERE agent_session_id = ? ORDER BY created_at DESC LIMIT ?').all(agentId, limit).map(mapTurn)
    },
    createTurn(agentId, clientMessageId) {
      const existing = this.getTurnByClientMessage(agentId, clientMessageId)
      if (existing) return existing
      const id = randomUUID()
      const now = nowIso()
      db.prepare(`INSERT INTO agent_turns
        (id, agent_session_id, client_message_id, status, created_at)
        VALUES (?, ?, ?, 'queued', ?)`)
        .run(id, agentId, clientMessageId, now)
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
      db.prepare(`UPDATE agent_turns SET status = 'failed', error_message = 'daemon_restarted', finished_at = ?
        WHERE status IN ('queued', 'running')`).run(now)
      db.prepare(`UPDATE agent_sessions SET lifecycle = 'ready', updated_at = ?, requires_attention = 1,
        attention_reason = 'error', attention_at = ? WHERE lifecycle = 'running'`).run(now, now)
    },
    appendTimeline(agentId, turnId, item, options) {
      return insertTimeline(agentId, turnId, item, options)
    },
    getTimelineSyncState(agentId) {
      const row = db.prepare('SELECT * FROM agent_timeline_sync_state WHERE agent_session_id = ?').get(agentId)
      return row ? {
        providerId: row.provider_id,
        sourceId: row.source_id,
        manifest: parseJson(row.manifest_json),
        syncedAt: row.synced_at,
      } : null
    },
    applyTimelineSync(agentId, input) {
      return applyTimelineSync(agentId, input)
    },
    getTimelineState(agentId) {
      const row = db.prepare('SELECT timeline_epoch, timeline_next_seq FROM agent_sessions WHERE id = ?').get(agentId)
      return row ? { epoch: row.timeline_epoch, nextSeq: row.timeline_next_seq } : null
    },
    listTimelineRows(agentId) {
      return db.prepare('SELECT * FROM agent_timeline_rows WHERE agent_session_id = ? ORDER BY seq ASC').all(agentId).map((row) => ({
        seq: row.seq,
        timestamp: row.timestamp,
        ...(row.turn_id ? { turnId: row.turn_id } : {}),
        ...(row.provider_message_id ? { providerMessageId: row.provider_message_id } : {}),
        item: parseJson(row.item_json, { type: 'error', code: 'invalid_timeline_item', message: 'Timeline 数据损坏。' }),
      }))
    },
  }
}
