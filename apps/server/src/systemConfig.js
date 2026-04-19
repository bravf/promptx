import fs from 'node:fs'
import path from 'node:path'

import { ensurePromptxStorageReady } from './appPaths.js'

const SYSTEM_CONFIG_FILE = 'system-config.json'
const DEFAULT_RUNNER_MAX_CONCURRENT_RUNS = 3
const MIN_RUNNER_MAX_CONCURRENT_RUNS = 1
const MAX_RUNNER_MAX_CONCURRENT_RUNS = 16
const REMOTE_COMMAND_SECURITY_MODES = new Set(['relay', 'trusted-proxy'])

function getSystemConfigPath() {
  const { dataDir } = ensurePromptxStorageReady()
  return path.join(dataDir, SYSTEM_CONFIG_FILE)
}

function clampInteger(value, fallback, minimum, maximum) {
  const normalized = Number(value)
  if (!Number.isFinite(normalized)) {
    return fallback
  }

  return Math.min(maximum, Math.max(minimum, Math.round(normalized)))
}

function normalizeRunnerConfig(input = {}, fallback = {}) {
  const fallbackMaxConcurrentRuns = clampInteger(
    fallback?.maxConcurrentRuns,
    DEFAULT_RUNNER_MAX_CONCURRENT_RUNS,
    MIN_RUNNER_MAX_CONCURRENT_RUNS,
    MAX_RUNNER_MAX_CONCURRENT_RUNS
  )

  return {
    maxConcurrentRuns: clampInteger(
      input?.maxConcurrentRuns,
      fallbackMaxConcurrentRuns,
      MIN_RUNNER_MAX_CONCURRENT_RUNS,
      MAX_RUNNER_MAX_CONCURRENT_RUNS
    ),
  }
}

function normalizeRemoteCommandSecurityConfig(input = {}, fallback = {}) {
  const fallbackMode = REMOTE_COMMAND_SECURITY_MODES.has(String(fallback?.mode || '').trim())
    ? String(fallback.mode).trim()
    : 'relay'
  const mode = REMOTE_COMMAND_SECURITY_MODES.has(String(input?.mode || '').trim())
    ? String(input.mode).trim()
    : fallbackMode

  return {
    enabled: typeof input?.enabled === 'boolean'
      ? input.enabled
      : Boolean(fallback?.enabled),
    mode,
    trustedProxyToken: String(input?.trustedProxyToken || fallback?.trustedProxyToken || '').trim(),
  }
}

function normalizeSystemConfig(input = {}, fallback = {}) {
  return {
    runner: normalizeRunnerConfig(input?.runner || {}, fallback?.runner || {}),
    remoteCommandSecurity: normalizeRemoteCommandSecurityConfig(
      input?.remoteCommandSecurity || {},
      fallback?.remoteCommandSecurity || {}
    ),
  }
}

function readStoredSystemConfig() {
  const filePath = getSystemConfigPath()

  try {
    const payload = JSON.parse(fs.readFileSync(filePath, 'utf8'))
    return normalizeSystemConfig(payload)
  } catch {
    return normalizeSystemConfig()
  }
}

function writeStoredSystemConfig(input = {}) {
  const filePath = getSystemConfigPath()
  const previous = readStoredSystemConfig()
  const normalized = normalizeSystemConfig(input, previous)
  fs.writeFileSync(filePath, `${JSON.stringify(normalized, null, 2)}\n`, 'utf8')
  return normalized
}

function getSystemConfigManagedByEnv() {
  return {
    runner: {
      maxConcurrentRuns: Boolean(String(process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS || '').trim()),
    },
  }
}

function getSystemConfigForClient() {
  const stored = readStoredSystemConfig()
  const managedByEnv = getSystemConfigManagedByEnv()

  return normalizeSystemConfig({
    runner: {
      maxConcurrentRuns: managedByEnv.runner.maxConcurrentRuns
        ? process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS
        : stored.runner.maxConcurrentRuns,
    },
  }, stored)
}

export {
  getSystemConfigForClient,
  getSystemConfigManagedByEnv,
  getSystemConfigPath,
  normalizeSystemConfig,
  readStoredSystemConfig,
  writeStoredSystemConfig,
}
