import MarkdownIt from 'markdown-it'

export const TIMELINE_MARKDOWN_CHARACTER_LIMIT = 32000

const blockParser = new MarkdownIt()

function getStructuralBlankLines(text, lines) {
  const blankLines = new Set()
  for (const token of blockParser.parse(text, {})) {
    if (token.level !== 0 || !token.map) continue
    const [start, end] = token.map
    for (let index = start; index < end - 1; index += 1) {
      if (!lines[index]?.trim()) blankLines.add(index)
    }
  }
  return blankLines
}

export function splitTimelineMarkdownBlocks(value = '') {
  const text = String(value || '')
  if (!text) return []

  const lines = text.split('\n')
  const structuralBlankLines = getStructuralBlankLines(text, lines)
  const blocks = []
  let currentLines = []
  let sawSeparator = false

  lines.forEach((line, index) => {
    const blank = !line.trim()
    if (blank && structuralBlankLines.has(index)) {
      currentLines.push(line)
      return
    }
    if (blank) {
      if (currentLines.length) sawSeparator = true
      return
    }
    if (sawSeparator) {
      blocks.push(currentLines.join('\n'))
      currentLines = []
      sawSeparator = false
    }
    currentLines.push(line)
  })

  if (currentLines.length) blocks.push(currentLines.join('\n'))
  return blocks.filter(Boolean)
}

export function capTimelineMarkdown(value = '', limit = TIMELINE_MARKDOWN_CHARACTER_LIMIT) {
  const text = String(value || '')
  if (text.length <= limit) return { text, capped: false }

  let end = limit
  const finalCodeUnit = text.charCodeAt(end - 1)
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1
  return { text: text.slice(0, end), capped: true }
}
