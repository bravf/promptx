import assert from 'node:assert/strict'

const baseUrl = String(process.env.PROMPTX_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '')
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function request(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
    ...options,
  })

  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    throw new Error(payload?.message || `${response.status} ${response.statusText}`)
  }

  return payload
}

async function openEventClient(name) {
  const response = await fetch(`${baseUrl}/api/events/stream`)
  if (!response.ok || !response.body) {
    throw new Error(`${name}: failed to open SSE stream`)
  }

  const events = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let aborted = false

  const streamTask = (async () => {
    while (true) {
      const { value, done } = await reader.read()
      if (done || aborted) {
        break
      }

      buffer += decoder.decode(value || new Uint8Array(), { stream: true })
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)

        const dataLine = raw
          .split(/\r?\n/)
          .find((line) => line.startsWith('data:'))

        if (dataLine) {
          const payload = JSON.parse(dataLine.slice(5).trim())
          events.push(payload)
        }

        boundary = buffer.indexOf('\n\n')
      }
    }
  })()

  return {
    events,
    async close() {
      aborted = true
      await reader.cancel().catch(() => {})
      await streamTask.catch(() => {})
    },
  }
}

async function waitFor(predicate, timeoutMs, message) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) {
      return result
    }
    await sleep(200)
  }

  throw new Error(message)
}

async function findTask(taskSlug) {
  const payload = await request('/api/tasks')
  return (payload.items || []).find((item) => item.slug === taskSlug) || null
}

async function main() {
  const clients = []
  let taskSlug = ''
  let sessionId = ''
  let runId = ''

  try {
    clients.push(await openEventClient('tab-a'))
    clients.push(await openEventClient('tab-b'))

    await waitFor(
      () => clients.every((client) => client.events.some((event) => event.type === 'ready')),
      5000,
      'SSE stream did not become ready in time'
    )

    const task = await request('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        title: 'realtime smoke task',
        expiry: 'none',
        visibility: 'private',
      }),
    })
    taskSlug = task.slug

    const session = await request('/api/codex/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title: 'realtime smoke session',
        cwd: 'D:/code/promptx',
      }),
    })
    sessionId = session.id

    await waitFor(
      () => clients.every((client) =>
        client.events.some((event) => event.type === 'tasks.changed' && event.taskSlug === taskSlug)
      ),
      5000,
      'task creation did not reach both SSE clients'
    )

    const beforeRun = await findTask(taskSlug)
    assert.equal(Boolean(beforeRun?.running), false)

    const runPayload = await request(`/api/tasks/${encodeURIComponent(taskSlug)}/codex-runs`, {
      method: 'POST',
      body: JSON.stringify({
        sessionId,
        prompt: 'Reply with OK only.',
      }),
    })
    runId = runPayload?.run?.id || ''

    await waitFor(
      () => clients.every((client) =>
        client.events.some((event) => event.type === 'runs.changed' && event.taskSlug === taskSlug)
        && client.events.some((event) => event.type === 'run.event' && event.taskSlug === taskSlug)
      ),
      10000,
      'run start did not reach both SSE clients'
    )

    const duringRun = await waitFor(
      async () => {
        const taskState = await findTask(taskSlug)
        return taskState?.running ? taskState : null
      },
      10000,
      'task did not enter running state in task list'
    )

    if (runId) {
      await request(`/api/codex/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }).catch(() => {})
    }

    const afterRun = await waitFor(
      async () => {
        const taskState = await findTask(taskSlug)
        return taskState && !taskState.running ? taskState : null
      },
      10000,
      'task did not leave running state in task list'
    )

    console.log(JSON.stringify({
      baseUrl,
      taskSlug,
      runId,
      beforeRun: Boolean(beforeRun?.running),
      duringRun: Boolean(duringRun?.running),
      afterRun: Boolean(afterRun?.running),
      streamAEvents: clients[0].events.filter((event) => event.taskSlug === taskSlug).map((event) => event.type),
      streamBEvents: clients[1].events.filter((event) => event.taskSlug === taskSlug).map((event) => event.type),
    }, null, 2))
  } finally {
    if (runId) {
      await request(`/api/codex/runs/${encodeURIComponent(runId)}/stop`, { method: 'POST' }).catch(() => {})
      await sleep(200)
    }
    if (sessionId) {
      await request(`/api/codex/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }).catch(() => {})
      await sleep(200)
    }
    if (taskSlug) {
      await request(`/api/tasks/${encodeURIComponent(taskSlug)}`, { method: 'DELETE' }).catch(() => {})
    }

    await Promise.all(clients.map((client) => client.close()))
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
