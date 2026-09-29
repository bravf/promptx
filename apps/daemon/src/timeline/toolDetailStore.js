import { createHash } from 'node:crypto'
import { mergeToolDetails, toolSections } from '../../../../packages/protocol/src/toolDetails.js'

const MAX_CACHE_BYTES = 32 * 1024 * 1024
const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 24)
function problem(statusCode, message) { return Object.assign(new Error(message), { statusCode }) }

// 按 JSON 转义后的 UTF-8 字节预算分页，避免中文、控制符和超长单行越界。
export function textPage(text, offset, maxBytes) {
  let low = offset, high = Math.min(text.length, offset + maxBytes)
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (Buffer.byteLength(JSON.stringify(text.slice(offset, middle))) <= maxBytes) low = middle
    else high = middle - 1
  }
  if (low < text.length && low > offset && /[\uD800-\uDBFF]/.test(text[low - 1])) low--
  return { text: text.slice(offset, low), nextOffset: low, hasMore: low < text.length }
}

export class ToolDetailStore {
  constructor(repository) {
    this.repository = repository
    this.cache = new Map()
    this.cacheBytes = 0
  }

  read(taskId, { turnId = '', callId, epoch, section, cursor, transport, manifest } = {}) {
    const state = this.repository.getTimelineState(taskId)
    if (!state) throw problem(404, '会话不存在。')
    if (epoch && epoch !== state.epoch) throw problem(409, '执行记录已更新，请重新展开。')
    if (typeof callId !== 'string' || !callId || callId.length > 512 || typeof turnId !== 'string' || turnId.length > 512) throw problem(400, '工具调用标识无效。')
    const revision = this.repository.getToolRevision(taskId, turnId, callId)
    if (!revision) throw problem(404, '找不到这次工具调用。')
    const key = JSON.stringify([taskId, turnId, callId, state.epoch])
    let cached = this.cache.get(key)
    if (cached) { this.cache.delete(key); this.cacheBytes -= cached.bytes }
    if (cached?.revision !== revision) {
      let item = cached?.item
      for (const row of this.repository.listToolRows(taskId, turnId, callId, cached?.revision || 0)) item = mergeToolDetails(item, row.item)
      const normalized = toolSections(item)
      const bytes = Buffer.byteLength(JSON.stringify(item)) + normalized.sections.reduce((sum, value) => sum + Buffer.byteLength(value.text), 0)
      cached = { item, ...normalized, revision, bytes }
    }
    if (cached.bytes <= MAX_CACHE_BYTES) {
      this.cache.set(key, cached); this.cacheBytes += cached.bytes
      while (this.cacheBytes > MAX_CACHE_BYTES || this.cache.size > 64) {
        const oldest = this.cache.keys().next().value
        this.cacheBytes -= this.cache.get(oldest).bytes
        this.cache.delete(oldest)
      }
    }
    const base = { epoch: state.epoch, revision, status: cached.item.status, hasChanges: cached.hasChanges, resultState: cached.resultState }
    const budget = transport === 'relay' ? 12 * 1024 : 48 * 1024
    if (section) {
      const source = cached.sections.find(value => value.id === section)
      if (!source) throw problem(404, '详情分段不存在。')
      let offset = 0
      if (cursor) {
        let parsed
        try { parsed = JSON.parse(Buffer.from(String(cursor), 'base64url').toString()) } catch { throw problem(400, '详情游标无效。') }
        if (parsed.key !== hash(key) || parsed.section !== section || !Number.isInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > source.text.length) throw problem(409, '详情内容已变化，请重新加载。')
        offset = parsed.offset
        // 允许追加输出沿用游标；替换已有内容或 epoch 变化则重置。
        if (parsed.prefix !== hash(source.text.slice(0, offset))) throw problem(409, '详情内容已变化，请重新加载。')
      }
      const page = textPage(source.text, offset, budget)
      return { ...base, section: { id: source.id, ...page, cursor: this.cursor(key, source, page.nextOffset) } }
    }
    if (manifest === '1') return { ...base, sections: cached.sections.map(({ text, ...meta }) => ({ ...meta, title: meta.title.slice(0, 120) })) }
    const perSection = Math.floor(budget / Math.max(1, cached.sections.length))
    return { ...base, sections: cached.sections.map(source => {
      const page = textPage(source.text, 0, perSection)
      return { id: source.id, title: source.title.slice(0, 120), format: source.format, ...(source.filePath ? { filePath: source.filePath } : {}), ...(source.matchText ? { matchText: source.matchText } : {}), ...page, cursor: this.cursor(key, source, page.nextOffset) }
    }) }
  }

  cursor(key, source, offset) {
    return Buffer.from(JSON.stringify({ key: hash(key), section: source.id, offset, prefix: hash(source.text.slice(0, offset)) })).toString('base64url')
  }
}
