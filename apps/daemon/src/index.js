import { createApp } from './app.js'
import { resolveDaemonPaths } from './db/database.js'
import { acquireInstanceLock } from './runtime/instanceLock.js'

const host = String(process.env.PROMPTX_DAEMON_HOST || '127.0.0.1')
const port = Number(process.env.PROMPTX_DAEMON_PORT || 3001)
let app
let releaseLock
try {
  releaseLock = acquireInstanceLock(resolveDaemonPaths().databasePath)
  process.once('exit', releaseLock)
  app = await createApp()
  await app.listen({ host, port })
} catch (error) {
  console.error(error)
  await app?.close()
  releaseLock?.()
  process.exitCode = 1
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    app?.server.closeAllConnections?.()
    await app?.close()
    releaseLock?.()
    process.exit(0)
  })
}
