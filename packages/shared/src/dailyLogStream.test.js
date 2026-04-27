import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

import {
  createDailyLogStream,
  formatLocalLogDate,
} from './dailyLogStream.js'

test('formatLocalLogDate formats local calendar date', () => {
  assert.equal(formatLocalLogDate(new Date(2026, 3, 7, 12, 30, 0)), '2026-04-07')
})

test('createDailyLogStream writes to a daily log file', async () => {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-daily-log-'))
  const stream = createDailyLogStream({
    logDir,
    logName: 'Server Test',
  })

  stream.write('hello daily log\n')
  await delay(30)

  const logPath = path.join(logDir, `server-test-${formatLocalLogDate()}.log`)
  assert.equal(fs.readFileSync(logPath, 'utf8'), 'hello daily log\n')
})
