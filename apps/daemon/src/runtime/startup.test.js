import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { openDatabase } from '../db/database.js'
import { createRepository } from '../db/repository.js'
import { acquireInstanceLock } from './instanceLock.js'

const execute = promisify(execFile)
const entry = fileURLToPath(new URL('../index.js', import.meta.url))

for (const conflict of ['port', 'database']) test(`启动冲突（${conflict}）及时退出且不修改运行中的轮次`, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-startup-'))
  const databasePath = path.join(root, 'data', 'promptx-v2.sqlite')
  const db = openDatabase(databasePath)
  const repository = createRepository(db)
  const project = repository.createProject({ repositoryRoot: root, displayName: '启动测试' })
  const environment = repository.createEnvironment({ cwd: root, repositoryRoot: root, kind: 'local' })
  const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '运行中' })
  repository.createAgent(task.id, { providerId: 'codex' })
  const turn = repository.createTurn(task.id, 'startup-test')
  repository.updateTurn(turn.id, { status: 'running' })
  let server, release
  t.after(async () => {
    release?.()
    if (server) await new Promise(resolve => server.close(resolve))
    db.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  let port = 0
  if (conflict === 'database') release = acquireInstanceLock(databasePath)
  else {
    server = net.createServer()
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    port = server.address().port
  }
  await assert.rejects(execute(process.execPath, [entry], {
    timeout: 5000,
    env: { ...process.env, PROMPTX_HOME: root, PROMPTX_DATA_DIR: path.dirname(databasePath), PROMPTX_UPLOADS_DIR: path.join(root, 'uploads'), PROMPTX_RELAY_ENABLED: 'false', PROMPTX_DAEMON_HOST: '127.0.0.1', PROMPTX_DAEMON_PORT: String(port) },
  }), error => error.code === 1 && !error.killed && (conflict === 'port' ? /EADDRINUSE/.test(error.stderr) : /已有 Daemon/.test(error.stderr)))
  assert.equal(repository.getTurn(turn.id).status, 'running')
  if (conflict === 'port') assert.equal(fs.existsSync(`${databasePath}.lock`), false)
})
