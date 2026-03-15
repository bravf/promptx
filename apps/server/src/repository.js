import { customAlphabet } from 'nanoid'
import {
  BLOCK_TYPES,
  buildRawTaskText,
  clampText,
  deriveTitleFromBlocks,
  getExpiryValue,
  normalizeExpiry,
  normalizeVisibility,
  resolveExpiresAt,
  slugifyTitle,
  summarizeTask,
} from '@promptx/shared'
import { all, get, run, transaction } from './db.js'

const slugTail = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 6)
const tokenId = customAlphabet('abcdefghijkmnpqrstuvwxyz23456789', 20)

function toBlock(row) {
  return {
    id: Number(row.id),
    type: row.type,
    content: row.content,
    sortOrder: Number(row.sort_order),
    meta: JSON.parse(row.meta_json || '{}'),
  }
}

function toTask(row, blocks = []) {
  const displayTitle = row.title || row.auto_title || deriveTitleFromBlocks(blocks)
  return {
    id: Number(row.id),
    slug: row.slug,
    title: row.title,
    autoTitle: row.auto_title || '',
    lastPromptPreview: row.last_prompt_preview || '',
    codexSessionId: row.codex_session_id || '',
    displayTitle,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    expiry: getExpiryValue(row.expires_at),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    blocks,
  }
}

function ensureSlug(title) {
  const base = slugifyTitle(title)
  let slug = `${base}-${slugTail()}`
  while (get('SELECT 1 FROM tasks WHERE slug = ?', [slug])) {
    slug = `${base}-${slugTail()}`
  }
  return slug
}

function isExpired(task) {
  return Boolean(task.expiresAt && new Date(task.expiresAt).getTime() <= Date.now())
}

function loadBlocks(taskId) {
  return all(
    `SELECT id, type, content, sort_order, meta_json
     FROM blocks
     WHERE task_id = ?
     ORDER BY sort_order ASC, id ASC`,
    [taskId]
  ).map(toBlock)
}

function loadBlocksForTasks(taskIds = []) {
  if (!taskIds.length) {
    return new Map()
  }

  const placeholders = taskIds.map(() => '?').join(', ')
  const rows = all(
    `SELECT task_id, type, content, sort_order, id
     FROM blocks
     WHERE task_id IN (${placeholders})
     ORDER BY task_id ASC, sort_order ASC, id ASC`,
    taskIds
  )

  const grouped = new Map()
  rows.forEach((row) => {
    const taskId = Number(row.task_id)
    if (!grouped.has(taskId)) {
      grouped.set(taskId, [])
    }
    grouped.get(taskId).push({
      type: row.type,
      content: row.content,
    })
  })

  return grouped
}

function loadListMetadata(taskIds = []) {
  if (!taskIds.length) {
    return {
      blockCountByTaskId: new Map(),
      firstTextByTaskId: new Map(),
    }
  }

  const placeholders = taskIds.map(() => '?').join(', ')
  const countRows = all(
    `SELECT task_id, COUNT(*) AS block_count
     FROM blocks
     WHERE task_id IN (${placeholders})
     GROUP BY task_id`,
    taskIds
  )
  const firstTextRows = all(
    `SELECT task_id, content
     FROM (
       SELECT
         task_id,
         content,
         ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY sort_order ASC, id ASC) AS row_num
       FROM blocks
       WHERE task_id IN (${placeholders})
         AND type IN (?, ?)
         AND TRIM(content) != ''
     ) ranked
     WHERE row_num = 1`,
    [...taskIds, BLOCK_TYPES.TEXT, BLOCK_TYPES.IMPORTED_TEXT]
  )

  return {
    blockCountByTaskId: new Map(
      countRows.map((row) => [Number(row.task_id), Number(row.block_count)])
    ),
    firstTextByTaskId: new Map(
      firstTextRows.map((row) => [Number(row.task_id), row.content || ''])
    ),
  }
}

function collectImagePaths(blocks = []) {
  return blocks
    .filter((block) => block.type === BLOCK_TYPES.IMAGE && block.content)
    .map((block) => block.content)
}

function mapTaskSummary(row, firstText = '', blockCount = 0) {
  const textBlock = firstText
    ? [{ type: BLOCK_TYPES.TEXT, content: firstText }]
    : []

  return {
    slug: row.slug,
    title: row.title || '',
    autoTitle: row.auto_title || deriveTitleFromBlocks(textBlock) || '',
    lastPromptPreview: row.last_prompt_preview || '',
    codexSessionId: row.codex_session_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    visibility: row.visibility,
    expiresAt: row.expires_at,
    preview: summarizeTask({ blocks: textBlock }),
    blockCount,
  }
}

function normalizeBlockInput(block = {}) {
  const type =
    block.type === BLOCK_TYPES.IMAGE
      ? BLOCK_TYPES.IMAGE
      : block.type === BLOCK_TYPES.IMPORTED_TEXT
        ? BLOCK_TYPES.IMPORTED_TEXT
        : BLOCK_TYPES.TEXT
  const content = clampText(
    block.content || '',
    type === BLOCK_TYPES.IMAGE ? 1000 : 50000
  )
  const meta =
    type === BLOCK_TYPES.IMPORTED_TEXT
      ? {
          fileName: clampText(block.meta?.fileName || '', 180),
          collapsed: Boolean(block.meta?.collapsed),
        }
      : {}

  return {
    id: Number.isInteger(Number(block.id)) ? Number(block.id) : null,
    type,
    content,
    meta,
    metaJson: JSON.stringify(meta),
  }
}

export function listTasks(limit = 30) {
  const rows = all(
    `SELECT id, slug, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at
     FROM tasks
     ORDER BY updated_at DESC
     LIMIT ?`,
    [Math.max(1, Number(limit) || 30)]
  )

  const taskIds = rows.map((row) => Number(row.id))
  const {
    blockCountByTaskId,
    firstTextByTaskId,
  } = loadListMetadata(taskIds)

  return rows.map((row) =>
    mapTaskSummary(
      row,
      firstTextByTaskId.get(Number(row.id)) || '',
      blockCountByTaskId.get(Number(row.id)) || 0
    )
  )
}

export function getTaskBySlug(slug) {
  const row = get(
    `SELECT id, slug, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at
     FROM tasks
     WHERE slug = ?`,
    [slug]
  )

  if (!row) {
    return null
  }

  const task = toTask(row, loadBlocks(row.id))
  return isExpired(task) ? { ...task, expired: true } : task
}

export function createTask(input = {}) {
  const now = new Date().toISOString()
  const title = clampText(input.title || '', 140)
  const autoTitle = clampText(input.autoTitle || '', 140)
  const lastPromptPreview = clampText(input.lastPromptPreview || '', 280)
  const codexSessionId = clampText(input.codexSessionId || '', 120)
  const visibility = normalizeVisibility(input.visibility)
  const expiresAt = resolveExpiresAt(normalizeExpiry(input.expiry || 'none'))
  const slug = ensureSlug(title)
  const editToken = tokenId()

  transaction(() => {
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [slug, editToken, title, autoTitle, lastPromptPreview, codexSessionId, visibility, expiresAt, now, now]
    )
  })

  return {
    ...getTaskBySlug(slug),
    editToken,
  }
}

export function updateTask(slug, input = {}) {
  const existing = get(
    `SELECT id, edit_token, codex_session_id
     FROM tasks
     WHERE slug = ?`,
    [slug]
  )
  if (!existing) {
    return { error: 'not_found' }
  }

  const title = clampText(input.title || '', 140)
  const autoTitle = clampText(input.autoTitle || '', 140)
  const lastPromptPreview = clampText(input.lastPromptPreview || '', 280)
  const codexSessionId = Object.prototype.hasOwnProperty.call(input, 'codexSessionId')
    ? clampText(input.codexSessionId || '', 120)
    : String(existing.codex_session_id || '')
  const visibility = normalizeVisibility(input.visibility)
  const expiresAt = resolveExpiresAt(normalizeExpiry(input.expiry || 'none'))
  const updatedAt = new Date().toISOString()
  const blocks = Array.isArray(input.blocks) ? input.blocks.map(normalizeBlockInput) : []
  const currentBlocks = loadBlocks(existing.id)
  const currentBlockMap = new Map(currentBlocks.map((block) => [block.id, block]))

  transaction(() => {
    run(
      `UPDATE tasks
       SET title = ?, auto_title = ?, last_prompt_preview = ?, codex_session_id = ?, visibility = ?, expires_at = ?, updated_at = ?
       WHERE slug = ?`,
      [title, autoTitle, lastPromptPreview, codexSessionId, visibility, expiresAt, updatedAt, slug]
    )

    const incomingIds = new Set()

    blocks.forEach((block, index) => {
      const currentBlock = block.id ? currentBlockMap.get(block.id) : null

      if (currentBlock) {
        incomingIds.add(currentBlock.id)

        const currentMetaJson = JSON.stringify(currentBlock.meta || {})
        const unchanged =
          currentBlock.type === block.type
          && currentBlock.content === block.content
          && currentBlock.sortOrder === index
          && currentMetaJson === block.metaJson

        if (!unchanged) {
          run(
            `UPDATE blocks
             SET type = ?, content = ?, sort_order = ?, meta_json = ?
             WHERE id = ? AND task_id = ?`,
            [block.type, block.content, index, block.metaJson, currentBlock.id, existing.id]
          )
        }
        return
      }

      run(
        `INSERT INTO blocks (task_id, type, content, sort_order, meta_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [existing.id, block.type, block.content, index, block.metaJson, updatedAt]
      )
    })

    currentBlocks.forEach((block) => {
      if (!incomingIds.has(block.id)) {
        run('DELETE FROM blocks WHERE id = ? AND task_id = ?', [block.id, existing.id])
      }
    })
  })

  return getTaskBySlug(slug)
}

export function deleteTask(slug) {
  const row = get('SELECT id, edit_token FROM tasks WHERE slug = ?', [slug])
  if (!row) {
    return { error: 'not_found' }
  }

  const blocks = loadBlocks(row.id)
  const removedAssets = collectImagePaths(blocks)

  transaction(() => {
    run('DELETE FROM tasks WHERE slug = ?', [slug])
  })

  return { ok: true, removedAssets }
}

export function purgeExpiredTasks(now = new Date().toISOString()) {
  const rows = all(
    `SELECT id
     FROM tasks
     WHERE expires_at IS NOT NULL
       AND expires_at <= ?`,
    [now]
  )

  if (!rows.length) {
    return { removedAssets: [], removedCount: 0 }
  }

  const taskIds = rows.map((row) => Number(row.id))
  const blocksByTaskId = loadBlocksForTasks(taskIds)
  const removedAssets = taskIds.flatMap((taskId) =>
    collectImagePaths(blocksByTaskId.get(taskId) || [])
  )

  const placeholders = taskIds.map(() => '?').join(', ')
  transaction(() => {
    run(`DELETE FROM tasks WHERE id IN (${placeholders})`, taskIds)
  })

  return {
    removedAssets,
    removedCount: taskIds.length,
  }
}

export function buildTaskExports(task) {
  return {
    raw: buildRawTaskText(task),
  }
}

export function canEditTask(slug) {
  return Boolean(get('SELECT 1 FROM tasks WHERE slug = ?', [slug]))
}

export function updateTaskCodexSession(slug, codexSessionId = '') {
  const existing = get('SELECT slug FROM tasks WHERE slug = ?', [slug])
  if (!existing) {
    return null
  }

  const normalizedSessionId = String(codexSessionId || '').trim()
  const updatedAt = new Date().toISOString()

  transaction(() => {
    run(
      `UPDATE tasks
       SET codex_session_id = ?, updated_at = ?
       WHERE slug = ?`,
      [normalizedSessionId, updatedAt, slug]
    )
  })

  return getTaskBySlug(slug)
}

export function clearTaskCodexSessionReferences(codexSessionId = '') {
  const normalizedSessionId = String(codexSessionId || '').trim()
  if (!normalizedSessionId) {
    return 0
  }

  const matchedCount = Number(
    get(
      `SELECT COUNT(*) AS count
       FROM tasks
       WHERE codex_session_id = ?`,
      [normalizedSessionId]
    )?.count || 0
  )

  if (!matchedCount) {
    return 0
  }

  transaction(() => {
    run(
      `UPDATE tasks
       SET codex_session_id = ''
       WHERE codex_session_id = ?`,
      [normalizedSessionId]
    )
  })

  return matchedCount
}
