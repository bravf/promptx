import { TimelineItemSchema, projectTimelineRows } from '../../../../packages/protocol/src/index.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

export class TimelineStore {
  constructor(repository) {
    this.repository = repository
  }

  append(agentId, turnId, item, options = {}) {
    return this.repository.appendTimeline(agentId, turnId, TimelineItemSchema.parse(item), options)
  }

  fetch(agentId, options = {}) {
    const state = this.repository.getTimelineState(agentId)
    if (!state) throw new Error('Agent 不存在。')
    const allRows = this.repository.listTimelineRows(agentId)
    const direction = ['tail', 'before', 'after'].includes(options.direction) ? options.direction : 'tail'
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(options.limit) || DEFAULT_LIMIT))
    const cursor = options.cursor || null
    const minSeq = allRows[0]?.seq || 0
    const maxSeq = allRows.at(-1)?.seq || 0
    const window = { minSeq, maxSeq, nextSeq: state.nextSeq }
    const staleCursor = Boolean(cursor?.epoch && cursor.epoch !== state.epoch)
    const gap = Boolean(direction === 'after' && cursor && allRows.length && cursor.seq < minSeq - 1)
    let reset = staleCursor || gap
    let rows

    if (reset || direction === 'tail') {
      rows = allRows.slice(-limit)
    } else if (direction === 'before') {
      const beforeSeq = Number(cursor?.seq) || state.nextSeq
      rows = allRows.filter((row) => row.seq < beforeSeq).slice(-limit)
    } else {
      const afterSeq = Math.max(0, Number(cursor?.seq) || 0)
      rows = allRows.filter((row) => row.seq > afterSeq).slice(0, limit)
    }

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
}
