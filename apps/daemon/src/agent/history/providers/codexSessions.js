import { JsonRpcProcess } from '../../jsonRpcProcess.js'
import { CODEX_BIN } from '../../providers/codexCli.js'

function unixSecondsToIso(value) {
  if (!Number.isFinite(Number(value))) return ''
  return new Date(Number(value) * 1000).toISOString()
}

export async function listCodexHistorySessions() {
  const rpc = new JsonRpcProcess(CODEX_BIN, ['app-server', '--stdio'], { cwd: process.cwd() })
  try {
    await rpc.request('initialize', {
      clientInfo: { name: 'promptx-import', title: 'PromptX', version: '2.0.0' },
      capabilities: { experimentalApi: true },
    })
    rpc.notify('initialized', {})
    const sessions = []
    // Codex 当前版本只支持单次非分页查询；带 cursor 会返回 paginated_threads 错误。
    const page = await rpc.request('thread/list', { limit: 500 })
    for (const thread of page.data || []) {
      if (thread.parentThreadId || thread.source?.subAgent || thread.source?.sub_agent) continue
      const preview = String(thread.preview || thread.name || '').trim()
      sessions.push({
        providerId: 'codex',
        providerHandleId: thread.id || thread.sessionId,
        cwd: thread.cwd || '',
        title: String(thread.name || preview || 'Codex 会话').slice(0, 80),
        firstPromptPreview: preview.slice(0, 160),
        lastPromptPreview: preview.slice(0, 160),
        lastActivityAt: unixSecondsToIso(thread.recencyAt || thread.updatedAt || thread.createdAt),
      })
    }
    return sessions
  } finally {
    rpc.close()
  }
}

