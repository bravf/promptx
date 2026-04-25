import { AGENT_ENGINES, getAgentEngineLabel } from '../../../../packages/shared/src/index.js'
import { listKnownClaudeCodeSessions } from '../agentSessionDiscovery.js'

export const claudeCodeRunner = {
  engine: AGENT_ENGINES.CLAUDE_CODE,
  label: getAgentEngineLabel(AGENT_ENGINES.CLAUDE_CODE),
  supportsWorkspaceHistory: false,
  listKnownWorkspaces() {
    return []
  },
  listKnownSessions(options = {}) {
    return listKnownClaudeCodeSessions(options)
  },
}
