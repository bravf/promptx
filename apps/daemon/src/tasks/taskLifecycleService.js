import fs from 'node:fs'
import path from 'node:path'
import { reconcileEnvironment } from '../environments/environmentReconcile.js'
import { removeStoredAssets } from '../assets/assetStorage.js'

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export class TaskLifecycleService {
  constructor({ repository, agentManager, assetsDir }) {
    this.repository = repository
    this.agentManager = agentManager
    this.assetsDir = assetsDir
  }

  context(taskId) {
    const task = this.repository.getTask(taskId)
    if (!task) throw serviceError('task_not_found', '会话不存在。', 404)
    return {
      task,
      project: this.repository.getProject(task.projectId),
      environment: this.repository.getEnvironment(task.environmentId),
      agent: this.repository.getTaskAgent(task.id),
    }
  }

  async archiveTask(taskId) {
    const current = this.context(taskId)
    return this.agentManager.interruptAndRunExclusive(current.agent?.id, () => this.finalizeArchivedTask(taskId))
  }

  finalizeArchivedTask(taskId) {
    const agent = this.repository.getTaskAgent(taskId)
    if (agent) this.agentManager.close(agent.id)
    return this.repository.archiveTask(taskId)
  }

  async archiveProject(projectId) {
    const project = this.repository.getProject(projectId)
    if (!project) throw serviceError('project_not_found', '工作区不存在。', 404)
    const agentIds = this.repository.listTasks(project.id)
      .map((task) => this.repository.getTaskAgent(task.id)?.id)
      .filter(Boolean)
    return this.agentManager.interruptAndRunExclusive(agentIds, () => this.repository.archiveProject(project.id))
  }

  restoreProject(projectId) {
    const project = this.repository.getProject(projectId)
    if (!project) throw serviceError('project_not_found', '工作区不存在。', 404)
    return this.repository.restoreProject(project.id)
  }

  async restoreTask(taskId) {
    const current = this.context(taskId)
    if (current.task.lifecycle !== 'archived') return current.task
    if (current.project.lifecycle !== 'active') {
      throw serviceError('project_archived', '请先恢复会话所属的工作区。')
    }
    const checked = await reconcileEnvironment(current.environment)
    const environment = this.repository.updateEnvironment(current.environment.id, { status: checked.status })
    if (environment.status === 'removed') {
      throw serviceError('environment_removed', 'Worktree 已清理，请复制到新的 Worktree 后继续。')
    }
    if (['missing', 'unavailable'].includes(environment.status)) {
      throw serviceError('environment_unavailable', '执行目录不可用，请先重新绑定目录。')
    }
    return this.repository.restoreTask(taskId)
  }

  async deleteTask(taskId) {
    const current = this.context(taskId)
    if (current.agent && this.agentManager.isBusy(current.agent.id)) throw serviceError('task_running', 'Agent 正在运行。')
    if (current.task.lifecycle !== 'archived') {
      throw serviceError('task_not_archived', '只能永久删除已归档的会话。')
    }
    if (current.environment.kind === 'worktree' && current.environment.ownership === 'promptx'
      && current.environment.status !== 'removed' && fs.existsSync(current.environment.cwd)) {
      throw serviceError('worktree_not_removed', '请先清理 PromptX 管理的 Worktree。')
    }
    if (current.agent) this.agentManager.close(current.agent.id)
    const assets = this.repository.listTaskAssets(taskId)
    this.repository.deleteTask(taskId)
    this.repository.deleteEnvironment(current.environment.id)
    removeStoredAssets(assets)
    fs.rmSync(path.join(this.assetsDir, taskId), { recursive: true, force: true })
  }
}
