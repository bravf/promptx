// 原生任务属于会话，不能随一次回复结束清空。只记录协议明确声明的任务。
export class BackgroundTasks {
  constructor(runtime) {
    this.runtime = runtime
    this.tasks = new Map()
  }

  update(patch) {
    if (!patch.id) return
    const previous = this.tasks.get(patch.id)
    const next = { ...previous, ...patch }
    if (JSON.stringify(previous) === JSON.stringify(next)) return
    this.tasks.set(next.id, next)
    this.runtime.emit('backgroundTask', next)
  }

  get running() {
    return [...this.tasks.values()].filter(task => ['running', 'pending'].includes(task.status) && !task.ambient)
  }

  interrupt(summary = '运行时已关闭，后台任务已中断') {
    for (const task of this.running) this.update({ id: task.id, status: 'interrupted', summary })
  }
}

export function taskStatus(status) {
  return ({ pending: 'running', paused: 'running', killed: 'canceled', stopped: 'canceled', interrupted: 'canceled', errored: 'failed', shutdown: 'canceled', notFound: 'interrupted', completed: 'completed', failed: 'failed', running: 'running' })[status] || 'running'
}
