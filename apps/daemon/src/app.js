import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDatabase, resolveDaemonPaths } from './db/database.js'
import { createRepository } from './db/repository.js'
import { TimelineStore } from './timeline/timelineStore.js'
import { EventHub } from './events/eventHub.js'
import { ProviderRegistry } from './agent/providerRegistry.js'
import { AgentManager } from './agent/agentManager.js'
import { registerRoutes } from './api/routes.js'
import { registerRelayRoutes, RelayService } from './relay/relayService.js'
import { SessionImportService } from './agent/sessionImport.js'
import { createCorsPolicy } from './security/corsPolicy.js'
import { reconcileEnvironment } from './environments/environmentReconcile.js'

export async function createApp(options = {}) {
  const app = Fastify({ logger: options.logger ?? true })
  const corsPolicy = createCorsPolicy(options.allowedOrigins, () => app.server.address()?.port)
  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin
    if (request.url.startsWith('/api/') && origin && !corsPolicy.allows(origin)) {
      return reply.code(403).send({ error: 'origin_not_allowed', message: '该网页来源不能访问 PromptX Daemon。' })
    }
  })
  await app.register(cors, {
    origin: (origin, callback) => callback(null, corsPolicy.allows(origin)),
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
  })
  await app.register(multipart, {
    limits: {
      fileSize: 50 * 1024 * 1024,
      files: 1,
    },
  })
  const db = options.db || openDatabase(options.databasePath)
  const assetsDir = path.resolve(options.assetsDir || resolveDaemonPaths().assetsDir)
  fs.mkdirSync(assetsDir, { recursive: true })
  const repository = createRepository(db)
  for (const environment of repository.listEnvironments()) {
    void reconcileEnvironment(environment).then((next) => repository.updateEnvironment(environment.id, { status: next.status })).catch(() => {})
  }
  const timelineStore = new TimelineStore(repository)
  const eventHub = new EventHub()
  const providerRegistry = options.providerRegistry || new ProviderRegistry()
  const agentManager = new AgentManager({ repository, timelineStore, providerRegistry, eventHub })
  const sessionImport = new SessionImportService({
    ...(options.sessionImportOptions || {}),
    repository,
    providerRegistry,
    agentManager,
  })
  app.decorate('sqliteRepository', repository)
  repository.failActiveTurnsOnStartup()
  registerRoutes(app, { repository, timelineStore, eventHub, providerRegistry, agentManager, sessionImport, assetsDir, corsPolicy })
  const relay = new RelayService({
    localBaseUrl: options.localBaseUrl || `http://127.0.0.1:${process.env.PORT || process.env.PROMPTX_DAEMON_PORT || 3001}`,
    logger: app.log,
    ...(options.relayOptions || {}),
  })
  registerRelayRoutes(app, relay)
  if (options.relay !== false) relay.start()
  const defaultWebRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
  const webRoot = options.webRoot === false ? '' : path.resolve(options.webRoot || defaultWebRoot)
  if (webRoot && fs.existsSync(path.join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false })
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: 'not_found' })
      if (request.url.startsWith('/assets/')) return reply.sendFile(request.params['*'])
      return reply.sendFile('index.html')
    })
  }
  app.setErrorHandler((error, request, reply) => {
    request.log.error(error)
    const statusCode = error.name === 'ZodError' ? 400 : (error.statusCode || 500)
    reply.code(statusCode).send({
      error: error.code || (statusCode === 400 ? 'invalid_request' : 'internal_error'),
      message: error.message,
    })
  })
  app.addHook('onClose', async () => {
    relay.stop()
    agentManager.shutdown()
    db.close()
  })
  return app
}
