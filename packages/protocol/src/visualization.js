export const VISUALIZATION_START = 'visualize'
const END = ''

// 只解释展示指令，保留原消息；代码示例、转义与流式半截指令不执行。
export function splitVisualizationContent(input = '', { streaming = false } = {}) {
  const text = String(input)
  const parts = []
  let plain = ''
  let fence = null
  let inline = 0
  const flush = () => { if (plain) parts.push({ type: 'markdown', text: plain }); plain = '' }
  for (let i = 0; i < text.length;) {
    if (i === 0 || text[i - 1] === '\n') {
      const line = text.slice(i, text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i) + 1)
      const match = line.trimEnd().match(/^ {0,3}(?:> ?)*(?:[-+*] |\d+[.)] )?(`{3,}|~{3,})(.*)$/)
      if (fence || match || /^(?: {4}|\t)/.test(line)) {
        if (fence && match && match[1][0] === fence[0] && match[1].length >= fence.length && !match[2].trim()) fence = null
        else if (!fence && match) fence = match[1]
        plain += line; i += line.length; inline = 0; continue
      }
    }
    if (text[i] === '\\') { plain += text.slice(i, i + 2); i += 2; continue }
    if (text[i] === '`') {
      const run = text.slice(i).match(/^`+/)[0]
      if (!inline) inline = run.length
      else if (inline === run.length) inline = 0
      plain += run; i += run.length; continue
    }
    if (!inline && text.startsWith(VISUALIZATION_START, i)) {
      const end = text.indexOf(END, i + VISUALIZATION_START.length)
      if (end < 0) {
        if (!streaming) { flush(); parts.push({ type: 'visualization-error', message: '图表引用不完整，请重新生成。' }) }
        break
      }
      flush()
      try {
        const data = JSON.parse(text.slice(i + VISUALIZATION_START.length, end))
        if (!data || typeof data.path !== 'string' || !data.path.trim() || data.path.length > 4096 || /[\u0000-\u001f]/.test(data.path)) throw new Error('invalid_path')
        const title = typeof data.title === 'string' ? data.title.trim().slice(0, 200) : ''
        parts.push({ type: 'visualization', path: data.path, title: title || data.path.split(/[\\/]/).pop() })
      } catch { parts.push({ type: 'visualization-error', message: '图表引用格式有误，请重新生成。' }) }
      i = end + END.length; continue
    }
    if (!inline && streaming && VISUALIZATION_START.startsWith(text.slice(i))) break
    plain += text[i++]
  }
  flush()
  return parts
}
