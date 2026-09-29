import { createToolPatch } from './toolDiff.js'

// 四种 Provider 的实时与历史共用；解析失败时保留原始文本。
export function toolObject(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value
  if (typeof value === 'string' && value.trim().startsWith('{')) {
    try { return toolObject(JSON.parse(value)) } catch { /* 原始参数交由详情展示 */ }
  }
  return {}
}

const names = { shell: '执行命令', read: '读取文件', write: '写入文件', edit: '修改文件', search: '搜索', fetch: '读取网页', sub_agent: '子任务', unknown: '工具调用' }
const aliases = {
  shell: ['bash', 'shell', 'exec_command', 'run_shell_command', 'shell_command', 'commandexecution', 'execute', 'terminal'],
  read: ['read', 'readfile', 'read_file', 'view_file', 'imageview'],
  write: ['write', 'writefile', 'write_file', 'create_file'],
  edit: ['edit', 'editfile', 'strreplacefile', 'multiedit', 'multi_edit', 'apply_patch', 'apply_diff', 'filechange', 'str_replace_editor'],
  search: ['grep', 'glob', 'search', 'searchfile', 'websearch', 'web_search', 'search_files'],
  fetch: ['webfetch', 'web_fetch', 'fetch', 'fetchurl'],
  sub_agent: ['agent', 'task', 'subagentactivity', 'collabagenttoolcall', 'spawn_agent', 'delegate'],
}
function kindFor(item, detail) {
  const keys = [detail.type, detail.kind, item.name?.split('__').at(-1)]
    .filter(Boolean).map(value => String(value).toLowerCase())
  for (const [kind, values] of Object.entries(aliases)) if (keys.some(key => values.includes(key))) return kind
  return 'unknown'
}
function clip(value, limit = 300) { return typeof value === 'string' ? value.slice(0, limit) : '' }
function fields(item) {
  const d = toolObject(item.detail)
  const rawInput = d.input ?? d.rawInput ?? d.arguments
  const input = toolObject(rawInput)
  return { d, rawInput, input, kind: kindFor(item, d) }
}
export function toolSummary(item) {
  const { d, input, kind } = fields(item)
  const paths = []
  const add = source => {
    if (!source || paths.length >= 3) return
    const path = source.path || source.filePath || source.file_path || source.target
    if (typeof path !== 'string' || paths.some(entry => entry.path === path)) return
    // 超长路径在详情中查看；不要产生指向被截断路径的错误链接。
    if (path.length > 200) return
    const line = Number(source.line ?? source.lineNumber ?? source.startLine ?? source.start_line)
    paths.push({ path, ...(Number.isInteger(line) && line > 0 ? { line } : {}) })
  }
  add(d); add(input)
  for (const list of [d.locations, d.changes, d.files, d.content]) {
    if (Array.isArray(list)) for (const value of list) { add(value); if (paths.length >= 3) break }
  }
  const command = clip(d.command || input.command || input.cmd)
  const summary = clip(input.description || d.description || command || paths[0]?.path || input.pattern || input.query || d.query || input.url || d.url || input.prompt || (kind === 'unknown' ? item.name : ''))
  return {
    type: clip(d.type || 'unknown', 60), kind, displayName: names[kind], summary,
    ...(command ? { command } : {}), ...(paths.length ? { paths } : {}), hasDetails: true,
  }
}

// 二进制内容不能混进日志正文或 Relay 文本响应。资源仍通过现有文件预览入口打开。
export function toolText(value) {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(toolText).filter(Boolean).join('\n')
  if (value.type === 'text') return String(value.text || '')
  if (value.type === 'content') return toolText(value.content)
  return JSON.stringify(value, (key, entry) => {
    if (['data', 'base64', 'bytes'].includes(key) && typeof entry === 'string' && entry.length > 1024) return '[二进制内容省略，请使用文件预览]'
    if (typeof entry === 'string' && entry.startsWith('data:') && entry.length > 1024) return '[内嵌资源省略，请使用文件预览]'
    return entry
  }, 2)
}

export function toolSections(item) {
  const { d, input, rawInput, kind } = fields(item)
  const sections = []
  const add = (id, title, value, format = 'text', hints = {}) => {
    if (value === undefined || value === null) return
    sections.push({ id, title, format, ...hints, text: toolText(value) })
  }
  const command = d.command || input.command || input.cmd
  if (command) add('command', '命令', command, 'code')
  const cwd = d.cwd || input.cwd || input.workdir
  if (cwd) add('cwd', '工作目录', cwd)
  const filePath = input.file_path || input.filePath || input.path || d.path || d.filePath || d.locations?.[0]?.path || ''
  const fileHint = typeof filePath === 'string' ? { filePath: filePath.slice(-512) } : {}
  if (kind === 'write') add('written', '本次写入内容', input.content ?? input.contents, 'code', fileHint)
  const content = Array.isArray(d.content) ? d.content : []
  const diffs = content.filter(block => block.type === 'diff')
  const patch = input.patch ?? input.diff ?? d.diff
  const changes = Array.isArray(d.changes) ? d.changes : []
  if (changes.length) add('changes', '本次文件修改', changes.map(change => {
    const patch = change.diff ?? change.patch
    return patch != null ? `${change.path || change.filePath || ''}\n${toolText(patch)}` : toolText(change)
  }).join('\n\n'), 'diff')
  else if (patch != null) add('patch', '本次修改', patch, 'diff')
  else if (diffs.length) add('diffs', '本次修改（修改片段）', diffs.map(block => {
    const heading = `${block.path || ''}\n`
    if (block.oldText != null && block.newText != null) return heading + createToolPatch(block.oldText, block.newText)
    return heading + `仅提供${block.oldText != null ? '修改前' : '修改后'}内容\n${block.oldText ?? block.newText ?? ''}`
  }).join('\n\n'), diffs.every(block => block.oldText != null && block.newText != null) ? 'diff' : 'text')
  else if (kind === 'edit') {
    const oldText = input.old_string ?? input.oldText ?? input.old_str
    const newText = input.new_string ?? input.newText ?? input.new_str
    if (oldText != null && newText != null) add('patch', '本次修改（修改片段）', createToolPatch(oldText, newText), 'diff')
    else if (oldText != null) add('before', '修改前（仅提供单边内容）', oldText, 'code', fileHint)
    else if (newText != null) add('after', '修改后（仅提供单边内容）', newText, 'code', fileHint)
  }
  // 已展示的正文不再在参数区重复一遍；其余参数完整保留。
  const params = { ...input }
  for (const key of ['command', 'cmd', 'cwd', 'workdir']) delete params[key]
  if (kind === 'write') for (const key of ['content', 'contents']) delete params[key]
  if (kind === 'edit') for (const key of ['old_string', 'oldText', 'old_str', 'new_string', 'newText', 'new_str', 'patch', 'diff']) delete params[key]
  if (toolSummary(item).paths?.length) for (const key of ['path', 'filePath', 'file_path', 'target']) delete params[key]
  if (Object.keys(params).length) add('input', '输入参数', params, 'json')
  else if (rawInput != null && !Object.keys(input).length) add('input', '输入参数', rawInput)
  const output = d.aggregatedOutput ?? d.output ?? d.rawOutput ?? d.result ?? (d.content !== undefined ? Array.isArray(d.content) ? content.filter(block => block.type !== 'diff') : d.content : undefined)
  if (output !== undefined && output !== null) add('output', '执行结果', output, kind === 'read' && filePath ? 'code' : kind === 'search' || /(?:^|[\s;|"'])rg\s|(?:^|[\s;|"'])grep\s/.test(command || '') ? 'search' : 'text', { ...(kind === 'read' ? fileHint : {}), ...(kind === 'search' && typeof input.pattern === 'string' && input.pattern.length <= 256 ? { matchText: input.pattern } : {}) })
  if (item.error || d.error) add('error', '错误', item.error?.message || item.error || d.error)
  if (d.exitCode != null) add('exit', '退出码', String(d.exitCode))
  if (d.durationMs != null) add('duration', '耗时（毫秒）', String(d.durationMs))
  if (kind === 'unknown' || !sections.length) {
    const extra = { ...d }
    for (const key of ['type', 'input', 'rawInput', 'arguments', 'output', 'rawOutput', 'result', 'aggregatedOutput', 'content', 'outputDelta']) delete extra[key]
    if (Object.keys(extra).length) add('extra', '调用信息', extra, 'json')
  }
  return { kind, sections, hasChanges: sections.some(section => ['patch', 'changes', 'diffs', 'written'].includes(section.id)), resultState: output == null ? 'missing' : toolText(output) === '' ? 'empty' : 'available' }
}

export function mergeToolDetails(previous, next) {
  const detail = { ...previous?.detail, ...next.detail }
  if (next.detail?.outputDelta !== undefined) {
    detail.aggregatedOutput = `${previous?.detail?.aggregatedOutput || ''}${next.detail.outputDelta}`
    delete detail.outputDelta
  }
  return { ...previous, ...next, detail, ...(previous?.error && !next.error ? { error: previous.error } : {}) }

}

export function codexToolStatus(item, fallback = 'running') {
  if (['failed', 'error'].includes(item.status) || item.error || (item.exitCode != null && item.exitCode !== 0)) return 'failed'
  if (['declined', 'canceled', 'cancelled', 'interrupted'].includes(item.status)) return 'canceled'
  if (item.status === 'completed') return 'completed'
  return fallback
}
