// 原生调用身份优先于事件到达时的活跃轮次；子任务继承父任务的发起轮次。
export function resolveBackgroundTaskOwnership(tasks, callTurns = new Map()) {
  const byId = new Map(tasks.map(task => [task.id, { ...task }]))
  const byCall = new Map(tasks.filter(task => task.callId).map(task => [task.callId, task.id]))
  const resolve = (task, visiting = new Set()) => {
    if (visiting.has(task.id)) return null
    visiting.add(task.id)
    const parentId = task.parentTaskId || byCall.get(task.parentCallId)
    const parent = parentId && byId.get(parentId)
    if (parent && !visiting.has(parent.id)) {
      task.parentTaskId = parent.id
      task.originTurnId = resolve(parent, visiting)
    } else if (task.parentCallId || task.parentTaskId) {
      task.originTurnId = null
    } else {
      task.originTurnId = callTurns.get(task.callId) || task.originTurnId || null
    }
    visiting.delete(task.id)
    return task.originTurnId
  }
  for (const task of byId.values()) resolve(task)
  return [...byId.values()]
}
