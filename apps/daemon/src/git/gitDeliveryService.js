import { canonicalPathKey } from '../paths/canonicalPath.js'
import { defaultBranch, listCommits, runGit } from '../environments/worktreeService.js'
import { getWorkspaceGitStatus } from '../workspaces/workspaceInspection.js'

function serviceError(code, message, statusCode = 409) {
  const error = new Error(message)
  error.code = code
  error.statusCode = statusCode
  return error
}

export class GitDeliveryService {
  constructor({ repository, agentManager, taskLifecycle }) {
    this.repository = repository
    this.agentManager = agentManager
    this.taskLifecycle = taskLifecycle
    this.repositoryLocks = new Set()
  }

  context(taskId) {
    const task = this.repository.getTask(taskId)
    if (!task) throw serviceError('task_not_found', '会话不存在。', 404)
    const current = {
      task,
      project: this.repository.getProject(task.projectId),
      environment: this.repository.getEnvironment(task.environmentId),
      agent: this.repository.getTaskAgent(task.id),
    }
    if (current.task.lifecycle !== 'active' || current.project?.lifecycle !== 'active') {
      throw serviceError('task_archived', '请先恢复工作区和会话。')
    }
    return current
  }

  async withRepositoryLock(root, callback) {
    const key = canonicalPathKey(root)
    if (this.repositoryLocks.has(key)) throw serviceError('repository_busy', '仓库正在执行其他 Git 操作。')
    this.repositoryLocks.add(key)
    try {
      return await callback()
    } finally {
      this.repositoryLocks.delete(key)
    }
  }

  async commit(taskId, message) {
    const current = this.context(taskId)
    return this.agentManager.runExclusive(current.agent.id, () => this.withRepositoryLock(current.environment.cwd, async () => {
      const status = await getWorkspaceGitStatus(current.environment.cwd)
      if (!status.files?.length) throw serviceError('worktree_clean', '没有需要提交的修改。')
      await runGit(current.environment.cwd, ['add', '--all'])
      await runGit(current.environment.cwd, ['commit', '-m', message])
      return listCommits(current.environment.cwd, 1)
    }))
  }

  async push(taskId) {
    const current = this.context(taskId)
    return this.agentManager.runExclusive(current.agent.id, () => this.withRepositoryLock(current.environment.cwd, async () => {
      const branchName = await defaultBranch(current.environment.cwd)
      if (branchName === 'HEAD') throw serviceError('branch_required', '请先切换到要推送的分支。')
      await runGit(current.environment.cwd, ['push', '-u', 'origin', `refs/heads/${branchName}:refs/heads/${branchName}`])
      this.repository.updateEnvironment(current.environment.id, { branchName })
      return branchName
    }))
  }

  async merge(taskId, { targetBranch, message, archive = true }) {
    const current = this.context(taskId)
    if (current.environment.kind !== 'worktree') throw serviceError('worktree_required', '只有 Worktree 会话可以合并。')
    return this.agentManager.runExclusive(current.agent.id, () => this.withRepositoryLock(current.project.repositoryRoot, async () => {
      const sourceStatus = await getWorkspaceGitStatus(current.environment.cwd)
      if (sourceStatus.files?.length) {
        const error = serviceError('worktree_dirty', '请先提交会话工作区中的修改，再执行合并。')
        error.git = sourceStatus
        throw error
      }
      const rootStatus = await getWorkspaceGitStatus(current.project.repositoryRoot)
      if (rootStatus.files?.length) {
        const error = serviceError('project_dirty', '目标工作区包含未提交修改。')
        error.git = rootStatus
        throw error
      }
      const sourceBranch = await defaultBranch(current.environment.cwd)
      if (sourceBranch === 'HEAD') throw serviceError('branch_required', 'Worktree 处于分离 HEAD，无法合并。')
      const currentTarget = await defaultBranch(current.project.repositoryRoot)
      if (currentTarget !== targetBranch) {
        throw serviceError('target_branch_not_checked_out', `请先在主工作区切换到 ${targetBranch} 分支。`)
      }
      const sourceCommit = await runGit(current.environment.cwd, ['rev-parse', 'HEAD'])
      try {
        await runGit(current.project.repositoryRoot, ['merge', '--no-ff', sourceCommit, '-m', message || `Merge ${sourceBranch}`])
      } catch {
        await runGit(current.project.repositoryRoot, ['merge', '--abort']).catch(() => {})
        throw serviceError('merge_failed', '合并失败，主工作区已恢复到合并前状态。')
      }
      this.repository.updateEnvironment(current.environment.id, { branchName: sourceBranch })
      const task = archive ? this.taskLifecycle.finalizeArchivedTask(taskId) : this.repository.getTask(taskId)
      return { sourceBranch, sourceCommit, targetBranch, task }
    }))
  }
}
