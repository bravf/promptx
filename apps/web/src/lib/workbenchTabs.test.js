import assert from 'node:assert/strict'
import test from 'node:test'
import { closeEmptyGroup, closeTab, createLayout, findNode, groups, layoutRects, moveTab, openTab, restoreWorkbenchLayout, splitGroup } from './workbenchTabs.js'

test('同一会话的文件共用浏览标签，并保留最新路径和行号', () => {
  const layout = createLayout()
  const first = openTab(layout, { type: 'files', taskId: 'a', path: 'src/a.js', line: 1 })
  openTab(layout, { type: 'files', taskId: 'a', path: 'src/b.js', line: 20 })
  assert.equal(layout.root.tabs.length, 1)
  assert.equal(layout.root.activeId, first)
  assert.equal(layout.root.tabs[0].line, 20)
  assert.equal(layout.root.tabs[0].path, 'src/b.js')
  openTab(layout, { type: 'files', taskId: 'a' })
  assert.equal(layout.root.tabs[0].path, 'src/b.js')
})

test('混合拆分、跨区移动和关闭标签保持树完整且不丢失其他标签', () => {
  const layout = createLayout()
  const a = openTab(layout, { type: 'session', taskId: 'a' })
  const b = openTab(layout, { type: 'session', taskId: 'b' })
  const origin = layout.root.id
  moveTab(layout, b, origin, 'right')
  const right = layout.focusedId
  const settings = openTab(layout, { type: 'settings' })
  moveTab(layout, settings, right, 'bottom')
  assert.equal(groups(layout.root).length, 3)
  const geometry = layoutRects(layout.root)
  assert.equal(geometry.leaves.reduce((area, rect) => area + rect.w * rect.h, 0), 10000)
  moveTab(layout, a, right)
  assert.equal(groups(layout.root).length, 2)
  assert.equal(findNode(layout.root, right).tabs.length, 2)
  closeTab(layout, settings)
  assert.equal(layout.root.type, 'group')
  assert.equal(layout.focusedId, right)
  closeTab(layout, a)
  assert.equal(layout.root.activeId, b)
  closeTab(layout, b)
  assert.equal(layout.root.tabs.length, 0)
})

test('同组重排、单标签拆分和空分区关闭', () => {
  const layout = createLayout()
  const a = openTab(layout, { type: 'session', taskId: 'a' })
  moveTab(layout, a, layout.root.id, 'top')
  assert.equal(groups(layout.root).length, 1)
  const b = openTab(layout, { type: 'session', taskId: 'b' })
  moveTab(layout, b, layout.root.id, '', a)
  assert.deepEqual(layout.root.tabs.map(tab => tab.id), [b, a])
  const empty = splitGroup(layout, layout.root.id, 'left')
  assert.equal(groups(layout.root).length, 2)
  closeEmptyGroup(layout, empty)
  assert.equal(groups(layout.root).length, 1)
})

test('全局布局恢复保留跨工作区会话、分区比例并清理过期会话', () => {
  const layout = createLayout()
  openTab(layout, { type: 'session', taskId: 'a' })
  splitGroup(layout, layout.root.id, 'bottom')
  openTab(layout, { type: 'session', taskId: 'deleted' })
  openTab(layout, { type: 'session', taskId: 'other' })
  openTab(layout, { type: 'settings', content: '不应持久化的内容' })
  layout.root.ratio = 0.67
  const restored = restoreWorkbenchLayout({ version: 2, layout }, [{ id: 'a', projectId: 'p' }, { id: 'other', projectId: 'q' }])
  assert.equal(restored.root.ratio, 0.67)
  const tabs = groups(restored.root).flatMap(group => group.tabs)
  assert.equal(tabs.length, 3)
  assert.equal(tabs[1].taskId, 'other')
  assert.equal(tabs[2].content, undefined)
  assert.equal(restoreWorkbenchLayout('{', []), null)
})

test('迁移旧布局保留当前分屏、合并其他工作区标签及独立文件预览', () => {
  const first = createLayout(), second = createLayout()
  openTab(first, { type: 'session', taskId: 'a' })
  const fileGroupId = splitGroup(first, first.root.id, 'right')
  const fileGroup = findNode(first.root, fileGroupId)
  fileGroup.tabs = [
    { id: 'files-list', type: 'files', taskId: 'a', path: '' },
    { id: 'preview-a', type: 'files', taskId: 'a', path: 'a.js' },
    { id: 'preview-b', type: 'files', taskId: 'a', path: 'b.js', line: 7 },
  ]
  fileGroup.activeId = 'preview-b'
  openTab(second, { type: 'session', taskId: 'b' })
  openTab(second, { type: 'settings' })
  const restored = restoreWorkbenchLayout({ version: 1, activeWorkspaceId: 'p', layouts: { q: second, p: first } }, [{ id: 'a', projectId: 'p' }, { id: 'b', projectId: 'q' }])
  assert.equal(restored.root.type, 'split')
  assert.equal(restored.focusedId, first.focusedId)
  const tabs = groups(restored.root).flatMap(group => group.tabs)
  assert.equal(tabs.length, 4)
  assert.equal(tabs.filter(tab => tab.type === 'files').length, 1)
  assert.equal(tabs.find(tab => tab.type === 'files').path, 'b.js')
  assert.equal(tabs.find(tab => tab.type === 'files').line, 7)
  assert.ok(tabs.some(tab => tab.taskId === 'b'))
})


test('旧文件预览位于另一分区时，在原聚焦分区恢复浏览器和选中文件', () => {
  const layout = createLayout()
  openTab(layout, { type: 'files', taskId: 'a' })
  const selectedGroupId = splitGroup(layout, layout.root.id, 'right')
  const selectedGroup = findNode(layout.root, selectedGroupId)
  selectedGroup.tabs = [{ id: 'old-preview', type: 'files', taskId: 'a', path: 'src/a.js' }]
  selectedGroup.activeId = 'old-preview'
  const restored = restoreWorkbenchLayout({ version: 1, activeWorkspaceId: 'p', layouts: { p: layout } }, [{ id: 'a', projectId: 'p' }])
  const focused = findNode(restored.root, restored.focusedId)
  assert.equal(focused.id, selectedGroupId)
  assert.equal(focused.tabs.length, 1)
  assert.equal(focused.tabs[0].path, 'src/a.js')
  assert.equal(focused.activeId, focused.tabs[0].id)
  assert.equal(groups(restored.root).flatMap(group => group.tabs).length, 1)
})
