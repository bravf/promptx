import {
  extractRunnerDispatchPatch,
  reconcileRunAfterRunnerDispatchError,
} from './runnerDispatch.js'
import { extractShellCommandIntent } from '../../../packages/shared/src/index.js'
import { createApiError } from './apiErrors.js'

function normalizeBaseUrl(value = '') {
  return String(value || '').trim().replace(/\/+$/, '')
}

function normalizeUploadPath(value = '') {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  if (text.startsWith('/')) {
    const [pathname = '', search = ''] = text.split('?')
    return pathname.startsWith('/uploads/') ? `${pathname}${search ? `?${search}` : ''}` : ''
  }

  try {
    const url = new URL(text)
    return url.pathname.startsWith('/uploads/') ? `${url.pathname}${url.search || ''}` : ''
  } catch {
    return ''
  }
}

function buildLocalUploadUrl(value = '', localServerBaseUrl = '') {
  const normalizedBaseUrl = normalizeBaseUrl(localServerBaseUrl)
  const uploadPath = normalizeUploadPath(value)
  if (!normalizedBaseUrl || !uploadPath) {
    return String(value || '').trim()
  }

  try {
    return new URL(uploadPath, `${normalizedBaseUrl}/`).toString()
  } catch {
    return `${normalizedBaseUrl}${uploadPath.startsWith('/') ? '' : '/'}${uploadPath}`
  }
}

function rewritePromptUploadsToLocal(prompt = '', options = {}) {
  const text = String(prompt || '').trim()
  const localServerBaseUrl = String(options.localServerBaseUrl || '').trim()
  if (!text || !localServerBaseUrl) {
    return text
  }

  const candidates = text.match(/https?:\/\/[^\s"'`<>]+/g) || []

  let nextPrompt = text
  candidates.forEach((candidate) => {
    const localUrl = buildLocalUploadUrl(candidate, localServerBaseUrl)
    if (normalizeUploadPath(candidate) && localUrl && candidate !== localUrl) {
      nextPrompt = nextPrompt.split(candidate).join(localUrl)
    }
  })
  return nextPrompt
}

function buildRunnerPromptPayload(session = {}, input = {}, options = {}) {
  const prompt = String(input.prompt || '').trim()
  const promptBlocks = Array.isArray(input.promptBlocks) ? input.promptBlocks : []

  const nextPromptBlocks = promptBlocks.map((block) => {
    if (String(block?.type || '').trim() !== 'image') {
      return block
    }

    return {
      ...block,
      meta: block?.meta ? { ...block.meta } : {},
      content: buildLocalUploadUrl(block?.content, options.localServerBaseUrl),
    }
  })

  return {
    prompt: rewritePromptUploadsToLocal(prompt, options),
    promptBlocks: nextPromptBlocks,
  }
}

function normalizeCommandMode(value = '') {
  const normalized = String(value || '').trim().toLowerCase()
  return normalized === 'shell' ? 'shell' : ''
}

export function createRunDispatchService(options = {}) {
  const runnerClient = options.runnerClient
  const logger = options.logger || console
  const getTaskBySlug = options.getTaskBySlug || (() => null)
  const getPromptxCodexSessionById = options.getPromptxCodexSessionById || (() => null)
  const getRunningCodexRunBySessionId = options.getRunningCodexRunBySessionId || (() => null)
  const createCodexRun = options.createCodexRun || (() => null)
  const getCodexRunById = options.getCodexRunById || (() => null)
  const updateCodexRunFromRunnerStatus = options.updateCodexRunFromRunnerStatus || (() => null)
  const updateTaskCodexSession = options.updateTaskCodexSession || (() => null)
  const decorateCodexSession = options.decorateCodexSession || ((session) => session)
  const broadcastServerEvent = options.broadcastServerEvent || (() => {})
  const localServerBaseUrl = String(options.localServerBaseUrl || '').trim()
  const publicServerBaseUrl = String(options.publicServerBaseUrl || '').trim()
  const relayUrl = String(options.relayUrl || '').trim()

  async function startTaskRunForTask(payload = {}) {
    const normalizedTaskSlug = String(payload.taskSlug || '').trim()
    const requestedSessionId = String(payload.sessionId || '').trim()
    const normalizedProjectSessionId = String(payload.projectSessionId || requestedSessionId).trim()
    const normalizedPrompt = String(payload.prompt || '').trim()
    const promptBlocks = Array.isArray(payload.promptBlocks) ? payload.promptBlocks : []
    const displayEngine = String(payload.displayEngine || '').trim()
    const requestedCommandMode = normalizeCommandMode(payload.commandMode)
    const shellIntent = extractShellCommandIntent({
      prompt: normalizedPrompt,
      promptBlocks,
    })
    const commandMode = shellIntent.mode === 'shell' ? 'shell' : ''
    const normalizedCommand = commandMode === 'shell' ? shellIntent.command : ''
    const allowShellCommand = payload.allowShellCommand === true

    if (!normalizedTaskSlug) {
      throw createApiError('errors.taskNotFound', '任务不存在。', 404)
    }
    if (!requestedSessionId) {
      throw createApiError('errors.sessionRequired', '请先选择一个 PromptX 项目。')
    }
    if (!normalizedPrompt) {
      throw createApiError('errors.noPromptToSend', '没有可发送的提示词。')
    }
    if (requestedCommandMode === 'shell' && shellIntent.reason === 'unsupported_blocks') {
      throw createApiError('errors.shellUnsupportedBlocks', '命令模式暂不支持图片或导入文件，请只保留纯文本命令。', 400)
    }
    if (requestedCommandMode === 'shell' && shellIntent.reason === 'empty_command') {
      throw createApiError('errors.shellEmptyCommand', '请输入要执行的命令，例如 !git status', 400)
    }
    if (commandMode === 'shell' && !allowShellCommand) {
      throw createApiError('errors.shellLocalOnly', '当前入口未被允许执行命令。请在设置 -> 通用 -> 远程命令安全中启用对应模式，或改为本机本地访问。', 403)
    }

    const task = getTaskBySlug(normalizedTaskSlug)
    if (!task || task.expired) {
      throw createApiError('errors.taskNotFound', '任务不存在。', 404)
    }

    const requestedSession = getPromptxCodexSessionById(requestedSessionId)
    if (!requestedSession) {
      throw createApiError('errors.sessionNotFound', '没有找到对应的 PromptX 项目。', 404)
    }
    const projectSession = normalizedProjectSessionId === requestedSessionId
      ? requestedSession
      : getPromptxCodexSessionById(normalizedProjectSessionId)
    if (!projectSession) {
      throw createApiError('errors.sessionNotFound', '没有找到对应的 PromptX 项目。', 404)
    }
    const session = commandMode === 'shell' ? projectSession : requestedSession
    const normalizedSessionId = String(session?.id || '').trim()

    const relatedSessionIds = new Set([
      normalizedProjectSessionId,
      ...((Array.isArray(projectSession.agentBindings) ? projectSession.agentBindings : [])
        .map((item) => String(item?.sessionRecordId || '').trim())
        .filter(Boolean)),
    ])
    const runningRunOnProject = [...relatedSessionIds]
      .map((sessionId) => getRunningCodexRunBySessionId(sessionId))
      .find(Boolean)

    if (runningRunOnProject) {
      throw createApiError('errors.currentProjectRunning', '当前项目正在执行中，请等待完成后再发送。', 409)
    }

    const runEngine = commandMode === 'shell' ? 'shell' : (session.engine || 'codex')
    const runnerPrompt = commandMode === 'shell' ? normalizedCommand : normalizedPrompt

    const runRecord = createCodexRun({
      taskSlug: normalizedTaskSlug,
      sessionId: normalizedSessionId,
      prompt: normalizedPrompt,
      promptBlocks,
      engine: runEngine,
      displayEngine,
      status: 'queued',
    })

    updateTaskCodexSession(normalizedTaskSlug, normalizedProjectSessionId)

    let acceptedRun = runRecord
    let runnerDispatchPending = false

    try {
      const runnerPromptPayload = buildRunnerPromptPayload(session, {
        prompt: runnerPrompt,
        promptBlocks,
      }, {
        localServerBaseUrl,
        publicServerBaseUrl,
        relayUrl,
      })

      const runnerPayload = await runnerClient.startRun({
        runId: runRecord.id,
        taskSlug: normalizedTaskSlug,
        sessionId: normalizedSessionId,
        engine: runEngine,
        prompt: runnerPromptPayload.prompt,
        promptBlocks: runnerPromptPayload.promptBlocks,
        cwd: session.cwd,
        title: session.title,
        codexThreadId: commandMode === 'shell' ? '' : session.codexThreadId,
        engineSessionId: commandMode === 'shell' ? '' : session.engineSessionId,
        engineThreadId: commandMode === 'shell' ? '' : session.engineThreadId,
        engineMeta: commandMode === 'shell' ? {} : session.engineMeta,
        sessionCreatedAt: session.createdAt,
        sessionUpdatedAt: session.updatedAt,
      })

      acceptedRun = updateCodexRunFromRunnerStatus(runRecord.id, {
        ...extractRunnerDispatchPatch(runnerPayload, 'queued'),
        updatedAt: new Date().toISOString(),
      })
    } catch (error) {
      const reconciled = await reconcileRunAfterRunnerDispatchError({
        runId: runRecord.id,
        error,
        runnerClient,
        fallbackStatus: 'queued',
        logger,
      })

      if (reconciled?.run) {
        acceptedRun = reconciled.run
        runnerDispatchPending = Boolean(reconciled.pending)
      } else {
        const failedRun = updateCodexRunFromRunnerStatus(runRecord.id, {
          status: 'error',
          errorMessage: error.message || 'Runner 启动失败。',
          finishedAt: new Date().toISOString(),
        })
        broadcastServerEvent('runs.changed', {
          taskSlug: normalizedTaskSlug,
          runId: failedRun?.id || runRecord.id,
          status: failedRun?.status || 'error',
        })
        throw error
      }
    }

    broadcastServerEvent('tasks.changed', {
      taskSlug: normalizedTaskSlug,
      reason: 'session-linked',
    })
    broadcastServerEvent('runs.changed', {
      taskSlug: normalizedTaskSlug,
      runId: acceptedRun?.id || runRecord.id,
      status: acceptedRun?.status || 'queued',
    })
    broadcastServerEvent('sessions.changed', {
      sessionId: normalizedProjectSessionId,
    })

    return {
      run: acceptedRun || getCodexRunById(runRecord.id),
      session: decorateCodexSession(getPromptxCodexSessionById(normalizedProjectSessionId)),
      runnerDispatchPending,
    }
  }

  async function requestRunStop(runId, payload = {}) {
    const normalizedRunId = String(runId || '').trim()
    if (!normalizedRunId) {
      return null
    }

    const runRecord = getCodexRunById(normalizedRunId)
    if (!runRecord) {
      return null
    }

    if (!payload.force && (!payload.isActiveRunStatus?.(runRecord.status) || runRecord.status === 'stopping')) {
      return {
        run: runRecord,
        accepted: false,
      }
    }

    const stoppingRun = updateCodexRunFromRunnerStatus(normalizedRunId, {
      status: 'stopping',
    })

    broadcastServerEvent('runs.changed', {
      taskSlug: stoppingRun?.taskSlug,
      runId: normalizedRunId,
      status: stoppingRun?.status || 'stopping',
    })
    broadcastServerEvent('sessions.changed', {
      sessionId: stoppingRun?.sessionId,
    })

    runnerClient.stopRun(normalizedRunId, {
      reason: String(payload.reason || 'user_requested').trim() || 'user_requested',
      forceAfterMs: payload.forceAfterMs,
    }).catch(async (error) => {
      logger.warn?.(error, 'runner stop dispatch failed')

      const reconciled = await reconcileRunAfterRunnerDispatchError({
        runId: normalizedRunId,
        error,
        runnerClient,
        fallbackStatus: 'stopping',
        allowNotFound: true,
        logger,
      })

      const nextRun = reconciled?.run || getCodexRunById(normalizedRunId)
      if (nextRun?.id && nextRun.status !== (stoppingRun?.status || 'stopping')) {
        broadcastServerEvent('runs.changed', {
          taskSlug: nextRun.taskSlug || stoppingRun?.taskSlug,
          runId: normalizedRunId,
          status: nextRun.status,
        })
        if (nextRun.sessionId || stoppingRun?.sessionId) {
          broadcastServerEvent('sessions.changed', {
            sessionId: nextRun.sessionId || stoppingRun?.sessionId,
          })
        }
        return
      }

      logger.warn?.({
        runId: normalizedRunId,
        statusCode: error?.statusCode,
        runnerDispatchPending: Boolean(reconciled?.pending),
      }, 'runner stop request left run in stopping state')
    })

    return {
      run: getCodexRunById(normalizedRunId),
      accepted: true,
    }
  }

  return {
    requestRunStop,
    startTaskRunForTask,
  }
}
