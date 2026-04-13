import { BLOCK_TYPES } from '@promptx/shared'

export const REVIEW_COMMENTS_STORAGE_KEY = 'promptx:task-review-comments'
export const REVIEW_COMMENT_CONTEXT_BEFORE = 4
export const REVIEW_COMMENT_CONTEXT_AFTER = 4

function normalizeScope(value = '') {
  const normalized = String(value || '').trim()
  return normalized === 'run' || normalized === 'task' ? normalized : 'workspace'
}

function normalizeSnippet(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

export function normalizeReviewComment(input = {}) {
  return {
    id: String(input.id || '').trim(),
    scope: normalizeScope(input.scope),
    runId: String(input.runId || '').trim(),
    filePath: String(input.filePath || '').trim(),
    fileStatus: String(input.fileStatus || '').trim().toUpperCase() || 'M',
    anchorLineId: String(input.anchorLineId || '').trim(),
    anchorOldNumber: String(input.anchorOldNumber ?? '').trim(),
    anchorNewNumber: String(input.anchorNewNumber ?? '').trim(),
    content: String(input.content || '').trim(),
    snippet: normalizeSnippet(input.snippet),
    comment: String(input.comment || '').trim(),
    createdAt: String(input.createdAt || '').trim(),
  }
}

export function normalizeReviewCommentMap(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return {}
  }

  return Object.fromEntries(
    Object.entries(input)
      .map(([taskSlug, comments]) => {
        const normalizedTaskSlug = String(taskSlug || '').trim()
        if (!normalizedTaskSlug || !Array.isArray(comments)) {
          return null
        }

        const normalizedComments = comments
          .map((item) => normalizeReviewComment(item))
          .filter((item) => item.id && item.comment && item.filePath && item.snippet && item.content)

        return [normalizedTaskSlug, normalizedComments]
      })
      .filter(Boolean)
  )
}

export function loadReviewCommentMap() {
  if (typeof window === 'undefined') {
    return {}
  }

  try {
    const payload = JSON.parse(window.localStorage.getItem(REVIEW_COMMENTS_STORAGE_KEY) || '{}')
    return normalizeReviewCommentMap(payload)
  } catch {
    return {}
  }
}

export function saveReviewCommentMap(map = {}) {
  if (typeof window === 'undefined') {
    return
  }

  window.localStorage.setItem(
    REVIEW_COMMENTS_STORAGE_KEY,
    JSON.stringify(normalizeReviewCommentMap(map))
  )
}

export function getTaskReviewComments(map = {}, taskSlug = '') {
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return []
  }

  return normalizeReviewCommentMap(map)[normalizedTaskSlug] || []
}

export function setTaskReviewComments(map = {}, taskSlug = '', comments = []) {
  const normalizedMap = normalizeReviewCommentMap(map)
  const normalizedTaskSlug = String(taskSlug || '').trim()
  if (!normalizedTaskSlug) {
    return normalizedMap
  }

  return {
    ...normalizedMap,
    [normalizedTaskSlug]: Array.isArray(comments)
      ? comments.map((item) => normalizeReviewComment(item)).filter((item) => item.id && item.comment && item.filePath && item.snippet && item.content)
      : [],
  }
}

export function buildReviewCommentSnippet(lines = [], anchorLineId = '', options = {}) {
  const normalizedLines = Array.isArray(lines) ? lines : []
  const anchorIndex = normalizedLines.findIndex((line) => String(line?.id || '') === String(anchorLineId || '').trim())
  if (anchorIndex < 0) {
    return ''
  }

  const beforeCount = Math.max(0, Number(options.beforeCount) || REVIEW_COMMENT_CONTEXT_BEFORE)
  const afterCount = Math.max(0, Number(options.afterCount) || REVIEW_COMMENT_CONTEXT_AFTER)
  const isCodeLine = (line) => ['add', 'delete', 'context'].includes(String(line?.kind || '').trim())

  let start = anchorIndex
  let beforeSeen = 0
  while (start > 0 && beforeSeen < beforeCount) {
    if (String(normalizedLines[start - 1]?.kind || '') === 'hunk') {
      start -= 1
      break
    }

    start -= 1
    if (isCodeLine(normalizedLines[start])) {
      beforeSeen += 1
    }
  }

  let end = anchorIndex
  let afterSeen = 0
  while (end < normalizedLines.length - 1 && afterSeen < afterCount) {
    if (String(normalizedLines[end + 1]?.kind || '') === 'hunk') {
      break
    }

    end += 1
    if (isCodeLine(normalizedLines[end])) {
      afterSeen += 1
    }
  }

  for (let index = start; index >= 0; index -= 1) {
    if (String(normalizedLines[index]?.kind || '') === 'hunk') {
      start = index
      break
    }
  }

  return normalizedLines
    .slice(start, end + 1)
    .filter((line) => String(line?.kind || '') !== 'meta')
    .map((line) => String(line?.content || '').replace(/\r\n/g, '\n'))
    .join('\n')
    .trim()
}

function buildReviewCommentPromptText(comment = {}, index = 0) {
  const normalizedComment = normalizeReviewComment(comment)
  const lines = [
    `[代码评审评论 ${index + 1}]`,
    `file: ${normalizedComment.filePath}`,
  ]

  lines.push(
    `content: ${normalizedComment.content}`,
    '',
    'context:',
    normalizedComment.snippet,
    '',
    'comment:',
    normalizedComment.comment
  )
  return lines.join('\n').trim()
}

export function buildReviewCommentPromptBlocks(reviewComments = []) {
  return (Array.isArray(reviewComments) ? reviewComments : [])
    .map((comment, index) => normalizeReviewComment(comment))
    .filter((comment) => comment.id && comment.comment && comment.filePath && comment.snippet && comment.content)
    .map((comment, index) => ({
      type: BLOCK_TYPES.IMPORTED_TEXT,
      content: buildReviewCommentPromptText(comment, index),
      meta: {
        fileName: `review-comment-${index + 1}.md`,
        collapsed: false,
      },
    }))
}
