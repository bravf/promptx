import assert from 'node:assert/strict'
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
    assert.equal(repository.listWorkspaces().length, 0)
  } finally {
    db.close()
  }
})
