import fs from 'node:fs'
import path from 'node:path'

function listSiblingWorkspaceDirs(baseDir) {
  if (!baseDir || !fs.existsSync(baseDir)) {
    return []
  }

  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => path.join(baseDir, entry.name))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

function createWorkspaceSuggestionService(options = {}) {
  const listKnownWorkspacesByEngine = options.listKnownWorkspacesByEngine || (() => [])
  const listPromptxCodexSessions = options.listPromptxCodexSessions || (() => [])
  const workspaceParentDir = options.workspaceParentDir || ''
  const workspaceRootDir = options.workspaceRootDir || ''

  function listWorkspaceSuggestions(limit = 24, engine = 'codex') {
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
    listKnownWorkspacesByEngine(engine, limit * 2).forEach(addPath)

    return suggestions.slice(0, Math.max(1, Number(limit) || 24))
  }

  return {
    listWorkspaceSuggestions,
  }
}

function registerCodexRoutes(app, options = {}) {
  const {
    broadcastServerEvent = () => {},
    clearTaskCodexSessionReferences,
    createPromptxCodexSession,
    decorateCodexSession,
    decorateCodexSessionList,
    deletePromptxCodexSession,
    deleteTaskCodexRuns = () => {},
    getCodexRunById,
    getPromptxCodexSessionById,
    getRunningCodexRunBySessionId,
    getRunningCodexRunByTaskSlug = () => null,
    isActiveRunStatus,
    listCodexRunEvents,
    listDirectoryPickerTree,
    listKnownSessionsByEngine = () => [],
    listPromptxCodexSessions,
    listTaskSlugsByCodexSessionId = () => [],
    listWorkspaceSuggestions,
    listWorkspaceTree,
    readWorkspaceFileBlame,
    readWorkspaceFileContent,
    resetPromptxCodexSession = () => null,
    runDispatchService,
    searchDirectoryPickerEntries,
    searchWorkspaceFileContent,
    searchWorkspaceEntries,
    updatePromptxCodexSession,
  } = options

  function getProjectRelatedSessionIds(session = null) {
    const ids = new Set()
    const rootId = String(session?.id || '').trim()
    if (rootId) {
      ids.add(rootId)
    }

    ;(Array.isArray(session?.agentBindings) ? session.agentBindings : []).forEach((item) => {
      const memberId = String(item?.sessionRecordId || '').trim()
      if (memberId) {
        ids.add(memberId)
      }
    })

    return [...ids]
  }

  function findRunningProjectRun(session = null) {
    const sessionIds = getProjectRelatedSessionIds(session)
    return sessionIds
      .map((sessionId) => getRunningCodexRunBySessionId(sessionId))
      .find(Boolean) || null
  }

  app.get('/api/codex/sessions', async () => ({
    items: decorateCodexSessionList(listPromptxCodexSessions()),
  }))

  app.get('/api/codex/workspaces', async (request) => ({
    items: listWorkspaceSuggestions(24, request.query?.engine),
  }))

  app.get('/api/codex/session-candidates', async (request) => ({
    items: listKnownSessionsByEngine(request.query?.engine, {
      cwd: request.query?.cwd,
      limit: request.query?.limit,
    }),
  }))

  app.get('/api/codex/directories/tree', async (request) => (
    listDirectoryPickerTree({
      path: request.query?.path,
      limit: request.query?.limit,
    })
  ))

  app.get('/api/codex/directories/search', async (request) => (
    searchDirectoryPickerEntries({
      path: request.query?.path,
      query: request.query?.q,
      limit: request.query?.limit,
    })
  ))

  app.get('/api/codex/sessions/:sessionId/files/tree', async (request, reply) => {
    const session = getPromptxCodexSessionById(request.params.sessionId)
    if (!session) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    return listWorkspaceTree(session.cwd, {
      path: request.query?.path,
      limit: request.query?.limit,
    })
  })

  app.get('/api/codex/sessions/:sessionId/files/search', async (request, reply) => {
    const session = getPromptxCodexSessionById(request.params.sessionId)
    if (!session) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    return searchWorkspaceEntries(session.cwd, {
      query: request.query?.q,
      limit: request.query?.limit,
    })
  })

  app.get('/api/codex/sessions/:sessionId/files/content', async (request, reply) => {
    const session = getPromptxCodexSessionById(request.params.sessionId)
    if (!session) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    return readWorkspaceFileContent(session.cwd, {
      path: request.query?.path,
      limit: request.query?.limit,
    })
  })

  app.get('/api/codex/sessions/:sessionId/files/blame', async (request, reply) => {
    const session = getPromptxCodexSessionById(request.params.sessionId)
    if (!session) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    return readWorkspaceFileBlame(session.cwd, {
      path: request.query?.path,
    })
  })

  app.get('/api/codex/sessions/:sessionId/files/content-search', async (request, reply) => {
    const session = getPromptxCodexSessionById(request.params.sessionId)
    if (!session) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    return searchWorkspaceFileContent(session.cwd, {
      query: request.query?.q,
      limit: request.query?.limit,
    })
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
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    broadcastServerEvent('sessions.changed', {
      sessionId: session.id,
    })
    return decorateCodexSession(session)
  })

  app.post('/api/codex/sessions/:sessionId/reset', async (request, reply) => {
    const sessionId = String(request.params.sessionId || '').trim()
    const projectSession = getPromptxCodexSessionById(sessionId)
    if (!projectSession) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    if (findRunningProjectRun(projectSession)) {
      return reply.code(409).send({
        messageKey: 'errors.currentProjectRunning',
        message: '当前项目正在执行中，请先停止后再新建会话。',
      })
    }

    const affectedTaskSlugs = listTaskSlugsByCodexSessionId(sessionId)
    const runningTaskSlug = affectedTaskSlugs.find((taskSlug) => getRunningCodexRunByTaskSlug(taskSlug))
    if (runningTaskSlug) {
      return reply.code(409).send({
        messageKey: 'errors.currentProjectRunning',
        message: '当前项目正在执行中，请先停止后再新建会话。',
      })
    }

    const session = resetPromptxCodexSession(sessionId)

    affectedTaskSlugs.forEach((taskSlug) => {
      deleteTaskCodexRuns(taskSlug)
    })

    broadcastServerEvent('sessions.changed', {
      sessionId: session.id,
    })
    affectedTaskSlugs.forEach((taskSlug) => {
      broadcastServerEvent('runs.changed', {
        taskSlug,
      })
    })

    return {
      session: decorateCodexSession(session),
      affectedTaskSlugs,
    }
  })

  app.delete('/api/codex/sessions/:sessionId', async (request, reply) => {
    const projectSession = getPromptxCodexSessionById(request.params.sessionId)
    if (!projectSession) {
      return reply.code(404).send({ messageKey: 'errors.sessionNotFound', message: '没有找到对应的 PromptX 项目。' })
    }

    if (findRunningProjectRun(projectSession)) {
      return reply.code(409).send({
        messageKey: 'errors.currentProjectDeleteWhileRunning',
        message: '当前项目正在执行中，请先停止后再删除。',
      })
    }

    const affectedTaskSlugs = clearTaskCodexSessionReferences(request.params.sessionId)
    const session = deletePromptxCodexSession(request.params.sessionId)

    broadcastServerEvent('sessions.changed', {
      sessionId: request.params.sessionId,
    })
    if (affectedTaskSlugs.length) {
      affectedTaskSlugs.forEach((taskSlug) => {
        broadcastServerEvent('tasks.changed', {
          taskSlug,
          reason: 'session-cleared',
        })
      })
    } else {
      broadcastServerEvent('tasks.changed', {
        reason: 'session-cleared',
      })
    }

    return reply.code(204).send()
  })

  app.post('/api/codex/runs/:runId/stop', async (request, reply) => {
    const runRecord = getCodexRunById(request.params.runId)
    if (!runRecord) {
      return reply.code(404).send({ messageKey: 'errors.runNotFound', message: '没有找到对应的执行记录。' })
    }

    const stopResult = await runDispatchService.requestRunStop(request.params.runId, {
      forceAfterMs: request.body?.forceAfterMs,
      isActiveRunStatus,
      reason: request.body?.reason,
    })

    if (!stopResult?.accepted) {
      return {
        run: stopResult?.run || runRecord,
      }
    }

    return reply.code(202).send({
      run: stopResult.run || getCodexRunById(request.params.runId),
    })
  })

  app.get('/api/codex/runs/:runId/events', async (request, reply) => {
    const runRecord = getCodexRunById(request.params.runId)
    if (!runRecord) {
      return reply.code(404).send({ messageKey: 'errors.runNotFound', message: '没有找到对应的执行记录。' })
    }

    return {
      items: listCodexRunEvents(request.params.runId, {
        afterSeq: request.query?.afterSeq,
        limit: request.query?.limit,
      }) || [],
    }
  })

  app.get('/api/codex/runs/:runId/stream', async (request, reply) => {
    const runRecord = getCodexRunById(request.params.runId)
    if (!runRecord) {
      return reply.code(404).send({ messageKey: 'errors.runNotFound', message: '没有找到对应的执行记录。' })
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
        return false
      }

      try {
        reply.raw.write(`${JSON.stringify(payload)}\n`)
        return true
      } catch {
        return false
      }
    }

    let lastSentSeq = Math.max(0, Number(request.query?.afterSeq) || 0)
    let pollTimer = null

    const closeStream = () => {
      if (pollTimer) {
        clearInterval(pollTimer)
        pollTimer = null
      }
      if (!reply.raw.destroyed && !reply.raw.writableEnded) {
        reply.raw.end()
      }
    }

    const flushRunState = () => {
      const latestRun = getCodexRunById(request.params.runId)
      if (!latestRun) {
        closeStream()
        return
      }

      writeMessage({
        type: 'run',
        run: latestRun,
      })

      const batchLimit = 500
      const nextEvents = listCodexRunEvents(request.params.runId, {
        afterSeq: lastSentSeq,
        limit: batchLimit,
      }) || []

      nextEvents.forEach((event) => {
        lastSentSeq = Math.max(lastSentSeq, Number(event.seq) || 0)
        writeMessage({
          type: 'event',
          event,
        })
      })

      if (!isActiveRunStatus(latestRun.status) && nextEvents.length < batchLimit) {
        closeStream()
      }
    }

    flushRunState()
    if (!reply.raw.destroyed && !reply.raw.writableEnded && isActiveRunStatus(getCodexRunById(request.params.runId)?.status)) {
      pollTimer = setInterval(flushRunState, 350)
      pollTimer.unref?.()
    }

    reply.raw.on('close', closeStream)
  })
}

export {
  createWorkspaceSuggestionService,
  listSiblingWorkspaceDirs,
  registerCodexRoutes,
}
