import { BLOCK_TYPES } from '@promptx/shared'

export function hasImageBlocks(blocks = []) {
  return (blocks || []).some((block) => block.type === BLOCK_TYPES.IMAGE)
}

function resolveImageUrl(content = '', rawUrl = '') {
  const value = String(content || '').trim()
  if (!value) {
    return ''
  }
  if (/^https?:\/\//i.test(value)) {
    return value
  }

  try {
    return new URL(value, rawUrl).toString()
  } catch {
    return value
  }
}

function buildCodexBody(document, rawUrl) {
  const parts = []

  for (const [index, block] of (document?.blocks || []).entries()) {
    if (block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.IMPORTED_TEXT) {
      const text = String(block.content || '').trim()
      if (text) {
        parts.push(text, '')
      }
      continue
    }

    if (block.type === BLOCK_TYPES.IMAGE) {
      const imageUrl = resolveImageUrl(block.content, rawUrl)
      if (imageUrl) {
        parts.push(imageUrl, '')
      }
    }
  }

  return parts.join('\n').trim()
}

export function buildCodexPrompt(document, rawUrl) {
  return buildCodexBody(document, rawUrl)
}
