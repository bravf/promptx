import { inferPreviewLanguageFromPath, renderHighlightedCodeLines } from './sourceCodePreview.js'

export const TOOL_HIGHLIGHT_LIMIT = 64000
export const escapeToolHtml = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]))
const palette = ['textMuted', 'dangerText', 'successText', 'warningText', 'infoText', 'accentText', 'infoText', 'textPrimary']
const controlPattern = /\x1b\][\s\S]*?(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g
export const stripToolAnsi = text => text.replace(controlPattern, '')

function terminalColor(values, index) {
  if (values[index] === 5 && Number.isInteger(values[index + 1])) {
    const n = Math.max(0, Math.min(255, values[index + 1]))
    if (n < 16) return { color: `var(--theme-${palette[n % 8]})`, used: 2 }
    if (n >= 232) return { color: `rgb(${[8 + (n - 232) * 10].flatMap(v => [v, v, v]).join(',')})`, used: 2 }
    const x = n - 16, level = n => n ? 55 + n * 40 : 0
    return { color: `rgb(${[Math.floor(x / 36), Math.floor(x / 6) % 6, x % 6].map(level).join(',')})`, used: 2 }
  }
  if (values[index] === 2 && values.slice(index + 1, index + 4).length === 3 && values.slice(index + 1, index + 4).every(Number.isFinite)) {
    return { color: `rgb(${values.slice(index + 1, index + 4).map(n => Math.max(0, Math.min(255, n))).join(',')})`, used: 4 }
  }
  return null
}

export function renderToolAnsi(text) {
  let style = {}, html = '', position = 0
  // OSC 超链接等控制串仅移除；不允许终端输出创建链接或 HTML。
  const source = text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  const append = chunk => {
    const escaped = escapeToolHtml(stripToolAnsi(chunk))
    const css = Object.entries(style).map(([key, value]) => `${key}:${value}`).join(';')
    html += css ? `<span style="${css}">${escaped}</span>` : escaped
  }
  for (const match of source.matchAll(/\x1b\[([\d;]*)m/g)) {
    append(source.slice(position, match.index))
    const values = (match[1] || '0').split(';').map(Number)
    for (let i = 0; i < values.length; i++) {
      const n = values[i]
      if (n === 0) style = {}
      else if (n === 1) style['font-weight'] = '600'
      else if (n === 3) style['font-style'] = 'italic'
      else if (n === 4) style['text-decoration'] = 'underline'
      else if (n === 22) delete style['font-weight']
      else if (n === 23) delete style['font-style']
      else if (n === 24) delete style['text-decoration']
      else if (n === 39) delete style.color
      else if (n === 49) delete style['background-color']
      else if (n >= 30 && n <= 37 || n >= 90 && n <= 97) style.color = `var(--theme-${palette[n % 10]})`
      else if (n >= 40 && n <= 47 || n >= 100 && n <= 107) style['background-color'] = `var(--theme-${palette[n % 10]})`
      else if (n === 38 || n === 48) {
        const result = terminalColor(values, i + 1)
        if (result) { style[n === 38 ? 'color' : 'background-color'] = result.color; i += result.used }
      }
    }
    position = match.index + match[0].length
  }
  append(source.slice(position))
  return html
}

function changedWords(text, other) {
  if (text.length + other.length > 8000) return escapeToolHtml(text)
  let start = 0, end = text.length, otherEnd = other.length
  while (start < end && start < otherEnd && text[start] === other[start]) start++
  while (end > start && otherEnd > start && text[end - 1] === other[otherEnd - 1]) { end--; otherEnd-- }
  // 避免高亮边界落在 emoji 的代理对中间。
  if (start && /[\uD800-\uDBFF]/.test(text[start - 1])) start--
  if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end++
  return escapeToolHtml(text.slice(0, start)) + (end > start ? `<mark>${escapeToolHtml(text.slice(start, end))}</mark>` : '') + escapeToolHtml(text.slice(end))
}

export function toolDiffRows(text, showContext = false) {
  const rows = text.split('\n').map(text => {
    const kind = /^(?:@@|diff --git|index |--- |\+\+\+ |\*\*\*)/.test(text) ? 'header' : text.startsWith('+') ? 'add' : text.startsWith('-') ? 'delete' : 'context'
    return { text, kind, html: escapeToolHtml(text) || ' ' }
  })
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].kind !== 'delete') continue
    let end = i
    while (rows[end]?.kind === 'delete') end++
    let after = end
    while (rows[after]?.kind === 'add') after++
    for (let n = 0; n < Math.min(end - i, after - end); n++) {
      const left = rows[i + n], right = rows[end + n]
      left.html = '-' + changedWords(left.text.slice(1), right.text.slice(1))
      right.html = '+' + changedWords(right.text.slice(1), left.text.slice(1))
    }
    i = after - 1
  }
  if (showContext) return rows
  const result = []
  for (let i = 0; i < rows.length;) {
    if (rows[i].kind !== 'context') { result.push(rows[i++]); continue }
    let end = i
    while (rows[end]?.kind === 'context') end++
    if (end - i > 9) result.push(...rows.slice(i, i + 3), { kind: 'fold', count: end - i - 6 }, ...rows.slice(end - 3, end))
    else result.push(...rows.slice(i, end))
    i = end
  }
  return result
}

export async function highlightToolSection(section, isDark = false, showContext = false) {
  const text = String(section.text || '')
  if (text.length > TOOL_HIGHLIGHT_LIMIT || text.split('\n').length > 1500 || text.split('\n').some(line => line.length > 8000)) {
    return { html: escapeToolHtml(stripToolAnsi(text)), limited: true }
  }
  if (section.format === 'diff' || /^diff --git /m.test(text) && /^@@ -\d+(?:,\d+)? \+\d+/m.test(text)) return { rows: toolDiffRows(text, showContext) }
  if (/\x1b\[/.test(text)) return { html: renderToolAnsi(text) }
  let language = section.id === 'command' ? 'bash' : section.format === 'json' ? 'json' : section.format === 'code' ? inferPreviewLanguageFromPath(section.filePath) : ''
  if (!language && /^\s*[\[{]/.test(text) && !section.hasMore) {
    try { JSON.parse(text); language = 'json' } catch { /* 日志中的片段不冒充 JSON */ }
  }
  if (language) return { html: (await renderHighlightedCodeLines(text.split('\n'), { language, isDark, maxHighlightChars: TOOL_HIGHLIGHT_LIMIT, maxHighlightLines: 1500 })).join('\n') }
  if (section.format === 'search') {
    return { html: text.split('\n').map(line => {
      const match = line.match(/^((?:.*?:)?\d+[:\-])(.*)$/)
      let body = escapeToolHtml(match ? match[2] : line)
      if (section.matchText) { const needle = escapeToolHtml(section.matchText); body = body.split(needle).join(`<mark>${needle}</mark>`) }
      return (match ? `<span class="tool-line-number">${escapeToolHtml(match[1])}</span>` : '') + body
    }).join('\n') }
  }
  return { html: escapeToolHtml(text) }
}
