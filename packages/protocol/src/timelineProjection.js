function appendRange(ranges, seq) {
  const last = ranges.at(-1)
  if (last && seq <= last.endSeq + 1) {
    last.endSeq = Math.max(last.endSeq, seq)
    return ranges
  }
  ranges.push({ startSeq: seq, endSeq: seq })
  return ranges
}

function mergeToolItem(previous, next) {
  return {
    ...previous,
    ...next,
    detail: next.detail?.type === 'unknown' && previous.detail?.type !== 'unknown'
      ? previous.detail
      : next.detail,
    metadata: previous.metadata || next.metadata
      ? { ...previous.metadata, ...next.metadata }
      : undefined,
  }
}

function normalizeComparableText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ')
}

export function projectTimelineRows(rows = []) {
  const entries = []
  const toolIndexes = new Map()

  for (const row of rows) {
    const entry = {
      item: row.item,
      ...(row.turnId ? { turnId: row.turnId } : {}),
      timestamp: row.timestamp,
      seqStart: row.seq,
      seqEnd: row.seq,
      sourceSeqRanges: [{ startSeq: row.seq, endSeq: row.seq }],
      collapsed: [],
    }

    if (row.item.type === 'tool_call') {
      const key = `${row.turnId || ''}:${row.item.callId}`
      const index = toolIndexes.get(key)
      if (index !== undefined) {
        const previous = entries[index]
        previous.item = mergeToolItem(previous.item, row.item)
        previous.timestamp = row.timestamp
        previous.seqEnd = row.seq
        appendRange(previous.sourceSeqRanges, row.seq)
        if (!previous.collapsed.includes('tool_lifecycle')) previous.collapsed.push('tool_lifecycle')
        continue
      }
      toolIndexes.set(key, entries.length)
    }

    const previous = entries.at(-1)
    const duplicateProviderError = row.item.type === 'error'
      && previous?.item?.type === 'assistant_message'
      && previous.turnId === row.turnId
      && normalizeComparableText(row.item.message)
      && normalizeComparableText(row.item.message) === normalizeComparableText(previous.item.text)
    if (duplicateProviderError) {
      previous.item = row.item
      previous.timestamp = row.timestamp
      previous.seqEnd = row.seq
      appendRange(previous.sourceSeqRanges, row.seq)
      previous.collapsed.push('duplicate_provider_error')
      continue
    }

    const textKind = row.item.type === 'assistant_message' || row.item.type === 'reasoning'
    const sameMessage = row.item.type !== 'assistant_message'
      || !row.item.messageId
      || row.item.messageId === previous?.item?.messageId
    const samePhase = row.item.type !== 'assistant_message'
      || row.item.phase === previous?.item?.phase
    if (
      textKind
      && previous?.item?.type === row.item.type
      && previous.turnId === row.turnId
      && previous.seqEnd + 1 === row.seq
      && sameMessage
      && samePhase
    ) {
      previous.item = { ...previous.item, text: `${previous.item.text}${row.item.text}` }
      previous.timestamp = row.timestamp
      previous.seqEnd = row.seq
      appendRange(previous.sourceSeqRanges, row.seq)
      const kind = row.item.type === 'assistant_message' ? 'assistant_merge' : 'reasoning_merge'
      if (!previous.collapsed.includes(kind)) previous.collapsed.push(kind)
      continue
    }

    entries.push(entry)
  }

  return entries
}
