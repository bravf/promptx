import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import Fastify from 'fastify'
import cors from '@fastify/cors'
import multipart from '@fastify/multipart'
import fastifyStatic from '@fastify/static'
import { Jimp } from 'jimp'
import { nanoid } from 'nanoid'
import { EXPIRY_OPTIONS, VISIBILITY_OPTIONS } from '@promptx/shared'
import {
  buildDocumentExports,
  canEditDocument,
  createDocument,
  deleteDocument,
  getDocumentBySlug,
  listDocuments,
  purgeExpiredDocuments,
  updateDocument,
} from './repository.js'
import {
  getCodexSessionById,
  listCodexSessions,
  sendPromptToCodexSession,
  streamPromptToCodexSession,
} from './codex.js'
import { importPdfDocument } from './pdf.js'
import { createTempFilePath, normalizeUploadFileName } from './upload.js'

const app = Fastify({ logger: true })
const port = Number(process.env.PORT || 3000)
const host = process.env.HOST || '0.0.0.0'
const uploadsDir = path.resolve(process.cwd(), 'uploads')
const tmpDir = path.resolve(process.cwd(), 'tmp')

fs.mkdirSync(uploadsDir, { recursive: true })
fs.mkdirSync(tmpDir, { recursive: true })

let lastExpiredPurgeAt = 0

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
  const result = purgeExpiredDocuments(new Date(now).toISOString())
  if (result.removedAssets.length) {
    removeAssetFiles(result.removedAssets)
  }
}

await app.register(cors, {
  origin: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type'],
})

await app.register(multipart, {
  limits: {
    fileSize: 30 * 1024 * 1024,
    files: 1,
  },
})

await app.register(fastifyStatic, {
  root: uploadsDir,
  prefix: '/uploads/',
})

app.get('/health', async () => ({ ok: true }))

app.get('/api/meta', async () => ({
  expiryOptions: EXPIRY_OPTIONS,
  visibilityOptions: VISIBILITY_OPTIONS,
}))

app.get('/api/documents', async () => {
  purgeExpiredContent()
  return {
    items: listDocuments(),
  }
})

app.post('/api/documents', async (request, reply) => {
  purgeExpiredContent()
  const document = createDocument(request.body || {})
  return reply.code(201).send(document)
})

app.get('/api/documents/:slug', async (request, reply) => {
  purgeExpiredContent()
  const document = getDocumentBySlug(request.params.slug)
  if (!document) {
    return reply.code(404).send({ message: '文档不存在。' })
  }
  if (document.expired) {
    return reply.code(410).send({ message: '文档已过期。' })
  }

  return {
    ...document,
    canEdit: canEditDocument(request.params.slug),
  }
})

app.put('/api/documents/:slug', async (request, reply) => {
  purgeExpiredContent()
  const result = updateDocument(request.params.slug, request.body || {})
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '文档不存在。' })
  }
  return result
})

app.delete('/api/documents/:slug', async (request, reply) => {
  purgeExpiredContent()
  const result = deleteDocument(request.params.slug)
  if (result.error === 'not_found') {
    return reply.code(404).send({ message: '文档不存在。' })
  }
  removeAssetFiles(result.removedAssets)
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

  const fileName = normalizeUploadFileName(part.filename, 'document.pdf')
  const mimetype = String(part.mimetype || '').toLowerCase()
  if (mimetype !== 'application/pdf' && !fileName.toLowerCase().endsWith('.pdf')) {
    return reply.code(400).send({ message: '只支持导入 PDF 文件。' })
  }

  const tempPath = createTempFilePath(tmpDir, fileName, '.pdf')
  let createdAssets = []

  try {
    await pipeline(part.file, fs.createWriteStream(tempPath))
    const buffer = fs.readFileSync(tempPath)
    const imported = await importPdfDocument(buffer, {
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

app.get('/api/codex/sessions', async () => {
  return {
    items: listCodexSessions(),
  }
})

app.post('/api/codex/sessions/:sessionId/send', async (request, reply) => {
  const session = getCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 Codex session。' })
  }

  const prompt = String(request.body?.prompt || '').trim()
  if (!prompt) {
    return reply.code(400).send({ message: '没有收到可发送的提示词。' })
  }

  const result = await sendPromptToCodexSession(session.id, prompt)
  return {
    session,
    message: result.message,
    rawStdout: result.rawStdout,
  }
})

app.post('/api/codex/sessions/:sessionId/send-stream', async (request, reply) => {
  const session = getCodexSessionById(request.params.sessionId)
  if (!session) {
    return reply.code(404).send({ message: '没有找到对应的 Codex session。' })
  }

  const prompt = String(request.body?.prompt || '').trim()
  if (!prompt) {
    return reply.code(400).send({ message: '没有收到可发送的提示词。' })
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

  const writeEvent = (payload) => {
    reply.raw.write(`${JSON.stringify(payload)}\n`)
  }

  writeEvent({
    type: 'session',
    session,
  })

  const stream = streamPromptToCodexSession(session.id, prompt, {
    onEvent(event) {
      writeEvent(event)
    },
  })

  const handleAbort = () => {
    stream.cancel()
  }

  reply.raw.on('close', handleAbort)

  try {
    await stream.result
  } catch (error) {
    writeEvent({
      type: 'error',
      message: error.message || 'Codex 执行失败。',
    })
  } finally {
    reply.raw.off('close', handleAbort)
    reply.raw.end()
  }
})

app.get('/p/:slug/raw', async (request, reply) => {
  purgeExpiredContent()
  const document = getDocumentBySlug(request.params.slug)
  if (!document || document.expired) {
    return reply.code(404).type('text/plain; charset=utf-8').send('文档不存在。')
  }

  const exports = buildDocumentExports(document)
  return reply.type('text/plain; charset=utf-8').send(exports.raw)
})

app.setErrorHandler((error, request, reply) => {
  request.log.error(error)
  const message = error.statusCode === 413 ? '文件太大了。' : error.message || '发生了意外错误。'
  reply.code(error.statusCode || 500).send({ message })
})

purgeExpiredContent(true)

app.listen({ port, host }).then(() => {
  app.log.info(`server running at http://${host}:${port}`)
  buildServerAccessUrls(host, port).forEach((message) => {
    app.log.info(message)
  })
})
