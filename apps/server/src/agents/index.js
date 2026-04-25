import {
  AGENT_ENGINE_OPTIONS,
  AGENT_ENGINES,
  getAgentEngineLabel,
  normalizeAgentEngine,
} from '../../../../packages/shared/src/index.js'
import { codexRunner } from './codexRunner.js'
import { claudeCodeRunner } from './claudeCodeRunner.js'
import { openCodeRunner } from './openCodeRunner.js'
import { kimiCodeRunner } from './kimiCodeRunner.js'

const SHELL_ENGINE = 'shell'
const shellRunner = {
  engine: SHELL_ENGINE,
  label: 'Shell',
}

const runnerRegistry = new Map([
  [codexRunner.engine, codexRunner],
  [claudeCodeRunner.engine, claudeCodeRunner],
  [openCodeRunner.engine, openCodeRunner],
  [kimiCodeRunner.engine, kimiCodeRunner],
  [shellRunner.engine, shellRunner],
])

function normalizeRunnerEngine(engine = AGENT_ENGINES.CODEX) {
  const normalized = String(engine || '').trim().toLowerCase()
  if (normalized === SHELL_ENGINE) {
    return SHELL_ENGINE
  }
  return normalizeAgentEngine(normalized)
}

export function getAgentRunner(engine = AGENT_ENGINES.CODEX) {
  return runnerRegistry.get(normalizeRunnerEngine(engine)) || null
}

export function listAvailableAgentEngines() {
  return AGENT_ENGINE_OPTIONS.map((item) => ({
    ...item,
    available: runnerRegistry.has(item.value),
  }))
}

export function listEnabledAgentEngines() {
  return listAvailableAgentEngines().filter((item) => item.enabled)
}

export function assertAgentRunner(engine = AGENT_ENGINES.CODEX) {
  const normalized = normalizeRunnerEngine(engine)
  const runner = getAgentRunner(normalized)
  if (!runner) {
    throw new Error(`当前还不支持执行引擎：${normalized === SHELL_ENGINE ? shellRunner.label : getAgentEngineLabel(normalized)}`)
  }
  return runner
}

export function listKnownWorkspacesByEngine(engine = AGENT_ENGINES.CODEX, limit) {
  const runner = getAgentRunner(engine)
  if (!runner?.listKnownWorkspaces) {
    return []
  }
  return runner.listKnownWorkspaces(limit)
}

export function listKnownSessionsByEngine(engine = AGENT_ENGINES.CODEX, options = {}) {
  const runner = getAgentRunner(engine)
  if (!runner?.listKnownSessions) {
    return []
  }
  return runner.listKnownSessions(options)
}
