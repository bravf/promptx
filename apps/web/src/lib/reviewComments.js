import { BLOCK_TYPES } from '@promptx/shared'

export const REVIEW_COMMENTS_STORAGE_KEY = 'promptx:task-review-comments'
export const REVIEW_COMMENT_CONTEXT_BEFORE = 3
export const REVIEW_COMMENT_CONTEXT_AFTER = 3

function normalizeScope(value = '') {
  const normalized = String(value || '').trim()
  return normalized === 'run' || normalized === 'task' ? normalized : 'workspace'
}

function normalizeSnippet(value = '') {
  return String(value || '').replace(/\r\n/g, '\n').trim()
}

export function normalizeReviewComment(input = {}) {
  const snippetAnchorLine = Number(input.snippetAnchorLine)
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
    snippetAnchorLine: Number.isInteger(snippetAnchorLine) && snippetAnchorLine >= 0 ? snippetAnchorLine : -1,
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
  const beforeCount = Math.max(0, Number(options.beforeCount) || REVIEW_COMMENT_CONTEXT_BEFORE)
  const afterCount = Math.max(0, Number(options.afterCount) || REVIEW_COMMENT_CONTEXT_AFTER)
  const isCodeLine = (line) => ['add', 'delete', 'context'].includes(String(line?.kind || '').trim())
  const codeLines = normalizedLines.filter((line) => isCodeLine(line))
  const anchorIndex = codeLines.findIndex((line) => String(line?.id || '') === String(anchorLineId || '').trim())
  if (anchorIndex < 0) {
    return options.returnMeta ? { text: '', anchorLine: -1 } : ''
  }

  const start = Math.max(0, anchorIndex - beforeCount)
  const end = Math.min(codeLines.length, anchorIndex + afterCount + 1)
  const snippetLines = codeLines
    .slice(start, end)
    .map((line) => String(line?.content || '').replace(/\r\n/g, '\n'))

  const payload = {
    text: snippetLines.join('\n').trim(),
    anchorLine: anchorIndex - start,
  }

  return options.returnMeta ? payload : payload.text
}

function buildReviewCommentPromptText(comment = {}, index = 0) {
  const normalizedComment = normalizeReviewComment(comment)
  const lines = [
    `[代码评审评论 ${index + 1}]`,
    `file: ${normalizedComment.filePath}`,
  ]

  lines.push(
    `content: ${normalizedComment.content}`,
    'context:',
    normalizedComment.snippet,
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
