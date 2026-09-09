import { TimelineItemSchema, presentTimelineRow, presentTimelineRows, projectTimelineRows } from '../../../../packages/protocol/src/index.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000
const DEFAULT_PRESENTATION_BYTES = 128 * 1024

function byteLength(value) {
  return Buffer.byteLength(JSON.stringify(value))
}

function selectPresentedRows(rows, direction, limit, maxBytes) {
  const groups = []
  for (const row of rows) {
    const key = row.turnId ? `turn:${row.turnId}` : `row:${row.seq}`
    const previous = groups.at(-1)
    if (previous?.key === key) previous.rows.push(row)
    else groups.push({ key, rows: [row] })
  }
  const selected = []
  let selectedRows = 0
  let selectedBytes = 0
  const indexes = direction === 'after'
    ? groups.keys()
    : [...groups.keys()].reverse()
  for (const index of indexes) {
    const group = groups[index]
    const groupRows = group.rows.length
    const groupBytes = byteLength(group.rows)
    const exceeds = selected.length && (selectedRows + groupRows > limit || selectedBytes + groupBytes > maxBytes)
    if (exceeds) break
    selected.push(index)
    selectedRows += groupRows
    selectedBytes += groupBytes
    if (selectedRows >= limit) break
  }
  selected.sort((left, right) => left - right)
  return selected.flatMap((index) => groups[index].rows)
}

export class TimelineStore {
  constructor(repository) {
    this.repository = repository
  }

  append(taskId, turnId, item, options = {}) {
    return this.repository.appendTimeline(taskId, turnId, TimelineItemSchema.parse(item), options)
  }

  fetch(taskId, options = {}) {
    const state = this.repository.getTimelineState(taskId)
    if (!state) throw new Error('会话不存在。')
    const direction = ['tail', 'before', 'after'].includes(options.direction) ? options.direction : 'tail'
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT))
    const cursor = options.cursor || null
    const bounds = this.repository.getTimelineBounds(taskId)
    const minSeq = bounds.minSeq
    const maxSeq = bounds.maxSeq
    const window = { minSeq, maxSeq, nextSeq: state.nextSeq }
    const staleCursor = Boolean(cursor?.epoch && cursor.epoch !== state.epoch)
    const gap = Boolean(direction === 'after' && cursor && bounds.count && cursor.seq < minSeq - 1)
    const reset = staleCursor || gap
    const effectiveDirection = reset ? 'tail' : direction
    const seq = effectiveDirection === 'before'
      ? (Number(cursor?.seq) || state.nextSeq)
      : Math.max(0, Number(cursor?.seq) || 0)
    const rawLimit = options.mode === 'presented' ? MAX_LIMIT : limit
    const rawRows = this.repository.listTimelineWindow(taskId, { direction: effectiveDirection, seq, limit: rawLimit })
    const rows = options.mode === 'presented'
      ? selectPresentedRows(presentTimelineRows(rawRows), effectiveDirection, limit, Math.max(1, Number(options.maxBytes) || DEFAULT_PRESENTATION_BYTES))
      : rawRows

    const result = {
      epoch: state.epoch,
      direction,
      reset,
      staleCursor,
      gap,
      window,
      hasOlder: Boolean(rows.length && rows[0].seq > minSeq),
      hasNewer: Boolean(rows.length && rows.at(-1).seq < maxSeq),
      rows,
    }
    if (options.mode === 'projected') result.entries = projectTimelineRows(rows)
    return result
  }

  presentRow(row) {
    return presentTimelineRow(row)
  }
}
