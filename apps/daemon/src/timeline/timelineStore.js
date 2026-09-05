import { TimelineItemSchema, projectTimelineRows } from '../../../../packages/protocol/src/index.js'

const DEFAULT_LIMIT = 200
const MAX_LIMIT = 1000

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
    const rows = this.repository.listTimelineWindow(taskId, { direction: effectiveDirection, seq, limit })

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
