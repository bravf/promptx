import Fastify from 'fastify'
import cors from '@fastify/cors'
import { createRunManager } from './runManager.js'
import { assertInternalRequest } from './internalAuth.js'
import { createServerClient } from './serverClient.js'
import { createFastifyLoggerOptions } from '../../../packages/shared/src/dailyLogStream.js'

const app = Fastify({ logger: createFastifyLoggerOptions({ logName: 'runner' }) })
const port = Math.max(1, Number(process.env.PROMPTX_RUNNER_PORT || process.env.RUNNER_PORT || 3002))
const host = process.env.PROMPTX_RUNNER_HOST || process.env.HOST || '127.0.0.1'

const serverClient = createServerClient()
const runManager = createRunManager({
  logger: app.log,
  serverClient,
})
let systemConfigSyncTimer = null

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'OPTIONS'],
})

app.addHook('onRequest', async (request) => {
  if (!request.url.startsWith('/internal/')) {
    return
  }

  assertInternalRequest(request.headers)
})

app.get('/health', async () => ({
  ok: true,
  runnerId: process.env.PROMPTX_RUNNER_ID || 'local-runner',
}))

app.post('/internal/runs/start', async (request, reply) => {
  try {
    const run = await runManager.startRun(request.body || {})
    return reply.code(202).send({
      accepted: true,
      runId: run.runId,
      status: run.status,
      run,
    })
  } catch (error) {
    request.log.error(error)
    return reply.code(400).send({
      message: error.message || '启动运行失败。',
    })
  }
})

app.post('/internal/runs/:runId/stop', async (request, reply) => {
  const run = await runManager.stopRun(request.params.runId, request.body || {})
  if (!run) {
    return reply.code(404).send({ message: '没有找到对应的运行上下文。' })
  }

  return reply.code(202).send({
    accepted: true,
    runId: run.runId,
    status: run.status,
    run,
  })
})

app.get('/internal/runs/:runId', async (request, reply) => {
  const run = runManager.getRun(request.params.runId)
  if (!run?.runId) {
    return reply.code(404).send({ message: '没有找到对应的运行上下文。' })
  }

  return { run }
})

app.get('/internal/diagnostics', async () => ({
  runner: runManager.getDiagnostics(),
}))

app.put('/internal/config', async (request, reply) => {
  try {
    const config = await runManager.updateConfig(request.body || {})
    return reply.send({
      ok: true,
      config,
    })
  } catch (error) {
    request.log.error(error)
    return reply.code(400).send({
      message: error.message || 'Runner 配置更新失败。',
    })
  }
})

app.setErrorHandler((error, request, reply) => {
  request.log.error(error)
  reply.code(error.statusCode || 500).send({
    message: error.message || 'Runner 发生了意外错误。',
  })
})

const shutdown = async () => {
  if (systemConfigSyncTimer) {
    clearTimeout(systemConfigSyncTimer)
    systemConfigSyncTimer = null
  }
  await runManager.dispose().catch(() => {})
  await app.close().catch(() => {})
}

process.once('SIGINT', () => {
  shutdown().finally(() => process.exit(0))
})
process.once('SIGTERM', () => {
  shutdown().finally(() => process.exit(0))
})
if (process.platform === 'win32') {
  process.once('SIGBREAK', () => {
    shutdown().finally(() => process.exit(0))
  })
}

async function syncConfigFromServer() {
  try {
    const payload = await serverClient.getSystemConfig()
    const config = await runManager.updateConfig(payload?.config?.runner || {})
    app.log.info({
      maxConcurrentRuns: config.maxConcurrentRuns,
    }, 'runner config synced from server')
    return true
  } catch (error) {
    app.log.warn(error, 'runner config sync from server failed')
    return false
  }
}

function scheduleConfigSync(delayMs) {
  if (systemConfigSyncTimer) {
    clearTimeout(systemConfigSyncTimer)
  }

  systemConfigSyncTimer = setTimeout(async () => {
    systemConfigSyncTimer = null
    const synced = await syncConfigFromServer()
    if (!synced && delayMs < 5000) {
      scheduleConfigSync(5000)
    }
  }, delayMs)
  systemConfigSyncTimer.unref?.()
}

app.listen({ port, host }).then(() => {
  app.log.info(`runner listening at http://${host}:${port}`)
  app.log.info(`server callback base: ${serverClient.baseUrl}`)
  scheduleConfigSync(0)
})
