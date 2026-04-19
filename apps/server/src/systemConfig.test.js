import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('system config module reads env override and stored values', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-system-config-'))
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  const originalRunnerConcurrency = process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS
  process.env.PROMPTX_DATA_DIR = tempDir

  try {
    const module = await import(`./systemConfig.js?test=${Date.now()}`)
    const saved = module.writeStoredSystemConfig({
      runner: {
        maxConcurrentRuns: 3,
      },
    })

    assert.equal(saved.runner.maxConcurrentRuns, 3)
    assert.equal(fs.existsSync(module.getSystemConfigPath()), true)
    assert.equal(module.readStoredSystemConfig().runner.maxConcurrentRuns, 3)
    assert.equal(module.getSystemConfigManagedByEnv().runner.maxConcurrentRuns, false)
    assert.equal(module.getSystemConfigForClient().runner.maxConcurrentRuns, 3)

    process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS = '5'
    const moduleWithEnv = await import(`./systemConfig.js?test=${Date.now()}-env`)
    assert.equal(moduleWithEnv.getSystemConfigManagedByEnv().runner.maxConcurrentRuns, true)
    assert.equal(moduleWithEnv.getSystemConfigForClient().runner.maxConcurrentRuns, 5)
  } finally {
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }

    if (typeof originalRunnerConcurrency === 'string') {
      process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS = originalRunnerConcurrency
    } else {
      delete process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS
    }
  }
})

test('system config module redacts trusted proxy token for client payloads', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-system-config-'))
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  process.env.PROMPTX_DATA_DIR = tempDir

  try {
    const module = await import(`./systemConfig.js?test=${Date.now()}-redact`)
    module.writeStoredSystemConfig({
      runner: {
        maxConcurrentRuns: 3,
      },
      remoteCommandSecurity: {
        mode: 'trusted-proxy',
        trustedProxyToken: 'trusted-token',
      },
    })

    assert.equal(module.getSystemConfigForRuntime().remoteCommandSecurity.trustedProxyToken, 'trusted-token')
    assert.deepEqual(module.getSystemConfigForClient().remoteCommandSecurity, {
      mode: 'trusted-proxy',
      trustedProxyTokenConfigured: true,
    })
  } finally {
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})

test('system config module clears trusted proxy token when mode is not trusted-proxy', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-system-config-'))
  const originalDataDir = process.env.PROMPTX_DATA_DIR
  process.env.PROMPTX_DATA_DIR = tempDir

  try {
    const module = await import(`./systemConfig.js?test=${Date.now()}-clear-token`)
    module.writeStoredSystemConfig({
      remoteCommandSecurity: {
        mode: 'trusted-proxy',
        trustedProxyToken: 'trusted-token',
      },
    })

    const saved = module.writeStoredSystemConfig({
      remoteCommandSecurity: {
        mode: 'relay',
      },
    })

    assert.deepEqual(saved.remoteCommandSecurity, {
      mode: 'relay',
      trustedProxyToken: '',
    })
    assert.deepEqual(module.readStoredSystemConfig().remoteCommandSecurity, {
      mode: 'relay',
      trustedProxyToken: '',
    })
  } finally {
    if (typeof originalDataDir === 'string') {
      process.env.PROMPTX_DATA_DIR = originalDataDir
    } else {
      delete process.env.PROMPTX_DATA_DIR
    }
  }
})
