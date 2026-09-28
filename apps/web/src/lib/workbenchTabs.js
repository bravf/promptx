// 布局只保存视图标识，不保存会话内容、文件内容或远程访问凭证。
export const WORKBENCH_STORAGE_KEY = 'promptx:v2:workbench-tabs'
const uid = () => globalThis.crypto.randomUUID()
export function createGroup() { return { id: uid(), type: 'group', tabs: [], activeId: '' } }
export function createLayout() {
  const root = createGroup()
  return { root, focusedId: root.id }
}
export function groups(node) { return node.type === 'group' ? [node] : [...groups(node.first), ...groups(node.second)] }
export function findNode(node, id) {
  if (node.id === id) return node
  return node.type === 'split' ? findNode(node.first, id) || findNode(node.second, id) : null
}
export function tabId(tab) { return JSON.stringify([tab.type, tab.taskId || '', ['files', 'diff'].includes(tab.type) ? '' : tab.path || '']) }
export function openTab(layout, tab, groupId = layout.focusedId) {
  const hasPath = Object.hasOwn(tab, 'path')
  tab = { type: tab.type, taskId: tab.taskId || '', path: tab.path || '', ...(tab.line ? { line: tab.line } : {}) }
  const id = tabId(tab)
  const existing = groups(layout.root).find(group => group.tabs.some(item => item.id === id))
  const group = existing || findNode(layout.root, groupId) || groups(layout.root)[0]
  if (!existing) group.tabs.push({ ...tab, id })
  else {
    const current = group.tabs.find(item => item.id === id)
    if (hasPath) Object.assign(current, tab, { line: tab.line || null })
  }
  group.activeId = id
  layout.focusedId = group.id
  return id
}
function removeEmpty(node, id) {
  if (node.type !== 'split') return node
  if (node.first.id === id) return node.second
  if (node.second.id === id) return node.first
  node.first = removeEmpty(node.first, id)
  node.second = removeEmpty(node.second, id)
  return node
}
export function closeEmptyGroup(layout, id) {
  const group = findNode(layout.root, id)
  if (!group || group.type !== 'group' || group.tabs.length) return
  layout.root = removeEmpty(layout.root, id)
  if (!findNode(layout.root, layout.focusedId)) layout.focusedId = groups(layout.root)[0].id
}
export function closeTab(layout, id) {
  const group = groups(layout.root).find(group => group.tabs.some(tab => tab.id === id))
  if (!group) return
  const index = group.tabs.findIndex(tab => tab.id === id)
  group.tabs.splice(index, 1)
  if (group.activeId === id) group.activeId = group.tabs[Math.min(index, group.tabs.length - 1)]?.id || ''
  if (!group.tabs.length && groups(layout.root).length > 1) layout.root = removeEmpty(layout.root, group.id)
  if (!findNode(layout.root, layout.focusedId)) layout.focusedId = groups(layout.root)[0].id
}
export function splitGroup(layout, groupId, direction) {
  const group = findNode(layout.root, groupId)
  if (!group || group.type !== 'group') return null
  const old = { ...group }
  const next = createGroup()
  for (const key of Object.keys(group)) delete group[key]
  Object.assign(group, { id: uid(), type: 'split', axis: ['left', 'right'].includes(direction) ? 'x' : 'y', ratio: 0.5,
    first: ['left', 'top'].includes(direction) ? next : old,
    second: ['left', 'top'].includes(direction) ? old : next })
  layout.focusedId = next.id
  return next.id
}
export function moveTab(layout, id, targetId, direction = '', beforeId = '') {
  const source = groups(layout.root).find(group => group.tabs.some(tab => tab.id === id))
  let target = findNode(layout.root, targetId)
  if (!source || !target || target.type !== 'group') return
  if (source.id === target.id && (beforeId === id || (direction && source.tabs.length === 1))) return
  // 拆分会替换源节点；先记录标识，再重新获取源标签组。
  if (direction) target = findNode(layout.root, splitGroup(layout, targetId, direction))
  const from = groups(layout.root).find(group => group.tabs.some(tab => tab.id === id))
  const index = from.tabs.findIndex(tab => tab.id === id)
  const [tab] = from.tabs.splice(index, 1)
  const before = target.tabs.findIndex(tab => tab.id === beforeId)
  target.tabs.splice(before < 0 ? target.tabs.length : before, 0, tab)
  if (from.id !== target.id && from.activeId === id) from.activeId = from.tabs[Math.min(index, from.tabs.length - 1)]?.id || ''
  target.activeId = id
  layout.focusedId = target.id
  if (!from.tabs.length) layout.root = removeEmpty(layout.root, from.id)
}
export function layoutRects(root) {
  const leaves = [], dividers = []
  function walk(node, rect) {
    if (node.type === 'group') { leaves.push({ group: node, ...rect }); return }
    const { x, y, w, h } = rect
    dividers.push({ node, ...rect })
    if (node.axis === 'x') {
      walk(node.first, { x, y, w: w * node.ratio, h })
      walk(node.second, { x: x + w * node.ratio, y, w: w * (1 - node.ratio), h })
    } else {
      walk(node.first, { x, y, w, h: h * node.ratio })
      walk(node.second, { x, y: y + h * node.ratio, w, h: h * (1 - node.ratio) })
    }
  }
  walk(root, { x: 0, y: 0, w: 100, h: 100 })
  return { leaves, dividers }
}
export function restoreWorkbenchLayout(raw, tasks) {
  try {
    const saved = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (![1, 2].includes(saved?.version)) return null
    const taskIds = new Set(tasks.map(task => task.id))
    function sanitize(layout) {
      if (!layout?.root) return null
      const seen = new Map(), nodes = new Set()
      function restore(node, depth = 0) {
        if (!node || depth > 12 || typeof node.id !== 'string' || nodes.has(node.id)) return createGroup()
        nodes.add(node.id)
        if (node.type === 'split') return { id: node.id, type: 'split', axis: node.axis === 'y' ? 'y' : 'x', ratio: Math.max(0.15, Math.min(0.85, Number(node.ratio) || 0.5)), first: restore(node.first, depth + 1), second: restore(node.second, depth + 1) }
        const tabs = []
        let activeId = ''
        for (const tab of Array.isArray(node.tabs) ? node.tabs.slice(0, 100) : []) {
          if (!['session', 'files', 'diff', 'task-details', 'terminal', 'settings'].includes(tab?.type)) continue
          if (tab.type !== 'settings' && !taskIds.has(tab.taskId)) continue
          const clean = { type: tab.type, taskId: tab.type === 'settings' ? '' : tab.taskId, path: typeof tab.path === 'string' ? tab.path : '', ...(Number.isInteger(tab.line) && tab.line > 0 ? { line: tab.line } : {}) }
          clean.id = tabId(clean)
          if (tab.id === node.activeId) activeId = clean.id
          if (seen.has(clean.id)) {
            // 旧版单文件标签合并到文件浏览器，优先恢复原来正在看的文件。
            const existing = seen.get(clean.id)
            if (tab.id === node.activeId && node.id === layout.focusedId) {
              existing.tabs.splice(existing.tabs.indexOf(existing.tab), 1)
              tabs.push(clean)
              seen.set(clean.id, { tab: clean, tabs })
            } else if (tab.id === node.activeId) Object.assign(existing.tab, clean)
            continue
          }
          seen.set(clean.id, { tab: clean, tabs })
          tabs.push(clean)
        }
        return { id: node.id, type: 'group', tabs, activeId: tabs.some(tab => tab.id === activeId) ? activeId : tabs[0]?.id || '' }
      }
      const root = restore(layout.root)
      for (const group of groups(root)) if (!group.tabs.some(tab => tab.id === group.activeId)) group.activeId = group.tabs[0]?.id || ''
      return { root, focusedId: groups(root).some(group => group.id === layout.focusedId) ? layout.focusedId : groups(root)[0].id }
    }
    if (saved.version === 2) return sanitize(saved.layout)
    // 迁移旧版按工作区保存的布局：保留当前分屏，把其余工作区的标签一起带回。
    const entries = Object.entries(saved.layouts || {}).sort(([left], [right]) => Number(right === saved.activeWorkspaceId) - Number(left === saved.activeWorkspaceId))
    const restored = entries.map(([, layout]) => sanitize(layout)).filter(Boolean)
    if (!restored.length) return null
    const layout = restored[0]
    const target = findNode(layout.root, layout.focusedId)
    const seen = new Set(groups(layout.root).flatMap(group => group.tabs.map(tab => tab.id)))
    for (const other of restored.slice(1)) {
      for (const tab of groups(other.root).flatMap(group => group.tabs)) {
        if (seen.has(tab.id)) continue
        seen.add(tab.id)
        target.tabs.push(tab)
      }
    }
    if (!target.activeId) target.activeId = target.tabs[0]?.id || ''
    return layout
  } catch { return null }
}
