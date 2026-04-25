import fs from 'node:fs'
import path from 'node:path'
import { nanoid } from 'nanoid'
import { normalizeAgentEngine } from '../../../packages/shared/src/index.js'
import { all, get, run, transaction } from './db.js'
import { assertAgentRunner } from './agents/index.js'
import { createApiError } from './apiErrors.js'

const AGENT_ENGINE_ORDER = ['codex', 'claude-code', 'opencode', 'kimi-code']

function createHttpError(message, statusCode = 400) {
  return createApiError('', message, statusCode)
}

function cloneEngineMeta(input) {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? { ...input }
    : {}
}

function getSessionIdentityValue(record = {}) {
  return String(
    record.engineSessionId
    || record.engine_session_id
    || record.engineThreadId
    || record.engine_thread_id
    || record.codexThreadId
    || record.codex_thread_id
    || ''
  ).trim()
}

function hasSessionIdentity(record = {}) {
  return Boolean(getSessionIdentityValue(record))
}

function hasManualSessionBinding(engineMeta = {}) {
  return Boolean(engineMeta?.manualSessionBinding)
}

function isHiddenProjectMember(engineMeta = {}) {
  return Boolean(engineMeta?.hidden) && Boolean(String(engineMeta?.projectRootId || '').trim())
}

function getProjectRootId(engineMeta = {}) {
  return String(engineMeta?.projectRootId || '').trim()
}

function mapSessionIdToEngine(engine, sessionId = '') {
  const normalizedEngine = normalizeAgentEngine(engine)
  const normalizedSessionId = String(sessionId || '').trim()

  if (!normalizedSessionId) {
    return {
      codexThreadId: '',
      engineSessionId: '',
      engineThreadId: '',
    }
  }

  if (normalizedEngine === 'codex') {
    return {
      codexThreadId: normalizedSessionId,
      engineSessionId: '',
      engineThreadId: normalizedSessionId,
    }
  }

  return {
    codexThreadId: '',
    engineSessionId: normalizedSessionId,
    engineThreadId: normalizedSessionId,
  }
}

function toCodexSession(row) {
  if (!row) {
    return null
  }

  const engineMeta = parseEngineMeta(row.engine_meta_json)
  const sessionId = getSessionIdentityValue(row)

  return {
    id: row.id,
    title: row.title,
    engine: normalizeAgentEngine(row.engine),
    cwd: row.cwd,
    codexThreadId: row.codex_thread_id || row.engine_thread_id || '',
    engineSessionId: row.engine_session_id || '',
    engineThreadId: row.engine_thread_id || row.codex_thread_id || '',
    sessionId,
    engineMeta,
    running: false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    started: hasSessionIdentity(row) && !hasManualSessionBinding(engineMeta),
  }
}

function getSessionSelectRows() {
  return all(
    `SELECT id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
     FROM codex_sessions
     ORDER BY updated_at DESC`
  )
}

function sortAgentBindings(items = [], defaultEngine = 'codex') {
  const orderMap = new Map(AGENT_ENGINE_ORDER.map((engine, index) => [engine, index]))
  return [...items].sort((left, right) => {
    const leftDefault = Number(left?.engine === defaultEngine)
    const rightDefault = Number(right?.engine === defaultEngine)
    if (leftDefault !== rightDefault) {
      return rightDefault - leftDefault
    }

    const leftOrder = orderMap.has(left?.engine) ? orderMap.get(left.engine) : 999
    const rightOrder = orderMap.has(right?.engine) ? orderMap.get(right.engine) : 999
    if (leftOrder !== rightOrder) {
      return leftOrder - rightOrder
    }

    return String(left?.engine || '').localeCompare(String(right?.engine || ''), 'zh-CN')
  })
}

function normalizeProjectAgentEngines(items = [], defaultEngine = 'codex') {
  const seen = new Set()
  const normalizedItems = []

  ;[defaultEngine, ...(Array.isArray(items) ? items : [])].forEach((value) => {
    const normalized = normalizeAgentEngine(value)
    if (seen.has(normalized)) {
      return
    }
    seen.add(normalized)
    normalizedItems.push(normalized)
  })

  return sortAgentBindings(
    normalizedItems.map((engine) => ({ engine })),
    normalizeAgentEngine(defaultEngine)
  ).map((item) => item.engine)
}

function buildProjectAgentBinding(session, options = {}) {
  return {
    engine: normalizeAgentEngine(session?.engine),
    sessionRecordId: String(session?.id || '').trim(),
    sessionId: String(session?.sessionId || '').trim(),
    started: Boolean(session?.started),
    running: Boolean(session?.running),
    isDefault: Boolean(options.isDefault),
  }
}

function hydrateProjectSession(rootSession, memberSessions = []) {
  if (!rootSession) {
    return null
  }

  const byEngine = new Map()
  byEngine.set(rootSession.engine, buildProjectAgentBinding(rootSession, { isDefault: true }))

  memberSessions.forEach((memberSession) => {
    const engine = normalizeAgentEngine(memberSession?.engine)
    if (!engine || byEngine.has(engine)) {
      return
    }

    byEngine.set(engine, buildProjectAgentBinding(memberSession, { isDefault: false }))
  })

  const agentBindings = sortAgentBindings([...byEngine.values()], rootSession.engine)
  const started = Boolean(rootSession.started || agentBindings.some((item) => item.started))
  const running = Boolean(rootSession.running || agentBindings.some((item) => item.running))

  return {
    ...rootSession,
    running,
    started,
    agentBindings,
  }
}

function listProjectMemberSessions(rootSessionId = '', rows = []) {
  const targetId = String(rootSessionId || '').trim()
  if (!targetId) {
    return []
  }

  return rows
    .map(toCodexSession)
    .filter((session) => getProjectRootId(session?.engineMeta) === targetId && isHiddenProjectMember(session?.engineMeta))
}

function createSessionRecord(input = {}) {
  const id = String(input.id || `pxcs_${nanoid(12)}`).trim()
  const title = normalizeTitle(input.title, input.cwd)
  const engine = normalizeAgentEngine(input.engine)
  const cwd = normalizeCwd(input.cwd)
  const sessionId = String(input.sessionId || '').trim()
  const sessionFields = mapSessionIdToEngine(engine, sessionId)
  const engineMeta = cloneEngineMeta(input.engineMeta)

  if (sessionId) {
    engineMeta.manualSessionBinding = true
  } else {
    delete engineMeta.manualSessionBinding
  }

  run(
    `INSERT INTO codex_sessions (
       id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      title,
      engine,
      cwd,
      sessionFields.codexThreadId,
      sessionFields.engineSessionId,
      sessionFields.engineThreadId,
      JSON.stringify(engineMeta),
      String(input.createdAt || input.updatedAt || new Date().toISOString()),
      String(input.updatedAt || input.createdAt || new Date().toISOString()),
    ]
  )

  return id
}

function upsertProjectMemberSessions(rootSession, agentEngines = [], options = {}) {
  const now = String(options.updatedAt || new Date().toISOString())
  const nextAgentEngines = normalizeProjectAgentEngines(agentEngines, rootSession.engine)
  const memberEngines = nextAgentEngines.filter((engine) => engine !== rootSession.engine)
  const allRows = getSessionSelectRows()
  const existingMembers = listProjectMemberSessions(rootSession.id, allRows)
  const existingByEngine = new Map(existingMembers.map((item) => [item.engine, item]))

  existingMembers.forEach((member) => {
    if (memberEngines.includes(member.engine)) {
      run(
        `UPDATE codex_sessions
         SET title = ?, cwd = ?, updated_at = ?
         WHERE id = ?`,
        [rootSession.title, rootSession.cwd, now, member.id]
      )
      return
    }

    run('DELETE FROM codex_sessions WHERE id = ?', [member.id])
  })

  memberEngines.forEach((engine) => {
    if (existingByEngine.has(engine)) {
      return
    }

    createSessionRecord({
      title: rootSession.title,
      engine,
      cwd: rootSession.cwd,
      engineMeta: {
        hidden: true,
        projectRootId: rootSession.id,
      },
      createdAt: now,
      updatedAt: now,
    })
  })
}

function parseEngineMeta(rawValue = '{}') {
  try {
    const parsed = JSON.parse(rawValue || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function ensureAgentRunnerAvailable(engine) {
  try {
    assertAgentRunner(engine)
  } catch (error) {
    throw createApiError('errors.agentEngineUnavailable', error.message || '当前执行引擎不可用。')
  }
}

function normalizeTitle(input = '', cwd = '') {
  const title = String(input || '').trim().slice(0, 140)
  if (title) {
    return title
  }

  const baseName = path.basename(String(cwd || '').trim())
  return baseName || 'PromptX 项目'
}

export function normalizeCwd(input = '') {
  const cwd = String(input || '').trim()
  if (!cwd) {
    throw createApiError('errors.cwdRequired', '请先填写工作目录。')
  }

  const resolved = path.resolve(cwd)
  if (!fs.existsSync(resolved)) {
    throw createApiError('errors.cwdNotFound', '工作目录不存在，请重新确认。')
  }

  const stats = fs.statSync(resolved)
  if (!stats.isDirectory()) {
    throw createApiError('errors.cwdMustBeDirectory', '工作目录必须是文件夹。')
  }

  return resolved
}

export function listPromptxCodexSessions(limit = 30) {
  const rows = getSessionSelectRows()
  const rootSessions = rows
    .map(toCodexSession)
    .filter((session) => !isHiddenProjectMember(session?.engineMeta))
    .slice(0, Math.max(1, Number(limit) || 30))

  return rootSessions.map((session) => hydrateProjectSession(session, listProjectMemberSessions(session.id, rows)))
}

export function getPromptxCodexSessionById(sessionId) {
  const targetId = String(sessionId || '').trim()
  if (!targetId) {
    return null
  }

  const row = get(
    `SELECT id, title, engine, cwd, codex_thread_id, engine_session_id, engine_thread_id, engine_meta_json, created_at, updated_at
     FROM codex_sessions
     WHERE id = ?`,
    [targetId]
  )

  const session = toCodexSession(row)
  if (!session) {
    return null
  }

  if (isHiddenProjectMember(session.engineMeta)) {
    return session
  }

  return hydrateProjectSession(session, listProjectMemberSessions(session.id, getSessionSelectRows()))
}

export function createPromptxCodexSession(input = {}) {
  const cwd = normalizeCwd(input.cwd)
  const title = normalizeTitle(input.title, cwd)
  const engine = normalizeAgentEngine(input.engine)
  const agentEngines = normalizeProjectAgentEngines(input.agentEngines, engine)
  const sessionId = String(input.sessionId || '').trim()
  ensureAgentRunnerAvailable(engine)
  agentEngines.forEach((item) => ensureAgentRunnerAvailable(item))
  const now = new Date().toISOString()
  const id = `pxcs_${nanoid(12)}`

  transaction(() => {
    createSessionRecord({
      id,
      title,
      engine,
      cwd,
      sessionId,
      engineMeta: {},
      createdAt: now,
      updatedAt: now,
    })
    upsertProjectMemberSessions({
      id,
      title,
      engine,
      cwd,
    }, agentEngines, {
      updatedAt: now,
    })
  })

  return getPromptxCodexSessionById(id)
}

export function updatePromptxCodexSession(sessionId, patch = {}) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }
  const isProjectRoot = !isHiddenProjectMember(existing.engineMeta)

  const wantsCwd = Object.prototype.hasOwnProperty.call(patch, 'cwd')
  const nextCwd = wantsCwd
    ? normalizeCwd(patch.cwd)
    : existing.cwd
  const wantsEngine = Object.prototype.hasOwnProperty.call(patch, 'engine')
  const nextEngine = wantsEngine
    ? normalizeAgentEngine(patch.engine)
    : existing.engine
  ensureAgentRunnerAvailable(nextEngine)
  const wantsAgentEngines = Object.prototype.hasOwnProperty.call(patch, 'agentEngines')
  const nextAgentEngines = isProjectRoot && wantsAgentEngines
    ? normalizeProjectAgentEngines(patch.agentEngines, nextEngine)
    : (isProjectRoot
      ? normalizeProjectAgentEngines(existing.agentBindings?.map((item) => item.engine), nextEngine)
      : [nextEngine])
  if (isProjectRoot) {
    nextAgentEngines.forEach((engine) => ensureAgentRunnerAvailable(engine))
  }

  if (existing.started && wantsCwd && nextCwd !== existing.cwd) {
    throw createApiError('errors.startedProjectCwdLocked', '已启动的 PromptX 项目不能直接修改工作目录。', 409)
  }
  if (existing.started && wantsEngine && nextEngine !== existing.engine) {
    throw createApiError('errors.startedProjectEngineLocked', '已启动的 PromptX 项目不能直接切换执行引擎，请新建项目。', 409)
  }
  if (
    existing.started
    && wantsAgentEngines
    && nextAgentEngines.join('\n') !== normalizeProjectAgentEngines(existing.agentBindings?.map((item) => item.engine), existing.engine).join('\n')
  ) {
    throw createApiError('errors.startedProjectEngineLocked', '已启动的 PromptX 项目不能直接修改协作 Agent，请新建项目。', 409)
  }

  const wantsGenericSessionId = Object.prototype.hasOwnProperty.call(patch, 'sessionId')
  const wantsCodexThreadId = Object.prototype.hasOwnProperty.call(patch, 'codexThreadId')
  const wantsEngineSessionId = Object.prototype.hasOwnProperty.call(patch, 'engineSessionId')
  const wantsEngineThreadId = Object.prototype.hasOwnProperty.call(patch, 'engineThreadId')
  const wantsExplicitSessionFields = wantsCodexThreadId || wantsEngineSessionId || wantsEngineThreadId
  const nextSessionId = wantsGenericSessionId
    ? String(patch.sessionId || '').trim()
    : existing.sessionId
  if (existing.started && wantsGenericSessionId && nextSessionId !== existing.sessionId) {
    throw createApiError('errors.startedProjectSessionLocked', '已启动的 PromptX 项目不能直接修改会话 ID，请新建项目。', 409)
  }

  const title = Object.prototype.hasOwnProperty.call(patch, 'title')
    ? normalizeTitle(patch.title, nextCwd)
    : existing.title
  let codexThreadId = existing.codexThreadId
  let engineSessionId = existing.engineSessionId
  let engineThreadId = existing.engineThreadId

  if (wantsGenericSessionId || (wantsEngine && hasManualSessionBinding(existing.engineMeta) && !wantsExplicitSessionFields)) {
    const mapped = mapSessionIdToEngine(nextEngine, nextSessionId)
    codexThreadId = mapped.codexThreadId
    engineSessionId = mapped.engineSessionId
    engineThreadId = mapped.engineThreadId
  } else {
    if (wantsCodexThreadId) {
      codexThreadId = String(patch.codexThreadId || '').trim()
    }
    if (wantsEngineSessionId) {
      engineSessionId = String(patch.engineSessionId || '').trim()
    }
    if (wantsEngineThreadId) {
      engineThreadId = String(patch.engineThreadId || '').trim()
    }
  }

  const engineMeta = Object.prototype.hasOwnProperty.call(patch, 'engineMeta')
    ? cloneEngineMeta(patch.engineMeta)
    : cloneEngineMeta(existing.engineMeta)

  if (wantsGenericSessionId) {
    if (nextSessionId) {
      engineMeta.manualSessionBinding = true
    } else {
      delete engineMeta.manualSessionBinding
    }
  } else if (patch.clearManualSessionBinding === true || wantsExplicitSessionFields) {
    delete engineMeta.manualSessionBinding
  }

  const updatedAt = patch.updatedAt || new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_sessions
       SET title = ?, engine = ?, cwd = ?, codex_thread_id = ?, engine_session_id = ?, engine_thread_id = ?, engine_meta_json = ?, updated_at = ?
       WHERE id = ?`,
      [title, nextEngine, nextCwd, codexThreadId, engineSessionId, engineThreadId, JSON.stringify(engineMeta), updatedAt, existing.id]
    )

    if (isProjectRoot) {
      upsertProjectMemberSessions({
        id: existing.id,
        title,
        engine: nextEngine,
        cwd: nextCwd,
      }, nextAgentEngines, {
        updatedAt,
      })
    }
  })

  return getPromptxCodexSessionById(existing.id)
}

export function resetPromptxCodexSession(sessionId) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }

  const updatedAt = new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE codex_sessions
       SET codex_thread_id = '', engine_session_id = '', engine_thread_id = '', engine_meta_json = '{}', updated_at = ?
       WHERE id = ?`,
      [updatedAt, existing.id]
    )

    const memberSessions = listProjectMemberSessions(existing.id, getSessionSelectRows())
    memberSessions.forEach((memberSession) => {
      const nextEngineMeta = {
        hidden: true,
        projectRootId: existing.id,
      }
      run(
        `UPDATE codex_sessions
         SET codex_thread_id = '', engine_session_id = '', engine_thread_id = '', engine_meta_json = ?, updated_at = ?
         WHERE id = ?`,
        [JSON.stringify(nextEngineMeta), updatedAt, memberSession.id]
      )
    })
  })

  return getPromptxCodexSessionById(existing.id)
}

export function deletePromptxCodexSession(sessionId) {
  const existing = getPromptxCodexSessionById(sessionId)
  if (!existing) {
    return null
  }

  transaction(() => {
    const memberSessions = listProjectMemberSessions(existing.id, getSessionSelectRows())
    memberSessions.forEach((memberSession) => {
      run('DELETE FROM codex_sessions WHERE id = ?', [memberSession.id])
    })
    run('DELETE FROM codex_sessions WHERE id = ?', [existing.id])
  })

  return existing
}
