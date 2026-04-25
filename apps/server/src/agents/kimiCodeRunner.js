import { AGENT_ENGINES, getAgentEngineLabel } from '../../../../packages/shared/src/index.js'
import { listKnownKimiCodeSessions } from '../agentSessionDiscovery.js'

export const kimiCodeRunner = {
  engine: AGENT_ENGINES.KIMI_CODE,
  label: getAgentEngineLabel(AGENT_ENGINES.KIMI_CODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  listKnownSessions(options = {}) {
    return listKnownKimiCodeSessions(options)
  },
}
