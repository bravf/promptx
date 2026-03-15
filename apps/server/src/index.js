import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { Jimp } from 'jimp'
import { nanoid } from 'nanoid'
import { EXPIRY_OPTIONS, VISIBILITY_OPTIONS } from '@promptx/shared'
import {
  buildTaskExports,
  canEditTask,
  clearTaskCodexSessionReferences,
  createTask,
  deleteTask,
  getTaskBySlug,
  listTasks,
  purgeExpiredTasks,
  updateTaskCodexSession,
  updateTask,
} from './repository.js'
import {
  listKnownCodexWorkspaces,
  sendPromptToCodexSession,
  streamPromptToCodexSession,
} from './codex.js'
import {
  createPromptxCodexSession,
  deletePromptxCodexSession,
  getPromptxCodexSessionById,
  listPromptxCodexSessions,
  updatePromptxCodexSession,
} from './codexSessions.js'
import {
  appendCodexRunEvent,
  createCodexRun,
  deleteTaskCodexRuns,
  getCodexRunById,
  getRunningCodexRunBySessionId,
  getRunningCodexRunByTaskSlug,
  listRunningCodexSessionIds,
  listRunningCodexTaskSlugs,
  listTaskCodexRuns,
  markInterruptedCodexRuns,
  updateCodexRun,
} from './codexRuns.js'
import { importPdfBlocks } from './pdf.js'
import { createTempFilePath, normalizeUploadFileName } from './upload.js'
import { listWorkspaceTree, searchWorkspaceEntries } from './workspaceFiles.js'

const app = Fastify({ logger: true })
const activeCodexRunControllers = new Map()
const sseClients = new Set()
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
const uploadsDir = path.resolve(process.cwd(), 'uploads')
const tmpDir = path.resolve(process.cwd(), 'tmp')
const serverRootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const workspaceRootDir = path.resolve(serverRootDir, '..', '..')
const workspaceParentDir = path.dirname(workspaceRootDir)

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(tmpDir, { recursive: true })

let lastExpiredPurgeAt = 0
let sseEventId = 0

function createSseMessage(payload) {
  return `id: ${++sseEventId}\ndata: ${JSON.stringify(payload)}\n\n`
}

function writeSseMessage(target, payload) {
  if (!target || target.destroyed || target.writableEnded) {
    return false
  }

  try {
    target.write(createSseMessage(payload))
    return true
  } catch {
    return false
  }
}

function broadcastServerEvent(type, payload = {}) {
  const message = {
    type: String(type || '').trim(),
    sentAt: new Date().toISOString(),
    ...payload,
  }

  for (const client of [...sseClients]) {
    if (!writeSseMessage(client, message)) {
      sseClients.delete(client)
    }
  }
}

setInterval(() => {
  for (const client of [...sseClients]) {
    if (!client || client.destroyed || client.writableEnded) {
      sseClients.delete(client)
      continue
    }

    try {
      client.write(': ping\n\n')
    } catch {
      sseClients.delete(client)
    }
  }
}, 15000)

function getRunningSessionIdSet() {
  return new Set(listRunningCodexSessionIds())
}

function decorateCodexSession(session, runningSessionIds = getRunningSessionIdSet()) {
  if (!session) {
    return null
  }

  return {
    ...session,
    running: runningSessionIds.has(session.id),
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

function getActiveCodexRunController(runId = '') {
  return activeCodexRunControllers.get(String(runId || '').trim()) || null
}

function setActiveCodexRunController(runId = '', controller) {
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId || !controller) {
    return
  }

  activeCodexRunControllers.set(normalizedRunId, controller)
}

function clearActiveCodexRunController(runId = '') {
  const normalizedRunId = String(runId || '').trim()
  if (!normalizedRunId) {
    return
  }

  activeCodexRunControllers.delete(normalizedRunId)
}

function notifyActiveCodexRunListeners(runId = '', payload = {}) {
  const controller = getActiveCodexRunController(runId)
  if (!controller?.listeners?.size) {
    return
  }

  controller.listeners.forEach((listener) => {
    try {
      listener(payload)
    } catch {
      // Ignore observer failures to avoid affecting the run lifecycle.
    }
  })
}

function subscribeActiveCodexRun(runId = '', listener) {
  const controller = getActiveCodexRunController(runId)
  if (!controller || typeof listener !== 'function') {
    return () => {}
  }

  controller.listeners.add(listener)
  return () => {
    controller.listeners.delete(listener)
  }
}

function startCodexRunInBackground(runRecord) {
  const runId = String(runRecord?.id || '').trim()
  if (!runId) {
    return
  }

  const session = getPromptxCodexSessionById(runRecord.sessionId)
  if (!session) {
    updateCodexRun(runId, {
      status: 'error',
      errorMessage: '没有找到对应的 PromptX 会话。',
      finishedAt: new Date().toISOString(),
    })
    return
  }

  let eventSeq = 0
  let stopRequested = false

  const persistRunEvent = (payload) => {
    eventSeq += 1
    const event = appendCodexRunEvent(runId, eventSeq, payload)
    if (event) {
      broadcastServerEvent('run.event', {
        taskSlug: runRecord.taskSlug,
        runId,
        event,
      })
      notifyActiveCodexRunListeners(runId, {
        type: 'event',
        event,
      })
    }
    return event
  }

  persistRunEvent({
    type: 'session',
    session: decorateCodexSession(session),
  })

  const stream = streamPromptToCodexSession(session, runRecord.prompt, {
    onEvent(payload) {
      persistRunEvent(payload)
    },
    onThreadStarted(threadId) {
      const updatedSession = updatePromptxCodexSession(session.id, {
        codexThreadId: threadId,
      })

      if (updatedSession) {
        persistRunEvent({
          type: 'session.updated',
          session: decorateCodexSession(updatedSession),
        })
        broadcastServerEvent('sessions.changed', {
          sessionId: session.id,
        })
      }
    },
  })

  const controller = {
    listeners: new Set(),
    cancel() {
      stopRequested = true
      stream.cancel()
    },
    get stopRequested() {
      return stopRequested
    },
  }
  setActiveCodexRunController(runId, controller)

  stream.result
    .then((result) => {
      const nextRun = updateCodexRun(runId, {
        status: 'completed',
        responseMessage: result.message || '',
        errorMessage: '',
        finishedAt: new Date().toISOString(),
      })
      notifyActiveCodexRunListeners(runId, {
        type: 'run',
        run: nextRun,
      })
      broadcastServerEvent('runs.changed', {
        taskSlug: runRecord.taskSlug,
        runId,
      })
      broadcastServerEvent('sessions.changed', {
        sessionId: session.id,
      })
    })
    .catch((error) => {
      if (stopRequested) {
        persistRunEvent({
          type: 'stopped',
          message: '执行已手动停止。',
        })
        const nextRun = updateCodexRun(runId, {
          status: 'stopped',
          responseMessage: '',
          errorMessage: '',
          finishedAt: new Date().toISOString(),
        })
        notifyActiveCodexRunListeners(runId, {
          type: 'run',
          run: nextRun,
        })
        broadcastServerEvent('runs.changed', {
          taskSlug: runRecord.taskSlug,
          runId,
        })
        broadcastServerEvent('sessions.changed', {
          sessionId: session.id,
        })
        return
      }

      const nextRun = updateCodexRun(runId, {
        status: 'error',
        errorMessage: error.message || 'Codex 执行失败。',
        finishedAt: new Date().toISOString(),
      })
      notifyActiveCodexRunListeners(runId, {
        type: 'run',
        run: nextRun,
      })
      broadcastServerEvent('runs.changed', {
        taskSlug: runRecord.taskSlug,
        runId,
      })
      broadcastServerEvent('sessions.changed', {
        sessionId: session.id,
      })
    })
    .finally(() => {
      notifyActiveCodexRunListeners(runId, { type: 'close' })
      clearActiveCodexRunController(runId)
    })
}

function listLanIpv4Addresses() {
  const interfaces = os.networkInterfaces()
  const addresses = []

  Object.values(interfaces).forEach((entries) => {
    ;(entries || []).forEach((entry) => {
      if (!entry || entry.internal) {
        return
      }

      const family = typeof entry.family === 'string'
        ? entry.family
        : entry.family === 4
          ? 'IPv4'
          : ''

      if (family !== 'IPv4') {
        return
      }

      addresses.push(entry.address)
    })
  })

  return [...new Set(addresses)]
}

function buildServerAccessUrls(hostname, currentPort) {
  const normalizedHost = String(hostname || '').trim()

  if (!normalizedHost || normalizedHost === '0.0.0.0' || normalizedHost === '::') {
    return [
      `本机: http://127.0.0.1:${currentPort}`,
      ...listLanIpv4Addresses().map((address) => `局域网: http://${address}:${currentPort}`),
    ]
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

function listSiblingWorkspaceDirs(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return []
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(baseDir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function listWorkspaceSuggestions(limit = 24) {
  const seen = new Set()
  const suggestions = []

  const addPath = (targetPath) => {
    const value = String(targetPath || '').trim()
    if (!value || seen.has(value) || !fs.existsSync(value)) {
      return
    }

    try {
      if (!fs.statSync(value).isDirectory()) {
        return
      }
    } catch {
      return
    }

    seen.add(value)
    suggestions.push(value)
  }

  addPath(workspaceRootDir)
  listSiblingWorkspaceDirs(workspaceParentDir).forEach(addPath)
  listPromptxCodexSessions(limit).forEach((session) => addPath(session.cwd))
  listKnownCodexWorkspaces(limit * 2).forEach(addPath)

  return suggestions.slice(0, Math.max(1, Number(limit) || 24))
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

app.get('/health', async () => ({ ok: true }))

app.get('/api/meta', async () => ({
  expiryOptions: EXPIRY_OPTIONS,
  visibilityOptions: VISIBILITY_OPTIONS,
}))

app.get('/api/events/stream', async (request, reply) => {
  reply.hijack()
  const requestOrigin = request.headers.origin
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestOrigin ? {
      'Access-Control-Allow-Origin': requestOrigin,
      Vary: 'Origin',
    } : {}),
  })
  reply.raw.socket?.setNoDelay?.(true)
  reply.raw.flushHeaders?.()

  sseClients.add(reply.raw)
  writeSseMessage(reply.raw, {
    type: 'ready',
    sentAt: new Date().toISOString(),
  })

  const handleClose = () => {
    sseClients.delete(reply.raw)
  }

  reply.raw.on('close', handleClose)
})

app.get('/api/tasks', async () => {
  purgeExpiredContent()
  return {
    items: decorateTaskList(listTasks()),
  }
})

app.post('/api/tasks', async (request, reply) => {
  purgeExpiredContent()
  const task = createTask(request.body || {})
  broadcastServerEvent('tasks.changed', {
    taskSlug: task.slug,
  })
  return reply.code(201).send(decorateTask(task))
})

app.get('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task) {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  if (task.expired) {
    return reply.code(410).send({ message: '任务已过期。' })
  }

  return {
    ...decorateTask(task),
    canEdit: canEditTask(request.params.slug),
  }
})

app.put('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  const result = updateTask(request.params.slug, request.body || {})
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
  })
  return decorateTask(result)
})

app.delete('/api/tasks/:slug', async (request, reply) => {
  purgeExpiredContent()
  if (getRunningCodexRunByTaskSlug(request.params.slug)) {
    return reply.code(409).send({ message: '当前任务正在执行中，请先停止后再删除。' })
  }
  const result = deleteTask(request.params.slug)
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '任务不存在。' })
  }
  removeAssetFiles(result.removedAssets)
  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
  })
  return reply.code(204).send()
})

app.post('/api/tasks/:slug/codex-session', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const sessionId = String(request.body?.sessionId || '').trim()
  if (sessionId) {
    const session = getPromptxCodexSessionById(sessionId)
    if (!session) {
      return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
    }
  }

  const updatedTask = updateTaskCodexSession(request.params.slug, sessionId)
  if (!updatedTask) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
  })

  return {
    task: {
      ...decorateTask(updatedTask),
      canEdit: canEditTask(request.params.slug),
    },
  }
})

app.get('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  return {
    items: listTaskCodexRuns(request.params.slug, request.query?.limit),
  }
})

app.post('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const sessionId = String(request.body?.sessionId || '').trim()
  const prompt = String(request.body?.prompt || '').trim()

  if (!sessionId) {
    return reply.code(400).send({ message: '请先选择一个 PromptX 会话。' })
  }
  if (!prompt) {
    return reply.code(400).send({ message: '没有可发送的提示词。' })
  }

  const session = getPromptxCodexSessionById(sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  const runningRunOnSession = getRunningCodexRunBySessionId(sessionId)
  if (runningRunOnSession) {
    return reply.code(409).send({ message: '当前会话正在执行中，请等待完成后再发送。' })
  }

  const runRecord = createCodexRun({
    taskSlug: request.params.slug,
    sessionId,
    prompt,
  })

  updateTaskCodexSession(request.params.slug, sessionId)
  startCodexRunInBackground(runRecord)

  broadcastServerEvent('tasks.changed', {
    taskSlug: request.params.slug,
  })
  broadcastServerEvent('runs.changed', {
    taskSlug: request.params.slug,
    runId: runRecord.id,
  })
  broadcastServerEvent('sessions.changed', {
    sessionId,
  })

  return reply.code(201).send({
    run: getCodexRunById(runRecord.id),
    session: decorateCodexSession(getPromptxCodexSessionById(sessionId)),
  })
})

app.delete('/api/tasks/:slug/codex-runs', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).send({ message: '任务不存在。' })
  }

  const runningRun = getRunningCodexRunByTaskSlug(request.params.slug)
  if (runningRun) {
    return reply.code(409).send({ message: '当前任务正在执行中，请先停止后再清空记录。' })
  }

  deleteTaskCodexRuns(request.params.slug)
  broadcastServerEvent('runs.changed', {
    taskSlug: request.params.slug,
  })
  return reply.code(204).send()
})

app.post('/api/uploads', async (request, reply) => {
  const part = await request.file()
  if (!part) {
    return reply.code(400).send({ message: '没有收到上传文件。' })
  }
  if (!String(part.mimetype || '').startsWith('image/')) {
    return reply.code(400).send({ message: '只支持上传图片文件。' })
  }

  const tempPath = createTempFilePath(tmpDir, part.filename)
  let outputPath = ''
  let completed = false

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath))

    const image = await Jimp.read(tempPath)
    image.scaleToFit({ w: 1600, h: 1600 })

    const outputName = `${nanoid(16)}.jpg`
    outputPath = path.join(uploadsDir, outputName)
    const outputBuffer = await image.getBuffer('image/jpeg', { quality: 82 })
    fs.writeFileSync(outputPath, outputBuffer)

    const stats = fs.statSync(outputPath)
    completed = true
    return reply.code(201).send({
      url: `/uploads/${outputName}`,
      width: image.bitmap.width,
      height: image.bitmap.height,
      mimeType: 'image/jpeg',
      size: stats.size,
    })
  } finally {
    fs.rmSync(tempPath, { force: true })
    if (outputPath && !completed) {
      fs.rmSync(outputPath, { force: true })
    }
  }
})

app.post('/api/imports/pdf', async (request, reply) => {
  const part = await request.file()
  if (!part) {
    return reply.code(400).send({ message: '没有收到 PDF 文件。' })
  }

  const fileName = normalizeUploadFileName(part.filename, 'task.pdf')
  const mimetype = String(part.mimetype || '').toLowerCase()
  if (mimetype !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
    return reply.code(400).send({ message: '只支持导入 PDF 文件。' })
  }

  const tempPath = createTempFilePath(tmpDir, fileName, '.pdf')
  let createdAssets = []

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath))
    const buffer = fs.readFileSync(tempPath)
    const imported = await importPdfBlocks(buffer, {
      uploadsDir,
    })
    createdAssets = imported.createdAssets || []

    if (!imported.blocks.length) {
      removeAssetFiles(createdAssets)
      return reply.code(422).send({ message: '没有从 PDF 中提取到可导入的文本或图片。' })
    }

    return reply.code(201).send({
      fileName,
      pageCount: imported.pageCount,
      blocks: imported.blocks,
    })
  } catch (error) {
    removeAssetFiles(error.createdAssets || createdAssets)
    throw error
  } finally {
    fs.rmSync(tempPath, { force: true })
  }
})

app.get('/api/codex/sessions', async () => ({
  items: decorateCodexSessionList(listPromptxCodexSessions()),
}))

app.get('/api/codex/workspaces', async () => ({
  items: listWorkspaceSuggestions(),
}))

app.get('/api/codex/sessions/:sessionId/files/tree', async (request, reply) => {
  const session = getPromptxCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  const payload = listWorkspaceTree(session.cwd, {
    path: request.query?.path,
    limit: request.query?.limit,
  })

  return payload
})

app.get('/api/codex/sessions/:sessionId/files/search', async (request, reply) => {
  const session = getPromptxCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  const payload = searchWorkspaceEntries(session.cwd, {
    query: request.query?.q,
    limit: request.query?.limit,
  })

  return payload
})

app.post('/api/codex/sessions', async (request, reply) => {
  const session = createPromptxCodexSession(request.body || {})
  broadcastServerEvent('sessions.changed', {
    sessionId: session.id,
  })
  return reply.code(201).send(decorateCodexSession(session))
})

app.patch('/api/codex/sessions/:sessionId', async (request, reply) => {
  const session = updatePromptxCodexSession(request.params.sessionId, request.body || {})
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  broadcastServerEvent('sessions.changed', {
    sessionId: session.id,
  })
  return decorateCodexSession(session)
})

app.delete('/api/codex/sessions/:sessionId', async (request, reply) => {
  if (getRunningCodexRunBySessionId(request.params.sessionId)) {
    return reply.code(409).send({ message: '当前会话正在执行中，请先停止后再删除。' })
  }
  clearTaskCodexSessionReferences(request.params.sessionId)
  const session = deletePromptxCodexSession(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  broadcastServerEvent('sessions.changed', {
    sessionId: request.params.sessionId,
  })
  broadcastServerEvent('tasks.changed')
  return reply.code(204).send()
})

app.post('/api/codex/sessions/:sessionId/send', async (request, reply) => {
  const session = getPromptxCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 PromptX 会话。' })
  }

  const prompt = String(request.body?.prompt || '').trim()
  if (!prompt) {
    return reply.code(400).send({ message: '没有收到可发送的提示词。' })
  }

  const result = await sendPromptToCodexSession(session, prompt)
  const nextSession = updatePromptxCodexSession(session.id, {
    codexThreadId: result.threadId || session.codexThreadId,
  }) || session

  broadcastServerEvent('sessions.changed', {
    sessionId: session.id,
  })

  return {
    session: decorateCodexSession(nextSession),
    message: result.message,
    rawStdout: result.rawStdout,
  }
})

app.post('/api/codex/runs/:runId/stop', async (request, reply) => {
  const runRecord = getCodexRunById(request.params.runId)
  if (!runRecord) {
    return reply.code(404).send({ message: '没有找到对应的执行记录。' })
  }

  if (runRecord.status !== 'running') {
    return { run: runRecord }
  }

  const controller = getActiveCodexRunController(request.params.runId)
  if (!controller) {
    const stoppedRun = updateCodexRun(request.params.runId, {
      status: 'stopped',
      finishedAt: new Date().toISOString(),
    })
    broadcastServerEvent('runs.changed', {
      taskSlug: stoppedRun?.taskSlug,
      runId: request.params.runId,
    })
    broadcastServerEvent('sessions.changed', {
      sessionId: stoppedRun?.sessionId,
    })
    return { run: stoppedRun }
  }

  controller.cancel()
  return reply.code(202).send({
    run: getCodexRunById(request.params.runId),
  })
})

app.get('/api/codex/runs/:runId/stream', async (request, reply) => {
  const runRecord = getCodexRunById(request.params.runId)
  if (!runRecord) {
    return reply.code(404).send({ message: '没有找到对应的执行记录。' })
  }

  reply.hijack()
  const requestOrigin = request.headers.origin
  reply.raw.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
    ...(requestOrigin ? {
      'Access-Control-Allow-Origin': requestOrigin,
      Vary: 'Origin',
    } : {}),
  })
  reply.raw.socket?.setNoDelay?.(true)
  reply.raw.flushHeaders?.()

  const writeMessage = (payload) => {
    if (reply.raw.destroyed || reply.raw.writableEnded) {
      return
    }

    try {
      reply.raw.write(`${JSON.stringify(payload)}
`)
    } catch {
      // Ignore write failures after the client disconnects.
    }
  }

  const closeStream = () => {
    if (!reply.raw.destroyed && !reply.raw.writableEnded) {
      reply.raw.end()
    }
  }

  writeMessage({
    type: 'run',
    run: runRecord,
  })

  const afterSeq = Math.max(0, Number(request.query?.afterSeq) || 0)
  const existingEvents = listCodexRunEvents(request.params.runId, {
    afterSeq,
  }) || []

  existingEvents.forEach((event) => {
    writeMessage({
      type: 'event',
      event,
    })
  })

  const latestRun = getCodexRunById(request.params.runId)
  if (!latestRun || latestRun.status !== 'running' || !getActiveCodexRunController(request.params.runId)) {
    writeMessage({
      type: 'run',
      run: latestRun || runRecord,
    })
    closeStream()
    return
  }

  const unsubscribe = subscribeActiveCodexRun(request.params.runId, (payload) => {
    writeMessage(payload)
    if (payload.type === 'close') {
      closeStream()
    }
  })

  const handleAbort = () => {
    unsubscribe()
  }

  reply.raw.on('close', handleAbort)
})

app.get('/api/tasks/:slug/raw', async (request, reply) => {
  purgeExpiredContent()
  const task = getTaskBySlug(request.params.slug)
  if (!task || task.expired) {
    return reply.code(404).type('text/plain; charset=utf-8').send('任务不存在。')
  }

  const exports = buildTaskExports(task)
  return reply.type('text/plain; charset=utf-8').send(exports.raw)
})

app.setErrorHandler((error, request, reply) => {
  request.log.error(error)
  const message = error.statusCode === 413 ? '文件太大了。' : error.message || '发生了意外错误。'
  reply.code(error.statusCode || 500).send({ message })
})

markInterruptedCodexRuns()
purgeExpiredContent(true)

app.listen({ port, host }).then(() => {
  app.log.info(`server running at http://${host}:${port}`)
  buildServerAccessUrls(host, port).forEach((message) => {
    app.log.info(message)
  })
})

