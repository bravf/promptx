export function isBackgroundTaskRunning(task) {
  return !task.ambient && ['running', 'pending'].includes(task.status)
}

export function sessionActivity(task) {
  const count = task?.backgroundTasks?.filter(isBackgroundTaskRunning).length || 0
  const foreground = ['running', 'stopping'].includes(task?.lifecycle)
  const running = foreground || count > 0
  return { running, foreground, count, label: foreground ? '执行中' : count ? `等待子任务 · ${count}` : task?.lastError || task?.attentionReason === 'error' ? '执行异常' : task?.backgroundTasks?.some(item => !item.ambient) ? '已结束' : '已连接' }
}

export function groupBackgroundTasks(tasks = []) {
  const groups = new Map()
  const byId = new Map(tasks.map(task => [task.id, task]))
  for (const task of tasks) {
    if (task.ambient) continue
    let owner = task
    const visited = new Set([task.id])
    while (byId.has(owner.parentTaskId) && !visited.has(owner.parentTaskId)) {
      owner = byId.get(owner.parentTaskId)
      visited.add(owner.id)
    }
    const key = owner.originTurnId || task.originTurnId || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(task)
  }
  return groups
}

export function buildBackgroundTaskTree(tasks = []) {
  const nodes = new Map(tasks.map(task => [task.id, { ...task, children: [] }]))
  const roots = []
  for (const node of nodes.values()) {
    let parent = nodes.get(node.parentTaskId)
    const visited = new Set([node.id])
    while (parent && !visited.has(parent.id)) {
      visited.add(parent.id)
      parent = nodes.get(parent.parentTaskId)
    }
    if (!parent && nodes.has(node.parentTaskId)) nodes.get(node.parentTaskId).children.push(node)
    else roots.push(node)
  }
  return roots
}
