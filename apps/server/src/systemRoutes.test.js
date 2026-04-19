import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import Fastify from 'fastify'

import { buildInternalAuthHeaders } from './internalAuth.js'
import { registerSystemRoutes } from './systemRoutes.js'

function createTestServices(overrides = {}) {
  const runnerUpdates = []
  const relayUpdates = []

  const services = {
    getGitDiffWorkerDiagnostics: () => ({ healthy: true }),
    localBaseUrl: 'http://127.0.0.1:3001',
    maintenanceService: {
      getDiagnostics: () => ({ lastCleanupAt: null }),
      runCleanup: () => ({ removedFiles: 0 }),
    },
    promptxVersion: '1.2.3',
    relayClient: {
      getStatus: () => ({ enabled: false }),
      reconnect: () => true,
      updateConfig: (payload) => {
        relayUpdates.push(payload)
      },
    },
    runRecoveryService: {
      getDiagnostics: () => ({ recoveredRuns: 0 }),
    },
    runnerClient: {
      baseUrl: 'http://127.0.0.1:3002',
      getDiagnostics: async () => ({
        runner: {
          activeRuns: 1,
          queuedRuns: 0,
        },
      }),
      updateConfig: async (payload) => {
        runnerUpdates.push(payload)
      },
    },
    ...overrides,
  }

  return {
    ...services,
    relayUpdates,
    runnerUpdates,
  }
}

async function withTestApp(t, overrides, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-system-routes-'))
  const originalEnv = {
    PROMPTX_DATA_DIR: process.env.PROMPTX_DATA_DIR,
    PROMPTX_RUNNER_MAX_CONCURRENT_RUNS: process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS,
    PROMPTX_RELAY_URL: process.env.PROMPTX_RELAY_URL,
    PROMPTX_RELAY_DEVICE_ID: process.env.PROMPTX_RELAY_DEVICE_ID,
    PROMPTX_RELAY_DEVICE_TOKEN: process.env.PROMPTX_RELAY_DEVICE_TOKEN,
    PROMPTX_RELAY_ALLOW_REMOTE_SHELL: process.env.PROMPTX_RELAY_ALLOW_REMOTE_SHELL,
    PROMPTX_RELAY_ENABLED: process.env.PROMPTX_RELAY_ENABLED,
  }

  delete process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS
  delete process.env.PROMPTX_RELAY_URL
  delete process.env.PROMPTX_RELAY_DEVICE_ID
  delete process.env.PROMPTX_RELAY_DEVICE_TOKEN
  delete process.env.PROMPTX_RELAY_ALLOW_REMOTE_SHELL
  delete process.env.PROMPTX_RELAY_ENABLED
  process.env.PROMPTX_DATA_DIR = tempDir

  const services = createTestServices(overrides)
  const app = Fastify()
  registerSystemRoutes(app, services)
  await app.ready()

  try {
    await run({ app, services, tempDir })
  } finally {
    await app.close()
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (typeof value === 'string') {
        process.env[key] = value
      } else {
        delete process.env[key]
      }
    })
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
}

test('system routes persist config and hot update runner when env does not override', async (t) => {
  await withTestApp(t, {}, async ({ app, services }) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/system/config',
      payload: {
        runner: {
          maxConcurrentRuns: 4,
        },
      },
    })

    assert.equal(response.statusCode, 200)
    assert.deepEqual(response.json(), {
      config: {
        remoteCommandSecurity: {
          enabled: false,
          mode: 'relay',
          trustedProxyToken: '',
        },
        runner: {
          maxConcurrentRuns: 4,
        },
      },
      managedByEnv: {
        runner: {
          maxConcurrentRuns: false,
        },
      },
    })
    assert.deepEqual(services.runnerUpdates, [{ maxConcurrentRuns: 4 }])
  })
})

test('system routes keep saved config when runner hot update fails', async (t) => {
  await withTestApp(t, {
    runnerClient: {
      baseUrl: 'http://127.0.0.1:3002',
      getDiagnostics: async () => ({ runner: null }),
      updateConfig: async () => {
        const error = new Error('runner offline')
        error.statusCode = 503
        throw error
      },
    },
  }, async ({ app }) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/system/config',
      payload: {
        runner: {
          maxConcurrentRuns: 6,
        },
      },
    })

    assert.equal(response.statusCode, 503)
    const payload = response.json()
    assert.equal(payload.config.runner.maxConcurrentRuns, 6)
    assert.equal(payload.managedByEnv.runner.maxConcurrentRuns, false)
    assert.match(payload.message, /runner 热更新失败/)
  })
})

test('system routes respect env managed runner config and expose internal endpoint', async (t) => {
  await withTestApp(t, {}, async ({ app, services }) => {
    process.env.PROMPTX_RUNNER_MAX_CONCURRENT_RUNS = '7'

    const response = await app.inject({
      method: 'PUT',
      url: '/api/system/config',
      payload: {
        runner: {
          maxConcurrentRuns: 3,
        },
      },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().config.runner.maxConcurrentRuns, 7)
    assert.deepEqual(services.runnerUpdates, [])

    const unauthorized = await app.inject({
      method: 'GET',
      url: '/internal/system-config',
    })
    assert.equal(unauthorized.statusCode, 401)

    const internalResponse = await app.inject({
      method: 'GET',
      url: '/internal/system-config',
      headers: buildInternalAuthHeaders(),
    })
    assert.equal(internalResponse.statusCode, 200)
    assert.equal(internalResponse.json().config.runner.maxConcurrentRuns, 7)
  })
})

test('runtime diagnostics degrade gracefully when runner diagnostics fail', async (t) => {
  await withTestApp(t, {
    runnerClient: {
      baseUrl: 'http://127.0.0.1:3002',
      getDiagnostics: async () => {
        throw new Error('timeout')
      },
      updateConfig: async () => {},
    },
  }, async ({ app }) => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/diagnostics/runtime',
    })

    assert.equal(response.statusCode, 200)
    const payload = response.json()
    assert.equal(payload.runner.ok, false)
    assert.equal(payload.runner.baseUrl, 'http://127.0.0.1:3002')
    assert.match(payload.runner.message, /timeout/)
    assert.deepEqual(payload.gitDiffWorker, { healthy: true })
    assert.deepEqual(payload.recovery, { recoveredRuns: 0 })
    assert.deepEqual(payload.maintenance, { lastCleanupAt: null })
  })
})

test('relay reconnect endpoint triggers client reconnect when enabled', async (t) => {
  let reconnectCalled = 0
  await withTestApp(t, {
    relayClient: {
      getStatus: () => ({ enabled: true, connected: false }),
      reconnect: () => {
        reconnectCalled += 1
        return true
      },
      updateConfig: () => {},
    },
  }, async ({ app }) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/reconnect',
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().ok, true)
    assert.equal(reconnectCalled, 1)
  })
})

test('relay reconnect endpoint rejects when relay is disabled', async (t) => {
  await withTestApp(t, {
    relayClient: {
      getStatus: () => ({ enabled: false, connected: false }),
      reconnect: () => true,
      updateConfig: () => {},
    },
  }, async ({ app }) => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/relay/reconnect',
    })

    assert.equal(response.statusCode, 400)
    assert.match(response.json().message, /尚未启用/)
  })
})

test('relay config persists allowRemoteShell and hot updates relay client config', async (t) => {
  await withTestApp(t, {}, async ({ app, services }) => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/relay/config',
      payload: {
        enabled: true,
        relayUrl: 'https://relay.example.com',
        deviceId: 'my-device',
        deviceToken: 'secret-token',
        allowRemoteShell: true,
      },
    })

    assert.equal(response.statusCode, 200)
    assert.equal(response.json().config.allowRemoteShell, true)
    assert.equal(services.relayUpdates[0]?.allowRemoteShell, true)
  })
})
