import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

function git(cwd, args = []) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim()
}

test('git diff review returns task and run scoped file changes for git workspaces', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n')
  git(repoDir, ['add', 'tracked.txt'])
  git(repoDir, ['commit', '-m', 'init'])
  const branchName = git(repoDir, ['symbolic-ref', '--short', 'HEAD'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      __getGitDiffCacheMetricsForTest,
      __resetGitDiffCachesForTest,
      captureRunGitBaseline,
      captureRunGitFinalSnapshot,
      captureTaskGitBaseline,
      getGitDiffCacheDebugSnapshot,
      getTaskGitDiffReview,
      getWorkspaceGitDiffReviewByCwd,
      getWorkspaceGitDiffStatusSummaryByCwd,
    } = await import(`./gitDiff.js?test=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-1', 'token-1', 'session-1', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-1', 'Repo Session', repoDir, now, now]
    )
    run(
      `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
       VALUES (?, ?, ?, '', 'running', '', '', ?, ?, ?, NULL)`,
      ['run-1', 'task-1', 'session-1', now, now, now]
    )

    captureTaskGitBaseline('task-1', repoDir)
    captureRunGitBaseline('run-1', repoDir)

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    captureRunGitFinalSnapshot('run-1', repoDir)

    const workspaceDiff = getTaskGitDiffReview('task-1', { scope: 'workspace' })
    const workspaceDiffFast = getTaskGitDiffReview('task-1', { scope: 'workspace', includeStats: false })
    const workspaceDiffByCwd = getWorkspaceGitDiffReviewByCwd(repoDir)
    const workspaceStatusSummary = getWorkspaceGitDiffStatusSummaryByCwd(repoDir)
    const taskDiffFast = getTaskGitDiffReview('task-1', { scope: 'task', includeStats: false })
    const taskDiffSummaryOnly = getTaskGitDiffReview('task-1', {
      scope: 'task',
      includeFiles: false,
      includeStats: true,
    })
    const taskDiff = getTaskGitDiffReview('task-1', { scope: 'task' })
    const taskTrackedDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'tracked.txt' })
    const taskNewFileDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'new-file.txt' })
    const runDiff = getTaskGitDiffReview('task-1', { scope: 'run', runId: 'run-1' })

    assert.equal(workspaceDiff.supported, true)
    assert.equal(workspaceDiff.branch, branchName)
    assert.deepEqual(workspaceDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(workspaceDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(workspaceDiffFast.supported, true)
    assert.deepEqual(workspaceDiffFast.summary, {
      fileCount: 2,
      additions: null,
      deletions: null,
      statsComplete: false,
    })
    assert.deepEqual(workspaceDiffFast.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(workspaceDiffFast.files.find((file) => file.path === 'tracked.txt')?.statsLoaded, false)
    assert.equal(workspaceDiffFast.files.find((file) => file.path === 'tracked.txt')?.patchLoaded, false)
    assert.deepEqual(workspaceDiffByCwd.summary, workspaceDiff.summary)
    assert.deepEqual(workspaceDiffByCwd.files.map((file) => `${file.status}:${file.path}`), workspaceDiff.files.map((file) => `${file.status}:${file.path}`))
    assert.equal(workspaceStatusSummary.supported, true)
    assert.equal(workspaceStatusSummary.branch, branchName)
    assert.deepEqual(workspaceStatusSummary.summary, {
      fileCount: 2,
      additions: 0,
      deletions: 0,
      statsComplete: false,
    })
    assert.deepEqual(workspaceStatusSummary.files, [])

    assert.equal(taskDiff.supported, true)
    assert.equal(taskDiff.branch, branchName)
    assert.equal(taskDiff.summary.fileCount, 2)
    assert.deepEqual(taskDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(taskDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(taskDiff.baseline?.branch, branchName)
    assert.equal(taskDiff.baseline?.headShort, taskDiff.baseline?.headOid.slice(0, 7))
    assert.deepEqual(taskDiff.warnings, [])
    assert.equal(taskDiff.files.find((file) => file.path === 'tracked.txt')?.patchLoaded, false)
    assert.equal(taskDiffFast.summary.statsComplete, false)
    assert.equal(taskDiffFast.summary.fileCount, 2)
    assert.equal(taskDiffFast.files.find((file) => file.path === 'tracked.txt')?.statsLoaded, false)
    assert.equal(taskDiffFast.files.find((file) => file.path === 'tracked.txt')?.additions, null)
    assert.deepEqual(taskDiffSummaryOnly.files, [])
    assert.equal(taskDiffSummaryOnly.summary.statsComplete, true)
    assert.deepEqual(taskDiffSummaryOnly.summary, {
      fileCount: 2,
      additions: 2,
      deletions: 1,
      statsComplete: true,
    })
    assert.equal(taskTrackedDetail.summary?.statsComplete, true)
    assert.equal(typeof taskTrackedDetail.summary?.statsComplete, 'boolean')
    assert.deepEqual(taskTrackedDetail.files.map((file) => file.path), ['tracked.txt'])
    assert.match(taskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /--- a\/tracked\.txt/)
    assert.match(taskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /\+\+\+ b\/tracked\.txt/)
    assert.deepEqual(taskNewFileDetail.files.map((file) => file.path), ['new-file.txt'])
    assert.match(taskNewFileDetail.files.find((file) => file.path === 'new-file.txt')?.patch || '', /hello/)
    assert.deepEqual(
      taskDiff.files.find((file) => file.path === 'tracked.txt')
        ? {
            additions: taskDiff.files.find((file) => file.path === 'tracked.txt').additions,
            deletions: taskDiff.files.find((file) => file.path === 'tracked.txt').deletions,
          }
        : null,
      { additions: 1, deletions: 1 }
    )

    __resetGitDiffCachesForTest()
    getTaskGitDiffReview('task-1', { scope: 'task' })
    const firstCacheMetrics = __getGitDiffCacheMetricsForTest()
    getTaskGitDiffReview('task-1', { scope: 'task' })
    const secondCacheMetrics = __getGitDiffCacheMetricsForTest()
    const cacheSnapshot = getGitDiffCacheDebugSnapshot()
    assert.equal(firstCacheMetrics.reviewHits, 0)
    assert.equal(secondCacheMetrics.reviewHits, 1)
    assert.equal(cacheSnapshot.reviewCacheSize >= 1, true)
    assert.equal(cacheSnapshot.fileCacheSize >= 1, true)

    assert.equal(runDiff.supported, true)
    assert.equal(runDiff.branch, branchName)
    assert.equal(runDiff.summary.fileCount, 2)
    assert.deepEqual(runDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(runDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after-later\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello later\n')
    fs.writeFileSync(path.join(repoDir, 'later-file.txt'), 'later\n')
    const stableRunDiff = getTaskGitDiffReview('task-1', { scope: 'run', runId: 'run-1' })
    assert.deepEqual(stableRunDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(stableRunDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'after\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    fs.rmSync(path.join(repoDir, 'later-file.txt'), { force: true })

    git(repoDir, ['add', 'tracked.txt', 'new-file.txt'])
    git(repoDir, ['commit', '-m', 'persist tracked and new file changes'])

    const committedWorkspaceDiff = getTaskGitDiffReview('task-1', { scope: 'workspace' })
    const committedTaskDiff = getTaskGitDiffReview('task-1', { scope: 'task' })
    const committedTaskTrackedDetail = getTaskGitDiffReview('task-1', { scope: 'task', filePath: 'tracked.txt' })
    assert.equal(committedWorkspaceDiff.supported, true)
    assert.deepEqual(committedWorkspaceDiff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(committedWorkspaceDiff.files, [])
    assert.equal(committedTaskDiff.supported, true)
    assert.deepEqual(committedTaskDiff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(committedTaskDiff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
    assert.equal(committedTaskDiff.files.find((file) => file.path === 'tracked.txt')?.patchLoaded, false)
    assert.deepEqual(committedTaskTrackedDetail.files.map((file) => file.path), ['tracked.txt'])
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /--- a\/tracked\.txt/)
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /\+\+\+ b\/tracked\.txt/)
    assert.match(committedTaskTrackedDetail.files.find((file) => file.path === 'tracked.txt')?.patch || '', /after/)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('single file diff falls back to message when patch exceeds inline line budget', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-large-patch-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  const originalContent = Array.from({ length: 520 }, (_, index) => `base-${index}`).join('\n') + '\n'
  const nextContent = Array.from({ length: 520 }, (_, index) => `next-${index}`).join('\n') + '\n'
  fs.writeFileSync(path.join(repoDir, 'huge-lines.txt'), originalContent)
  git(repoDir, ['add', 'huge-lines.txt'])
  git(repoDir, ['commit', '-m', 'init'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const originalMaxPatchLines = process.env.PROMPTX_GIT_DIFF_MAX_PATCH_LINES
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir
  process.env.PROMPTX_GIT_DIFF_MAX_PATCH_LINES = '400'

  try {
    const { run } = await import('./db.js')
    const {
      captureTaskGitBaseline,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?test=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-large-lines', 'token-large-lines', 'session-large-lines', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-large-lines', 'Repo Session', repoDir, now, now]
    )

    captureTaskGitBaseline('task-large-lines', repoDir)
    fs.writeFileSync(path.join(repoDir, 'huge-lines.txt'), nextContent)

    const detail = getTaskGitDiffReview('task-large-lines', {
      scope: 'workspace',
      filePath: 'huge-lines.txt',
    })
    const file = detail.files.find((item) => item.path === 'huge-lines.txt')

    assert.equal(file?.patchLoaded, true)
    assert.equal(file?.tooLarge, true)
    assert.match(file?.patch || '', /diff --git a\/huge-lines\.txt b\/huge-lines\.txt/)
    assert.match(file?.patch || '', /\.\.\. 已截断，剩余 \d+ 行未展示 \.\.\./)
    assert.equal(file?.message, 'diff 内容较长，当前仅展示摘要预览。')
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'undefined') {
      delete process.env.PROMPTX_DATA_DIR
    } else {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    }
    if (typeof originalMaxPatchLines === 'undefined') {
      delete process.env.PROMPTX_GIT_DIFF_MAX_PATCH_LINES
    } else {
      process.env.PROMPTX_GIT_DIFF_MAX_PATCH_LINES = originalMaxPatchLines
    }
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('binary diff review exposes preview metadata and blob payloads', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-binary-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  const beforeBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03])
  const afterBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x04, 0x05, 0x06, 0x07])
  const unchangedBuffer = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x09, 0x0a, 0x0b])
  fs.mkdirSync(path.join(repoDir, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(repoDir, 'assets', 'logo.png'), beforeBuffer)
  fs.writeFileSync(path.join(repoDir, 'assets', 'unchanged.png'), unchangedBuffer)
  git(repoDir, ['add', 'assets/logo.png', 'assets/unchanged.png'])
  git(repoDir, ['commit', '-m', 'add logo'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      captureTaskGitBaseline,
      getTaskGitDiffBlob,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?binary-test=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-binary', 'token-binary', 'session-binary', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-binary', 'Binary Repo', repoDir, now, now]
    )

    captureTaskGitBaseline('task-binary', repoDir)
    fs.writeFileSync(path.join(repoDir, 'assets', 'logo.png'), afterBuffer)

    const detail = getTaskGitDiffReview('task-binary', {
      scope: 'task',
      filePath: 'assets/logo.png',
    })
    const file = detail.files[0]
    assert.equal(file.binary, true)
    assert.equal(file.binaryPreview.kind, 'image')
    assert.equal(file.binaryPreview.mimeType, 'image/png')
    assert.equal(file.binaryPreview.before.exists, true)
    assert.equal(file.binaryPreview.after.exists, true)
    assert.equal(file.binaryPreview.before.size, beforeBuffer.length)
    assert.equal(file.binaryPreview.after.size, afterBuffer.length)

    const beforePayload = getTaskGitDiffBlob('task-binary', {
      scope: 'task',
      filePath: 'assets/logo.png',
      side: 'before',
    })
    const afterPayload = getTaskGitDiffBlob('task-binary', {
      scope: 'task',
      filePath: 'assets/logo.png',
      side: 'after',
    })
    const blockedPayload = getTaskGitDiffBlob('task-binary', {
      scope: 'task',
      filePath: 'assets/unchanged.png',
      side: 'after',
    })
    assert.equal(beforePayload.supported, true)
    assert.equal(afterPayload.supported, true)
    assert.deepEqual(beforePayload.body, beforeBuffer)
    assert.deepEqual(afterPayload.body, afterBuffer)
    assert.equal(blockedPayload.supported, false)
    assert.equal(blockedPayload.messageKey, 'diffReview.fileNotInDiff')
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('run scoped diff stays pinned to each round snapshot', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-rounds-'))
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(repoDir, { recursive: true })

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])

  fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'base\n')
  git(repoDir, ['add', 'tracked.txt'])
  git(repoDir, ['commit', '-m', 'init'])

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      captureRunGitBaseline,
      captureRunGitFinalSnapshot,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?rounds=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-rounds', 'token-rounds', 'session-rounds', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-rounds', 'Repo Session', repoDir, now, now]
    )

    ;['run-round-1', 'run-round-2', 'run-round-3'].forEach((runId) => {
      run(
        `INSERT INTO codex_runs (id, task_slug, session_id, prompt, status, response_message, error_message, created_at, updated_at, started_at, finished_at)
         VALUES (?, ?, ?, '', 'completed', '', '', ?, ?, ?, ?)`,
        [runId, 'task-rounds', 'session-rounds', now, now, now, now]
      )
    })

    captureRunGitBaseline('run-round-1', repoDir)
    captureRunGitFinalSnapshot('run-round-1', repoDir)

    captureRunGitBaseline('run-round-2', repoDir)
    captureRunGitFinalSnapshot('run-round-2', repoDir)

    captureRunGitBaseline('run-round-3', repoDir)
    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'round-3\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello\n')
    captureRunGitFinalSnapshot('run-round-3', repoDir)

    fs.writeFileSync(path.join(repoDir, 'tracked.txt'), 'later-round\n')
    fs.writeFileSync(path.join(repoDir, 'new-file.txt'), 'hello later\n')
    fs.writeFileSync(path.join(repoDir, 'later-file.txt'), 'later\n')

    const run1Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-1' })
    const run2Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-2' })
    const run3Diff = getTaskGitDiffReview('task-rounds', { scope: 'run', runId: 'run-round-3' })

    assert.equal(run1Diff.supported, true)
    assert.deepEqual(run1Diff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(run1Diff.files, [])

    assert.equal(run2Diff.supported, true)
    assert.deepEqual(run2Diff.summary, { fileCount: 0, additions: 0, deletions: 0, statsComplete: true })
    assert.deepEqual(run2Diff.files, [])

    assert.equal(run3Diff.supported, true)
    assert.deepEqual(run3Diff.summary, { fileCount: 2, additions: 2, deletions: 1, statsComplete: true })
    assert.deepEqual(run3Diff.files.map((file) => `${file.status}:${file.path}`), ['A:new-file.txt', 'M:tracked.txt'])
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('submodule diff expands nested file entries and resolves nested file detail', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-git-diff-submodule-'))
  const submoduleSourceDir = path.join(tempDir, 'submodule-source')
  const repoDir = path.join(tempDir, 'repo')
  fs.mkdirSync(submoduleSourceDir, { recursive: true })
  fs.mkdirSync(repoDir, { recursive: true })

  git(submoduleSourceDir, ['init'])
  git(submoduleSourceDir, ['config', 'user.email', 'promptx@example.com'])
  git(submoduleSourceDir, ['config', 'user.name', 'PromptX'])
  fs.mkdirSync(path.join(submoduleSourceDir, 'apps', 'web-antd', 'src', 'views', 'dashboard', 'import-fee'), { recursive: true })
  fs.writeFileSync(
    path.join(submoduleSourceDir, 'apps', 'web-antd', 'src', 'views', 'dashboard', 'import-fee', 'index.vue'),
    'line-1\nline-2\nline-3\n',
    'utf8'
  )
  git(submoduleSourceDir, ['add', '.'])
  git(submoduleSourceDir, ['commit', '-m', 'init submodule'])

  git(repoDir, ['init'])
  git(repoDir, ['config', 'user.email', 'promptx@example.com'])
  git(repoDir, ['config', 'user.name', 'PromptX'])
  git(repoDir, ['-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSourceDir, 'web'])
  git(repoDir, ['commit', '-m', 'add submodule'])

  const nestedFilePath = 'web/apps/web-antd/src/views/dashboard/import-fee/index.vue'

  const originalCwd = process.cwd()
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const dataDir = path.join(tempDir, 'data')
  fs.mkdirSync(dataDir, { recursive: true })
  process.chdir(tempDir)
  process.env.PROMPTX_DATA_DIR = dataDir

  try {
    const { run } = await import('./db.js')
    const {
      captureTaskGitBaseline,
      getTaskGitDiffReview,
    } = await import(`./gitDiff.js?submodule=${Date.now()}`)

    const now = new Date().toISOString()
    run(
      `INSERT INTO tasks (slug, edit_token, title, auto_title, last_prompt_preview, codex_session_id, visibility, expires_at, created_at, updated_at)
       VALUES (?, ?, '', '', '', ?, 'private', NULL, ?, ?)`,
      ['task-submodule', 'token-submodule', 'session-submodule', now, now]
    )
    run(
      `INSERT INTO codex_sessions (id, title, cwd, codex_thread_id, created_at, updated_at)
       VALUES (?, ?, ?, '', ?, ?)`,
      ['session-submodule', 'Repo Session', repoDir, now, now]
    )

    captureTaskGitBaseline('task-submodule', repoDir)

    fs.writeFileSync(
      path.join(repoDir, nestedFilePath),
      'line-1\nline-2 changed\nline-3\nline-4 added\n',
      'utf8'
    )

    const workspaceDiff = getTaskGitDiffReview('task-submodule', { scope: 'workspace' })
    assert.ok(workspaceDiff.files.some((file) => file.path === nestedFilePath))

    const nestedFile = workspaceDiff.files.find((file) => file.path === nestedFilePath)
    assert.ok(nestedFile)
    assert.match(nestedFile.patch || '', /line-2 changed/)
    assert.match(nestedFile.patch || '', /line-4 added/)

    const nestedDetail = getTaskGitDiffReview('task-submodule', {
      scope: 'workspace',
      filePath: nestedFilePath,
    })
    assert.deepEqual(nestedDetail.files.map((file) => file.path), [nestedFilePath])
    assert.match(nestedDetail.files[0]?.patch || '', /line-2 changed/)
    assert.match(nestedDetail.files[0]?.patch || '', /line-4 added/)
  } finally {
    process.chdir(originalCwd)
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
