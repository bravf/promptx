import { AGENT_ENGINES, getAgentEngineLabel } from '../../../../packages/shared/src/index.js'
import { listKnownOpenCodeSessions } from '../agentSessionDiscovery.js'

export const openCodeRunner = {
  engine: AGENT_ENGINES.OPENCODE,
  label: getAgentEngineLabel(AGENT_ENGINES.OPENCODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  listKnownSessions(options = {}) {
    return listKnownOpenCodeSessions(options)
  },
}
