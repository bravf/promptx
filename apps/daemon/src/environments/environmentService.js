import fs from 'node:fs'
import { resolveExistingDirectory } from '../paths/canonicalPath.js'
import { reconcileEnvironment } from './environmentReconcile.js'
import { removeWorktree, worktreeRemovalRisk } from './worktreeService.js'

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export class EnvironmentService {
  constructor({ repository, agentManager }) {
    this.repository = repository
    this.agentManager = agentManager
  }

  context(taskId) {
    const task = this.repository.getTask(taskId)
    if (!task) throw serviceError('task_not_found', '会话不存在。', 404)
    return {
      task,
      environment: this.repository.getEnvironment(task.environmentId),
      agent: this.repository.getTaskAgent(task.id),
    }
  }

  async reconcile(taskId) {
    const current = this.context(taskId)
    const checked = await reconcileEnvironment(current.environment)
    const environment = this.repository.updateEnvironment(current.environment.id, { status: checked.status })
    if (['missing', 'removed', 'unavailable'].includes(environment.status) && !this.agentManager.isBusy(current.agent.id)) {
      this.agentManager.close(current.agent.id)
    }
    return environment
  }

  async rebind(taskId, input) {
    const current = this.context(taskId)
    const cwd = resolveExistingDirectory(input.cwd)
    const repositoryRoot = input.repositoryRoot === undefined
      ? current.environment.repositoryRoot
      : resolveExistingDirectory(input.repositoryRoot)
    return this.agentManager.runExclusive(current.agent.id, async () => {
      this.agentManager.close(current.agent.id)
      return this.repository.rebindEnvironment(current.environment.id, {
        cwd,
        repositoryRoot,
        kind: 'local',
        ownership: 'external',
        status: 'ready',
      })
    })
  }

  async removeManagedWorktree(taskId, { force = false } = {}) {
    const current = this.context(taskId)
    if (current.task.lifecycle !== 'archived') throw serviceError('task_not_archived', '请先归档会话。')
    if (current.environment.kind !== 'worktree' || current.environment.ownership !== 'promptx') {
      throw serviceError('worktree_not_owned', 'PromptX 只能清理自己创建的 Worktree。')
    }
    if (current.environment.status === 'removed') return current.environment
    return this.agentManager.runExclusive(current.agent.id, async () => {
      let risk = { dirty: false, files: [], unpushedCommits: 0 }
      if (fs.existsSync(current.environment.cwd)) risk = await worktreeRemovalRisk(current.environment)
      if ((risk.dirty || risk.unpushedCommits) && !force) {
        const error = serviceError('worktree_has_changes', 'Worktree 包含未提交或未推送的修改。')
        error.risk = risk
        throw error
      }
      if (fs.existsSync(current.environment.cwd)) {
        await removeWorktree(current.environment.repositoryRoot, current.environment.worktreePath || current.environment.cwd, force)
      }
      this.agentManager.close(current.agent.id)
      return this.repository.updateEnvironment(current.environment.id, { status: 'removed' })
    })
  }
}
