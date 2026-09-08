import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { createApp } from '../app.js'

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}

async function fixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-qa-boundary-')))
  const workspace = path.join(root, 'workspace')
  const remote = path.join(root, 'remote.git')
  fs.mkdirSync(workspace)
  git(workspace, 'init', '-b', 'main')
  git(workspace, 'config', 'user.name', 'PromptX QA')
  git(workspace, 'config', 'user.email', 'qa@promptx.local')
  git(workspace, 'config', 'core.autocrlf', 'false')
  fs.writeFileSync(path.join(workspace, 'note.txt'), 'initial\n')
  git(workspace, 'add', '.')
  git(workspace, 'commit', '-m', 'initial')
  git(root, 'init', '--bare', remote)
  git(workspace, 'remote', 'add', 'origin', remote)
  git(workspace, 'push', '-u', 'origin', 'main')
  const previousWorktrees = process.env.PROMPTX_WORKTREES_DIR
  process.env.PROMPTX_WORKTREES_DIR = path.join(root, 'worktrees')
  const app = await createApp({
    databasePath: ':memory:', assetsDir: path.join(root, 'uploads'),
    logger: false, webRoot: false, relay: false,
    relayOptions: { configPath: path.join(root, 'relay.json'), identityPath: path.join(root, 'identity.json') },
  })
  t.after(async () => {
    await app.close()
    if (previousWorktrees === undefined) delete process.env.PROMPTX_WORKTREES_DIR
    else process.env.PROMPTX_WORKTREES_DIR = previousWorktrees
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(`${fs.realpathSync.native(os.tmpdir())}${path.sep}`))
    await fs.promises.rm(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  })
  const projectResponse = await app.inject({ method: 'POST', url: '/api/v2/projects', payload: { repositoryRoot: workspace } })
  assert.equal(projectResponse.statusCode, 201)
  const project = projectResponse.json().project
  async function createTask(payload = {}) {
    return app.inject({ method: 'POST', url: `/api/v2/projects/${project.id}/tasks`, payload: { providerId: 'codex', ...payload } })
  }
  const response = await createTask()
  assert.equal(response.statusCode, 201)
  const local = response.json()
  return { root, workspace, remote, app, project, local, createTask }
}

test('QA-GIT-01 Worktree 提交、推送、合并和归档完整链路', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'qa-workflow' })
  assert.equal(created.statusCode, 201, created.body)
  const { task, environment } = created.json()
  fs.writeFileSync(path.join(environment.cwd, 'feature.txt'), 'feature\n')
  const commit = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/commit`, payload: { message: 'QA feature' } })
  assert.equal(commit.statusCode, 200, commit.body)
  assert.equal(commit.json().commits[0].subject, 'QA feature')
  const push = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/push` })
  assert.equal(push.statusCode, 200, push.body)
  assert.equal(git(f.remote, 'rev-parse', environment.branchName), git(environment.cwd, 'rev-parse', 'HEAD'))
  const merge = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
  assert.equal(merge.statusCode, 200, merge.body)
  assert.equal(merge.json().task.lifecycle, 'archived')
  assert.equal(fs.readFileSync(path.join(f.workspace, 'feature.txt'), 'utf8'), 'feature\n')
  assert.equal(git(f.workspace, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ').length, 3)
})

test('QA-GIT-02 当前目录会话可以推送已有跟踪分支', async (t) => {
  const f = await fixture(t)
  fs.appendFileSync(path.join(f.workspace, 'note.txt'), 'local change\n')
  const commit = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/git/commit`, payload: { message: 'local commit' } })
  assert.equal(commit.statusCode, 200)
  const push = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/git/push` })
  assert.equal(push.statusCode, 200, push.body)
  assert.equal(git(f.remote, 'rev-parse', 'main'), git(f.workspace, 'rev-parse', 'HEAD'))
})

test('QA-GIT-03 合并前拒绝源 Worktree 的未提交修改', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'dirty-source' })
  assert.equal(created.statusCode, 201)
  const { task, environment } = created.json()
  fs.appendFileSync(path.join(environment.cwd, 'note.txt'), 'not committed\n')
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(f.app.sqliteRepository.getTask(task.id).lifecycle, 'active')
})

test('QA-GIT-04 合并前拒绝目标工作区未提交修改', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'dirty-target' })
  const { task } = created.json()
  fs.appendFileSync(path.join(f.workspace, 'note.txt'), 'target dirty\n')
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
  assert.equal(response.statusCode, 409)
  assert.equal(response.json().error, 'project_dirty')
})

test('QA-GIT-05 空提交和非法提交说明被拒绝', async (t) => {
  const f = await fixture(t)
  const url = `/api/v2/tasks/${f.local.task.id}/git/commit`
  assert.equal((await f.app.inject({ method: 'POST', url, payload: { message: 'empty' } })).statusCode, 409)
  for (const message of ['', ' ', 'a'.repeat(201)]) {
    assert.equal((await f.app.inject({ method: 'POST', url, payload: { message } })).statusCode, 400)
  }
})

test('归档保留历史，PromptX Worktree 清理后才允许永久删除', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'archive-cleanup' })
  assert.equal(created.statusCode, 201, created.body)
  const { task, environment } = created.json()
  f.app.sqliteRepository.appendTimeline(task.id, null, { type: 'assistant_message', messageId: 'archive-message', phase: 'final_answer', text: '保留我' })

  assert.equal((await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/archive` })).statusCode, 200)
  assert.equal(f.app.sqliteRepository.listTimelineRows(task.id).length, 1)
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v2/tasks/${task.id}` })).statusCode, 409)

  fs.writeFileSync(path.join(environment.cwd, 'pending.txt'), '尚未提交\n')
  const guarded = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: {} })
  assert.equal(guarded.statusCode, 409, guarded.body)
  assert.equal(guarded.json().error, 'worktree_has_changes')
  assert.equal(guarded.json().risk.dirty, true)

  git(environment.cwd, 'add', 'pending.txt')
  git(environment.cwd, 'commit', '-m', 'local only')
  const unpushed = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: {} })
  assert.equal(unpushed.statusCode, 409, unpushed.body)
  assert.equal(unpushed.json().risk.dirty, false)
  assert.equal(unpushed.json().risk.unpushedCommits, 1)

  const removed = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: { force: true } })
  assert.equal(removed.statusCode, 200, removed.body)
  assert.equal(removed.json().environment.status, 'removed')
  assert.equal(fs.existsSync(environment.cwd), false)
  assert.equal(f.app.sqliteRepository.getTask(task.id).lifecycle, 'archived')
  assert.equal(f.app.sqliteRepository.listTimelineRows(task.id).length, 1)
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v2/tasks/${task.id}` })).statusCode, 204)
})

test('归档工作区只隐藏工作区，恢复后保留会话原生命周期', async (t) => {
  const f = await fixture(t)
  const second = await f.createTask()
  assert.equal(second.statusCode, 201)
  const archived = await f.app.inject({ method: 'POST', url: `/api/v2/projects/${f.project.id}/archive` })
  assert.equal(archived.statusCode, 200, archived.body)
  assert.equal(archived.json().project.lifecycle, 'archived')
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v2/projects' })).json().projects.length, 0)
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v2/tasks/archived' })).json().tasks.length, 0)
  const archivedProjects = await f.app.inject({ method: 'GET', url: '/api/v2/projects/archived' })
  assert.equal(archivedProjects.json().projects[0].activeTaskCount, 2)

  const restored = await f.app.inject({ method: 'POST', url: `/api/v2/projects/${f.project.id}/restore` })
  assert.equal(restored.statusCode, 200, restored.body)
  assert.equal(restored.json().project.lifecycle, 'active')
  assert.equal((await f.app.inject({ method: 'GET', url: '/api/v2/projects' })).json().projects.length, 1)
  assert.equal((await f.app.inject({ method: 'GET', url: `/api/v2/projects/${f.project.id}/tasks` })).json().tasks.length, 2)
})

test('QA-INPUT-01 非法 Worktree 名称应返回 400 且不创建记录', async (t) => {
  const f = await fixture(t)
  const response = await f.createTask({ executionKind: 'worktree', slug: '../escape' })
  assert.equal(f.app.sqliteRepository.listTasks(f.project.id).length, 1)
  assert.equal(response.statusCode, 400, response.body)
})

test('QA-INPUT-02 未知 Provider 应返回客户端错误', async (t) => {
  const f = await fixture(t)
  const response = await f.createTask({ providerId: 'not-a-provider' })
  assert.equal(response.statusCode, 400, response.body)
})

test('QA-INPUT-03 重绑到普通文件应拒绝并保持原执行目录', async (t) => {
  const f = await fixture(t)
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/environment/rebind`, payload: { cwd: path.join(f.workspace, 'note.txt') } })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(f.app.sqliteRepository.getEnvironment(f.local.environment.id).cwd, f.workspace)
})

test('QA-INPUT-04 已有目录会话不接受普通文件作为 cwd', async (t) => {
  const f = await fixture(t)
  const response = await f.createTask({ executionKind: 'existing', cwd: path.join(f.workspace, 'note.txt') })
  assert.equal(response.statusCode, 400, response.body)
})

test('QA-INPUT-05 工作区更新拒绝对象类型的名称', async (t) => {
  const f = await fixture(t)
  const response = await f.app.inject({ method: 'PATCH', url: `/api/v2/projects/${f.project.id}`, payload: { displayName: {} } })
  assert.equal(response.statusCode, 400, response.body)
})

test('QA-FILE-01 非 Git 目录的 API 可正常返回不可用状态', async (t) => {
  const f = await fixture(t)
  const plain = path.join(f.root, 'plain')
  fs.mkdirSync(plain)
  await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/environment/rebind`, payload: { cwd: plain } })
  const response = await f.app.inject({ method: 'GET', url: `/api/v2/tasks/${f.local.task.id}/git/status` })
  assert.equal(response.statusCode, 200)
  assert.equal(response.json().git.available, false)
})

test('QA-FILE-02 Windows junction 不允许逃出执行目录', async (t) => {
  const f = await fixture(t)
  const outside = path.join(f.root, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'QA synthetic secret')
  fs.symlinkSync(outside, path.join(f.workspace, 'junction'), process.platform === 'win32' ? 'junction' : 'dir')
  const response = await f.app.inject({ method: 'GET', url: `/api/v2/tasks/${f.local.task.id}/file?path=junction/secret.txt` })
  assert.equal(response.statusCode, 403, response.body)
})

test('QA-ASSET-01 后端拒绝超过 50 MB 的附件且无残留', async (t) => {
  const f = await fixture(t)
  const boundary = 'qa-upload-boundary'
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="large.bin"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    Buffer.alloc(50 * 1024 * 1024 + 1),
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ])
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/assets`, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` }, payload })
  assert.equal(response.statusCode, 413, response.body)
  assert.deepEqual(f.app.sqliteRepository.listTaskAssets(f.local.task.id), [])
  assert.deepEqual(fs.readdirSync(path.join(f.root, 'uploads', f.local.task.id)), [])
})

test('QA-ORIGIN-01 非授权来源的写操作被拒绝且无新增记录', async (t) => {
  const f = await fixture(t)
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/projects/${f.project.id}/tasks`, headers: { origin: 'https://qa-untrusted.example' }, payload: { providerId: 'codex' } })
  assert.equal(response.statusCode, 403)
  assert.equal(f.app.sqliteRepository.listTasks(f.project.id).length, 1)
})

test('自定义监听端口允许本地写入、预检和 SSE，拒绝伪造 Host 来源', async (t) => {
  const f = await fixture(t)
  await f.app.listen({ host: '127.0.0.1', port: 0 })
  const origin = `http://127.0.0.1:${f.app.server.address().port}`
  const response = await fetch(`${origin}/api/v2/projects`, {
    method: 'POST', headers: { origin, 'content-type': 'application/json' },
    body: JSON.stringify({ repositoryRoot: f.workspace }),
  })
  assert.equal(response.status, 201)
  assert.equal(response.headers.get('access-control-allow-origin'), origin)
  await response.arrayBuffer()
  const preflight = await f.app.inject({ method: 'OPTIONS', url: '/api/v2/projects', headers: { origin, 'access-control-request-method': 'PATCH' } })
  assert.equal(preflight.statusCode, 204)
  assert.match(preflight.headers['access-control-allow-methods'], /PATCH/)
  const controller = new AbortController()
  try {
    const events = await fetch(`${origin}/api/v2/events`, { headers: { origin }, signal: controller.signal })
    assert.equal(events.status, 200)
    assert.equal(events.headers.get('access-control-allow-origin'), origin)
    await events.body.cancel()
  } finally {
    controller.abort()
  }
  const forged = await f.app.inject({ method: 'POST', url: '/api/v2/projects', headers: {
    origin: `http://evil.example:${f.app.server.address().port}`, host: `evil.example:${f.app.server.address().port}`,
    'x-forwarded-host': 'evil.example',
  }, payload: { repositoryRoot: f.workspace } })
  assert.equal(forged.statusCode, 403)
})

test('推送使用切换后的真实分支，分离 HEAD 时拒绝推送', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'original-branch' })
  assert.equal(created.statusCode, 201)
  const { task, environment } = created.json()
  git(environment.cwd, 'checkout', '-b', 'renamed-branch')
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/push` })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().branchName, 'renamed-branch')
  assert.equal(git(f.remote, 'rev-parse', 'renamed-branch'), git(environment.cwd, 'rev-parse', 'HEAD'))
  assert.equal(git(f.remote, 'for-each-ref', '--format=%(refname)', `refs/heads/${environment.branchName}`), '')
  git(environment.cwd, 'checkout', '--detach')
  const detached = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/push` })
  assert.equal(detached.statusCode, 409)
  assert.equal(detached.json().error, 'branch_required')
})

test('源 Worktree 的未跟踪和已暂存修改都阻止合并且不改变目标提交', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'pending-files' })
  const { task, environment } = created.json()
  const head = git(f.workspace, 'rev-parse', 'HEAD')
  fs.writeFileSync(path.join(environment.cwd, 'pending.txt'), 'not delivered\n')
  for (const staged of [false, true]) {
    if (staged) git(environment.cwd, 'add', 'pending.txt')
    const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
    assert.equal(response.statusCode, 409, response.body)
    assert.equal(response.json().error, 'worktree_dirty')
    assert.equal(f.app.sqliteRepository.getTask(task.id).lifecycle, 'active')
    assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), head)
  }
})

test('无效目录重绑和创建不修改现有环境或新增会话', async (t) => {
  const f = await fixture(t)
  for (const cwd of ['', '  ', path.join(f.root, 'missing'), path.join(f.workspace, 'note.txt')]) {
    const rebound = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/environment/rebind`, payload: { cwd } })
    assert.equal(rebound.statusCode, 400, rebound.body)
    assert.equal(f.app.sqliteRepository.getEnvironment(f.local.environment.id).cwd, f.workspace)
    const created = await f.createTask({ executionKind: 'existing', cwd })
    assert.equal(created.statusCode, 400, created.body)
    assert.equal(f.app.sqliteRepository.listTasks(f.project.id).length, 1)
  }
  const missing = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${f.local.task.id}/environment/rebind`, payload: {} })
  assert.equal(missing.statusCode, 400)
})

test('工作区部分更新保留未提供字段，非法字段不写入数据库', async (t) => {
  const f = await fixture(t)
  const updated = await f.app.inject({ method: 'PATCH', url: `/api/v2/projects/${f.project.id}`, payload: { displayName: ' 回归工作区 ' } })
  assert.equal(updated.statusCode, 200)
  assert.equal(updated.json().project.displayName, '回归工作区')
  assert.equal(updated.json().project.defaultBranch, 'main')
  for (const payload of [{ displayName: {} }, { displayName: 'a'.repeat(121) }, { defaultBranch: [] }]) {
    const response = await f.app.inject({ method: 'PATCH', url: `/api/v2/projects/${f.project.id}`, payload })
    assert.equal(response.statusCode, 400)
    assert.deepEqual(f.app.sqliteRepository.getProject(f.project.id), updated.json().project)
  }
})

test('布尔参数拒绝字符串，不能绕过强制清理保护', async (t) => {
  const f = await fixture(t)
  assert.equal((await f.app.inject({
    method: 'POST', url: `/api/v2/projects/${f.project.id}/pin`, payload: { pinned: 'false' },
  })).statusCode, 400)

  const created = await f.createTask({ executionKind: 'worktree', slug: 'strict-force' })
  const { task, environment } = created.json()
  await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/archive` })
  fs.writeFileSync(path.join(environment.cwd, 'pending.txt'), '不能丢失\n')
  const response = await f.app.inject({
    method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: { force: 'false' },
  })
  assert.equal(response.statusCode, 400, response.body)
  assert.equal(fs.existsSync(path.join(environment.cwd, 'pending.txt')), true)
})

test('HEAD 基线保存固定提交并检测后续未推送提交', async (t) => {
  const f = await fixture(t)
  const baseCommit = git(f.workspace, 'rev-parse', 'HEAD')
  const created = await f.createTask({ executionKind: 'worktree', baseRef: 'HEAD', slug: 'head-baseline' })
  const { task, environment } = created.json()
  assert.equal(environment.baseRef, 'HEAD')
  assert.equal(environment.baseCommit, baseCommit)
  fs.writeFileSync(path.join(environment.cwd, 'committed.txt'), 'local commit\n')
  git(environment.cwd, 'add', 'committed.txt')
  git(environment.cwd, 'commit', '-m', 'not pushed')
  await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/archive` })
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: {} })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(response.json().risk.unpushedCommits, 1)
})

test('已清理 Worktree 不能直接恢复，但可以复制到新 Worktree', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', title: '可复制会话', slug: 'removed-copy' })
  const { task } = created.json()
  await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/archive` })
  const removed = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/environment/remove-worktree`, payload: {} })
  assert.equal(removed.statusCode, 200, removed.body)
  const restored = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/restore` })
  assert.equal(restored.statusCode, 409, restored.body)
  assert.equal(restored.json().error, 'environment_removed')
  const copied = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/copy`, payload: {} })
  assert.equal(copied.statusCode, 201, copied.body)
  assert.equal(copied.json().task.lifecycle, 'active')
  assert.equal(copied.json().environment.kind, 'worktree')
  assert.equal(copied.json().environment.status, 'ready')
})

test('Worktree 分支改名后按当前提交合并并更新环境分支', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'renamed-before-merge' })
  const { task, environment } = created.json()
  git(environment.cwd, 'branch', '-m', 'renamed-before-delivery')
  fs.writeFileSync(path.join(environment.cwd, 'renamed.txt'), 'renamed branch\n')
  git(environment.cwd, 'add', 'renamed.txt')
  git(environment.cwd, 'commit', '-m', 'renamed delivery')
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
  assert.equal(response.statusCode, 200, response.body)
  assert.equal(response.json().sourceBranch, 'renamed-before-delivery')
  assert.equal(f.app.sqliteRepository.getEnvironment(environment.id).branchName, 'renamed-before-delivery')
  assert.equal(fs.readFileSync(path.join(f.workspace, 'renamed.txt'), 'utf8'), 'renamed branch\n')
})

test('合并冲突会自动中止并保持会话活动', async (t) => {
  const f = await fixture(t)
  const created = await f.createTask({ executionKind: 'worktree', slug: 'merge-conflict' })
  const { task, environment } = created.json()
  fs.writeFileSync(path.join(environment.cwd, 'note.txt'), 'worktree version\n')
  git(environment.cwd, 'add', 'note.txt')
  git(environment.cwd, 'commit', '-m', 'worktree change')
  fs.writeFileSync(path.join(f.workspace, 'note.txt'), 'main version\n')
  git(f.workspace, 'add', 'note.txt')
  git(f.workspace, 'commit', '-m', 'main change')
  const before = git(f.workspace, 'rev-parse', 'HEAD')
  const response = await f.app.inject({ method: 'POST', url: `/api/v2/tasks/${task.id}/git/merge`, payload: { targetBranch: 'main' } })
  assert.equal(response.statusCode, 409, response.body)
  assert.equal(response.json().error, 'merge_failed')
  assert.equal(git(f.workspace, 'rev-parse', 'HEAD'), before)
  assert.equal(git(f.workspace, 'status', '--porcelain'), '')
  assert.equal(f.app.sqliteRepository.getTask(task.id).lifecycle, 'active')
})

test('空工作区可独立归档、恢复和永久删除', async (t) => {
  const f = await fixture(t)
  const emptyRoot = path.join(f.root, 'empty-project')
  fs.mkdirSync(emptyRoot)
  const created = await f.app.inject({ method: 'POST', url: '/api/v2/projects', payload: { repositoryRoot: emptyRoot } })
  const project = created.json().project
  await f.app.inject({ method: 'POST', url: `/api/v2/projects/${project.id}/archive` })
  const archived = await f.app.inject({ method: 'GET', url: '/api/v2/projects/archived' })
  assert.equal(archived.json().projects.some((item) => item.id === project.id), true)
  assert.equal((await f.app.inject({ method: 'DELETE', url: `/api/v2/projects/${project.id}` })).statusCode, 204)
  assert.equal(f.app.sqliteRepository.getProject(project.id), null)
})
