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
  for (const task of tasks) {
    if (task.ambient) continue
    const key = task.originTurnId || ''
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(task)
  }
  return groups
}
