import { createApp } from './app.js'

const host = String(process.env.HOST || process.env.PROMPTX_DAEMON_HOST || '127.0.0.1')
const port = Number(process.env.PORT || process.env.PROMPTX_DAEMON_PORT || 3001)
const app = await createApp()

try {
  await app.listen({ host, port })
} catch (error) {
  app.log.error(error)
  process.exitCode = 1
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    app.server.closeAllConnections?.()
    await app.close()
    process.exit(0)
  })
}
