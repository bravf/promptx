export const DEFAULT_AGENT_TITLE = '新会话'

const MAX_INITIAL_AGENT_TITLE_CHARS = 60

export function deriveAgentTitle(content = []) {
  for (const block of content) {
    if (block?.type !== 'text') continue
    const firstContentLine = String(block.text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean)
    if (!firstContentLine) continue
    const normalized = firstContentLine.replace(/\s+/g, ' ').trim()
    const title = normalized.slice(0, MAX_INITIAL_AGENT_TITLE_CHARS).trim()
    if (title) return title
  }
  return null
}
