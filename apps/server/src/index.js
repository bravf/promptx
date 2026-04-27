import fs from 'node:fs'
import path from 'node:path'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import {
  buildTaskExports,
  canEditTask,
  clearTaskCodexSessionReferences,
  createTask,
  deleteTask,
  getTaskBySlug,
  listAutomationEnabledTasks,
  listTaskSlugsByCodexSessionId,
  listTasks,
  purgeExpiredTasks,
  reorderTasks,
  updateTaskAutomationRuntime,
  updateTaskCodexSession,
  updateTaskNotificationDelivery,
  updateTask,
} from './repository.js'
import {
  getTaskGitDiffBlob,
  getWorkspaceGitDiffStatusSummaryByCwd,
} from './gitDiff.js'
import {
  getGitDiffWorkerDiagnostics,
  getTaskGitDiffReviewInSubprocess,
  stopGitDiffWorker,
} from './gitDiffClient.js'
import {
  createPromptxCodexSession,
  deletePromptxCodexSession,
  getPromptxCodexSessionById,
  listPromptxCodexSessions,
  resetPromptxCodexSession,
  updatePromptxCodexSession,
} from './codexSessions.js'
import {
  createCodexRun,
  deleteTaskCodexRuns,
  getCodexRunById,
  getRunningCodexRunBySessionId,
  getRunningCodexRunByTaskSlug,
  isActiveRunStatus,
  listCodexRunEvents,
  listRunningCodexSessionIds,
  listRunningCodexTaskSlugs,
  listTaskCodexRunsWithOptions,
  updateCodexRunFromRunnerStatus,
} from './codexRuns.js'
import { listKnownSessionsByEngine, listKnownWorkspacesByEngine } from './agents/index.js'
import {
  listDirectoryPickerTree,
  readWorkspaceFileContent,
  listWorkspaceTree,
  searchDirectoryPickerEntries,
  searchWorkspaceFileContent,
  searchWorkspaceEntries,
} from './workspaceFiles.js'
import { ensurePromptxStorageReady, serverRootDir } from './appPaths.js'
import { createRelayClient } from './relayClient.js'
import { getRelayConfigForClient } from './relayConfig.js'
import { createSseHub } from './sseHub.js'
import { createTaskAutomationService } from './taskAutomation.js'
import { createRunnerClient } from './runnerClient.js'
import { createRunEventIngestService } from './runEventIngest.js'
import { createRunRecoveryService } from './runRecovery.js'
import { createMaintenanceService } from './maintenance.js'
import { createRunDispatchService } from './runDispatchService.js'
import { registerSystemRoutes } from './systemRoutes.js'
import {
  createTaskWorkspaceDiffSummaryService,
  registerTaskRoutes,
} from './taskRoutes.js'
import {
  createWorkspaceSuggestionService,
  registerCodexRoutes,
} from './codexRoutes.js'
import {
  registerInternalRunnerRoutes,
  registerRealtimeRoutes,
} from './internalRoutes.js'
import { registerAssetRoutes } from './assetRoutes.js'
import { getApiErrorPayload } from './apiErrors.js'
import { registerWebAppRoutes } from './webAppRoutes.js'
import { createTempFilePath, normalizeUploadFileName } from './upload.js'
import { importPdfBlocks } from './pdf.js'
import { createFastifyLoggerOptions } from '@promptx/shared/dailyLogStream'

const app = Fastify({ logger: createFastifyLoggerOptions({ logName: 'server' }) })
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '127.0.0.1'
const { tmpDir, uploadsDir } = ensurePromptxStorageReady()
const workspaceRootDir = path.resolve(serverRootDir, '..', '..')
const workspaceParentDir = path.dirname(workspaceRootDir)
const webDistDir = path.resolve(serverRootDir, '..', 'web', 'dist')
const webIndexFile = path.join(webDistDir, 'index.html')
const hasBuiltWebApp = fs.existsSync(webIndexFile)
const packageJsonPath = path.resolve(workspaceRootDir, 'package.json')

function readPromptxVersion() {
  try {
    const payload = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'))
    return String(payload.version || '').trim() || '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const promptxVersion = readPromptxVersion()
const relayConfig = getRelayConfigForClient()
const relayClient = createRelayClient({
  logger: app.log,
  appVersion: promptxVersion,
  localBaseUrl: process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`,
  ...relayConfig,
})
const runnerClient = createRunnerClient()

let lastExpiredPurgeAt = 0
const sseHub = createSseHub()
const localServerBaseUrl = process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`
const publicServerBaseUrl = String(
  process.env.PROMPTX_PUBLIC_URL
  || relayConfig?.relayUrl
  || localServerBaseUrl
).trim().replace(/\/+$/, '')

function broadcastServerEvent(type, payload = {}) {
  sseHub.broadcast(type, payload)
}

const runEventIngestService = createRunEventIngestService({
  broadcastServerEvent,
  decorateCodexSession,
})

function updateTaskAutomationRuntimeWithBroadcast(taskSlug, patch = {}) {
  const task = updateTaskAutomationRuntime(taskSlug, patch)
  if (task) {
    broadcastServerEvent('tasks.changed', {
      taskSlug,
      reason: 'automation-updated',
    })
  }
  return task
}

function updateTaskNotificationDeliveryWithBroadcast(taskSlug, patch = {}) {
  const task = updateTaskNotificationDelivery(taskSlug, patch)
  if (task) {
    broadcastServerEvent('tasks.changed', {
      taskSlug,
      reason: 'notification-updated',
    })
  }
  return task
}

function getRunningSessionIdSet() {
  return new Set(listRunningCodexSessionIds())
}

function decorateCodexSession(session, runningSessionIds = getRunningSessionIdSet()) {
  if (!session) {
    return null
  }

  const nextAgentBindings = Array.isArray(session.agentBindings)
    ? session.agentBindings.map((item) => ({
        ...item,
        running: runningSessionIds.has(String(item?.sessionRecordId || '').trim()),
      }))
    : []

  return {
    ...session,
    agentBindings: nextAgentBindings,
    running: runningSessionIds.has(session.id) || nextAgentBindings.some((item) => item.running),
  }
}

function decorateCodexSessionList(items = []) {
  const runningSessionIds = getRunningSessionIdSet()
  return items.map((item) => decorateCodexSession(item, runningSessionIds))
}

function getRunningTaskSlugSet() {
  return new Set(listRunningCodexTaskSlugs())
}

function decorateTask(task, runningTaskSlugs = getRunningTaskSlugSet()) {
  if (!task) {
    return null
  }

  return {
    ...task,
    running: runningTaskSlugs.has(task.slug),
  }
}

function decorateTaskList(items = []) {
  const runningTaskSlugs = getRunningTaskSlugSet()
  return items.map((item) => decorateTask(item, runningTaskSlugs))
}

function buildTaskDetailUrl(taskSlug = '', options = {}) {
  const normalizedSlug = String(taskSlug || '').trim()
  if (!normalizedSlug) {
    return publicServerBaseUrl || localServerBaseUrl
  }

  if (options.raw) {
    return `${localServerBaseUrl}/api/tasks/${normalizedSlug}/raw`
  }

  return `${publicServerBaseUrl || localServerBaseUrl}/?task=${encodeURIComponent(normalizedSlug)}`
}

const runDispatchService = createRunDispatchService({
  broadcastServerEvent,
  createCodexRun,
  decorateCodexSession,
  getCodexRunById,
  getPromptxCodexSessionById,
  getRunningCodexRunBySessionId,
  getTaskBySlug,
  logger: app.log,
  localServerBaseUrl,
  publicServerBaseUrl,
  relayUrl: relayConfig?.relayUrl || '',
  runnerClient,
  updateCodexRunFromRunnerStatus,
  updateTaskCodexSession,
})

const taskAutomationService = createTaskAutomationService({
  logger: app.log,
  getRunningCodexRunByTaskSlug,
  listAutomationEnabledTasks,
  updateTaskAutomationRuntime: updateTaskAutomationRuntimeWithBroadcast,
  updateTaskNotificationDelivery: updateTaskNotificationDeliveryWithBroadcast,
  createTaskRun: async (payload) => runDispatchService.startTaskRunForTask(payload),
  getTaskBySlug,
  getRunById: getCodexRunById,
  detailUrlBuilder: buildTaskDetailUrl,
})

const runRecoveryService = createRunRecoveryService({
  logger: app.log,
  broadcastServerEvent,
  onRecoveredRun(run) {
    taskAutomationService.notifyRun(run.taskSlug, run.id).catch(() => {})
  },
})
const maintenanceService = createMaintenanceService({
  logger: app.log,
  tmpDir,
})

function buildServerAccessUrls(hostname, currentPort) {
  const normalizedHost = String(hostname || '').trim()

  if (!normalizedHost || normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '127.0.0.1') {
    return [`本机: http://127.0.0.1:${currentPort}`]
  }

  if (normalizedHost === 'localhost') {
    return [`本机: http://localhost:${currentPort}`]
  }

  return [`访问地址: http://${normalizedHost}:${currentPort}`]
}

function resolveUploadPath(assetPath = '') {
  const normalized = String(assetPath || '').replace(/^\/+/, '')
  if (!normalized.startsWith('uploads/')) {
    return null
  }

  const absolutePath = path.resolve(process.cwd(), normalized)
  return absolutePath.startsWith(`${uploadsDir}${path.sep}`) ? absolutePath : null
}

function removeAssetFiles(assetPaths = []) {
  const uniquePaths = [...new Set(assetPaths)]
  uniquePaths.forEach((assetPath) => {
    const targetPath = resolveUploadPath(assetPath)
    if (targetPath) {
      fs.rmSync(targetPath, { force: true })
    }
  })
}

function purgeExpiredContent(force = false) {
  const now = Date.now()
  if (!force && now - lastExpiredPurgeAt < 60 * 1000) {
    return
  }

  lastExpiredPurgeAt = now
  const result = purgeExpiredTasks(new Date(now).toISOString())
  if (result.removedAssets.length) {
    removeAssetFiles(result.removedAssets)
  }
}

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
})

await app.register(multipart, {
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

app.addContentTypeParser(
  'application/x-www-form-urlencoded',
  { parseAs: 'string' },
  (request, body, done) => {
    done(null, {})
  }
)

await app.register(fastifyStatic, {
  root: uploadsDir,
  prefix: '/uploads/',
})

if (hasBuiltWebApp) {
  await app.register(fastifyStatic, {
    root: webDistDir,
    prefix: '/',
    decorateReply: false,
    wildcard: false,
    index: false,
  })
}

app.get('/health', async () => ({ ok: true }))

registerInternalRunnerRoutes(app, {
  runEventIngestService,
  taskAutomationService,
})

registerSystemRoutes(app, {
  getGitDiffWorkerDiagnostics,
  localBaseUrl: process.env.PROMPTX_RELAY_LOCAL_BASE_URL || `http://127.0.0.1:${port}`,
  maintenanceService,
  promptxVersion,
  relayClient,
  runRecoveryService,
  runnerClient,
})

registerRealtimeRoutes(app, {
  sseHub,
})

const taskWorkspaceDiffSummaryService = createTaskWorkspaceDiffSummaryService({
  getPromptxCodexSessionById,
  getWorkspaceGitDiffStatusSummaryByCwd,
  listTasks,
})

const workspaceSuggestionService = createWorkspaceSuggestionService({
  listKnownWorkspacesByEngine,
  listPromptxCodexSessions,
  workspaceParentDir,
  workspaceRootDir,
})

registerTaskRoutes(app, {
  broadcastServerEvent,
  buildTaskExports,
  canEditTask,
  createTask,
  decorateTask,
  decorateTaskList,
  deleteTask,
  deleteTaskCodexRuns,
  getPromptxCodexSessionById,
  getRunningCodexRunByTaskSlug,
  getTaskBySlug,
  getTaskGitDiffBlob,
  getTaskGitDiffReviewInSubprocess,
  listTaskCodexRunsWithOptions,
  listTaskWorkspaceDiffSummaries: taskWorkspaceDiffSummaryService.listTaskWorkspaceDiffSummaries,
  listTasks,
  purgeExpiredContent,
  reorderTasks,
  removeAssetFiles,
  runDispatchService,
  updateTask,
  updateTaskCodexSession,
})

registerAssetRoutes(app, {
  createTempFilePath,
  importPdfBlocks,
  normalizeUploadFileName,
  removeAssetFiles,
  tmpDir,
  uploadsDir,
})

registerCodexRoutes(app, {
  broadcastServerEvent,
  clearTaskCodexSessionReferences,
  createPromptxCodexSession,
  decorateCodexSession,
  decorateCodexSessionList,
  deletePromptxCodexSession,
  deleteTaskCodexRuns,
  getCodexRunById,
  getPromptxCodexSessionById,
  getRunningCodexRunBySessionId,
  getRunningCodexRunByTaskSlug,
  isActiveRunStatus,
  listCodexRunEvents,
  listDirectoryPickerTree,
  listKnownSessionsByEngine,
  listPromptxCodexSessions,
  listTaskSlugsByCodexSessionId,
  listWorkspaceSuggestions: workspaceSuggestionService.listWorkspaceSuggestions,
  listWorkspaceTree,
  readWorkspaceFileContent,
  resetPromptxCodexSession,
  runDispatchService,
  searchDirectoryPickerEntries,
  searchWorkspaceFileContent,
  searchWorkspaceEntries,
  updatePromptxCodexSession,
})

registerWebAppRoutes(app, {
  enabled: hasBuiltWebApp,
  webDistDir,
})

app.setErrorHandler((error, request, reply) => {
  request.log.error(error)
  const payload = getApiErrorPayload(error, error.statusCode === 413
    ? { messageKey: 'errors.fileTooLarge', message: '文件太大了。' }
    : { messageKey: 'errors.unexpectedServerError', message: error.message || '发生了意外错误。' })
  reply.code(error.statusCode || 500).send(payload)
})

purgeExpiredContent(true)

let shutdownPromise = null

async function shutdown() {
  if (shutdownPromise) {
    return shutdownPromise
  }

  shutdownPromise = (async () => {
    relayClient.stop()
    taskAutomationService.stop()
    runRecoveryService.stop()
    maintenanceService.stop()
    stopGitDiffWorker()
    await app.close().catch(() => {})
  })()

  return shutdownPromise
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

app.listen({ port, host }).then(() => {
  app.log.info(`server running at http://${host}:${port}`)
  buildServerAccessUrls(host, port).forEach((message) => {
    app.log.info(message)
  })
  runRecoveryService.start()
  taskAutomationService.start()
  maintenanceService.start()
  relayClient.start()
})

