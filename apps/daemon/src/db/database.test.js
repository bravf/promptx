import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { DATABASE_VERSION, openDatabase } from './database.js'

test('新数据库使用当前模型版本且不包含旧工作区表', () => {
  const db = openDatabase(':memory:')
  try {
    assert.equal(db.pragma('user_version', { simple: true }), DATABASE_VERSION)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name)
    assert.equal(tables.includes('workspaces'), false)
    assert.equal(tables.includes('workspace_assets'), false)
    assert.equal(tables.includes('projects'), true)
    assert.equal(tables.includes('tasks'), true)
  } finally {
    db.close()
  }
})

test('有业务表的旧版本数据库会拒绝启动', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-database-'))
  const databasePath = path.join(tempDir, 'legacy.sqlite')
  const legacyDb = new Database(databasePath)
  legacyDb.exec('CREATE TABLE workspaces (id TEXT PRIMARY KEY)')
  legacyDb.pragma(`user_version = ${DATABASE_VERSION - 1}`)
  legacyDb.close()

  try {
    assert.throws(
      () => openDatabase(databasePath),
      (error) => error.code === 'DATABASE_VERSION_MISMATCH' && error.message.includes('pnpm data:reset'),
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
