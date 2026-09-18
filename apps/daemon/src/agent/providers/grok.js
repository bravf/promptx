import { createAcpProvider } from './acp.js'
import { listGrokHistorySessions, readGrokHistorySnapshot } from '../history/providers/grokHistory.js'

export const GROK_ACP_ARGS = Object.freeze(['agent', '--always-approve', '--no-leader', 'stdio'])

export function grokExtensionNotification(method, params) {
  if (method !== '_x.ai/session/update') return null
  const update = params.update
  if (update?.sessionUpdate !== 'retry_state' || update.type !== 'retrying') return null
  return { type: 'system_notice', code: 'provider_retrying', text: update.reason || '模型服务连接异常，正在自动重试。' }
}

export const grokProvider = createAcpProvider({
  id: 'grok',
  label: 'Grok',
  command: () => process.env.GROK_BIN || 'grok',
  args: () => GROK_ACP_ARGS,
  capabilities: { resume: true, images: true, models: true, reasoningEffort: true, contextUsage: false },
  extensionNotification: grokExtensionNotification,
  readHistorySnapshot: readGrokHistorySnapshot,
  listHistorySessions: listGrokHistorySessions,
})
