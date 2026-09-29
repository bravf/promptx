import { toolSummary } from './toolDetails.js'

export function presentTimelineItem(item) {
  if (!item || item.type !== 'tool_call') return item
  const presented = { type: item.type, callId: item.callId, name: String(item.name || '').slice(0, 100), status: item.status, detail: item.detail?.outputDelta !== undefined ? { type: item.detail.type, hasDetails: true } : toolSummary(item), ...(item.error ? { error: { message: String(item.error.message || '').slice(0, 200) } } : {}) }
  const bytes = () => new TextEncoder().encode(JSON.stringify(presented)).length
  while (bytes() > 2048 && presented.detail.paths?.length) presented.detail.paths.pop()
  if (bytes() > 2048) delete presented.detail.command
  while (bytes() > 2048 && presented.detail.summary) presented.detail.summary = presented.detail.summary.slice(0, Math.floor(presented.detail.summary.length / 2))
  while (bytes() > 2048 && presented.error?.message) presented.error.message = presented.error.message.slice(0, Math.floor(presented.error.message.length / 2))
  return presented
}

export function presentTimelineRow(row) {
  if (!row) return row
  return { ...row, item: presentTimelineItem(row.item) }
}

export function presentTimelineRows(rows = []) {
  return rows.map(presentTimelineRow)
}
