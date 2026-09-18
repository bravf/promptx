import { createAcpProvider } from './acp.js'
import { listKimiHistorySessions, readKimiHistorySnapshot } from '../history/providers/kimiHistory.js'

export const kimiProvider = createAcpProvider({
  id: 'kimi',
  label: 'Kimi',
  command: () => process.env.KIMI_CODE_BIN || 'kimi',
  args: ['acp'],
  capabilities: { resume: true, images: true, models: true, reasoningEffort: true, contextUsage: true },
  readHistorySnapshot: readKimiHistorySnapshot,
  listHistorySessions: listKimiHistorySessions,
})
