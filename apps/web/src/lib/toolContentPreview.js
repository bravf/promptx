// 同时限制行数和字符数，单行巨型日志也不会把 Timeline 撑满。
export function toolContentPreview(text = '', pages = 1) {
  const lineLimit = Math.max(1, pages) * 30
  let end = Math.min(text.length, Math.max(1, pages) * 6000)
  let offset = 0
  for (let line = 0; line < lineLimit; line++) {
    const next = text.indexOf('\n', offset)
    if (next < 0 || next >= end) break
    offset = next + 1
    if (line === lineLimit - 1) end = Math.min(end, offset)
  }
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--
  return { text: text.slice(0, end), hidden: end < text.length }
}
