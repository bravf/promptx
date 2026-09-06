import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { openDatabase } from '../db/database.js'
import { createRepository } from '../db/repository.js'
import { SessionImportService } from './sessionImport.js'

function setup({ loader, syncTimeline = async () => {} } = {}) {
  const db = openDatabase(':memory:')
  const repository = createRepository(db)
  const provider = { id: 'codex', label: 'Codex', capabilities: {} }
  const service = new SessionImportService({
    repository,
    providerRegistry: { list: () => [provider], get: () => provider },
    agentManager: { syncTimeline, close() {} },
    historyLoaders: { codex: loader },
    cacheTtlMs: 10_000,
  })
  return { db, repository, service }
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
}

test('导入列表在缓存期内合并 Provider 扫描并基于快照搜索', async () => {
  let scans = 0
  const loader = async () => {
    scans += 1
    return [{ providerId: 'codex', providerHandleId: 'thread-1', title: '缓存测试', cwd: process.cwd() }]
  }
  const { db, service } = setup({ loader })
  try {
    const [first, second] = await Promise.all([
      service.list({ query: '缓存' }),
      service.list({ query: 'thread-1' }),
    ])
    assert.equal(scans, 1)
    assert.equal(first.sessions.length, 1)
    assert.equal(second.sessions.length, 1)
  } finally {
    db.close()
  }
})

test('Provider 扫描失败会返回明确错误', async () => {
  const { db, service } = setup({ loader: async () => { throw new Error('Provider 不可用') } })
  try {
    const result = await service.list()
    assert.equal(result.sessions.length, 0)
    assert.deepEqual(result.errors, [{ providerId: 'codex', providerLabel: 'Codex', message: 'Provider 不可用' }])
  } finally {
    db.close()
  }
})

test('首次导入同步失败时清理新建的空项目', async () => {
  const loader = async () => [{ providerId: 'codex', providerHandleId: 'thread-1', title: '失败测试', cwd: process.cwd() }]
  const { db, repository, service } = setup({ loader, syncTimeline: async () => { throw new Error('同步失败') } })
  try {
    await assert.rejects(() => service.import({ providerId: 'codex', providerHandleId: 'thread-1' }), /同步失败/)
    assert.equal(repository.listAllAgents(true).length, 0)
    assert.equal(repository.listProjects().length, 0)
  } finally {
    db.close()
  }
})

test('导入 linked worktree 会话时归属主仓库项目', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-session-import-worktree-'))
  const projectRoot = path.join(root, 'project')
  const worktreeRoot = path.join(root, 'task')
  fs.mkdirSync(projectRoot)
  git(projectRoot, ['init'])
  git(projectRoot, ['config', 'user.email', 'promptx@example.test'])
  git(projectRoot, ['config', 'user.name', 'PromptX Test'])
  fs.writeFileSync(path.join(projectRoot, 'README.md'), '# PromptX\n')
  git(projectRoot, ['add', 'README.md'])
  git(projectRoot, ['commit', '-m', 'initial'])
  git(projectRoot, ['worktree', 'add', '-b', 'codex/task', worktreeRoot, 'HEAD'])

  const loader = async () => [{ providerId: 'codex', providerHandleId: 'thread-worktree', title: 'hello', cwd: worktreeRoot }]
  const { db, repository, service } = setup({ loader })
  try {
    const existingProject = repository.createProject({ repositoryRoot: projectRoot, displayName: '主项目' })
    const result = await service.import({ providerId: 'codex', providerHandleId: 'thread-worktree' })

    assert.equal(repository.listProjects().length, 1)
    assert.equal(result.project.id, existingProject.id)
    assert.equal(result.task.projectId, existingProject.id)
    assert.equal(result.environment.kind, 'worktree')
    assert.equal(result.environment.repositoryRoot, fs.realpathSync(projectRoot))
    assert.equal(result.environment.worktreePath, fs.realpathSync(worktreeRoot))
    assert.equal(result.environment.ownership, 'external')
    assert.equal(result.environment.branchName, 'codex/task')
  } finally {
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
