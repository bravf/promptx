import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_RETENTION_DAYS = 14
const DAY_MS = 24 * 60 * 60 * 1000

function pad(value) {
  return String(value).padStart(2, '0')
}

export function formatLocalLogDate(date = new Date()) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-')
}

function normalizeLogName(value = '') {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    || 'app'
}

function parseRetentionDays(value = '') {
  const days = Number(value)
  if (!Number.isFinite(days) || days <= 0) {
    return DEFAULT_RETENTION_DAYS
  }
  return Math.floor(days)
}

function cleanupOldLogs(logDir = '', logName = '', retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoff = Date.now() - retentionDays * DAY_MS
  const pattern = new RegExp(`^${logName}-\\d{4}-\\d{2}-\\d{2}\\.log$`)

  let entries = []
  try {
    entries = fs.readdirSync(logDir, { withFileTypes: true })
  } catch {
    return
  }

  entries.forEach((entry) => {
    if (!entry.isFile() || !pattern.test(entry.name)) {
      return
    }

    const filePath = path.join(logDir, entry.name)
    try {
      const stats = fs.statSync(filePath)
      if (stats.mtimeMs < cutoff) {
        fs.rmSync(filePath, { force: true })
      }
    } catch {
      // Ignore cleanup failures; logging must not affect the service lifecycle.
    }
  })
}

export function createDailyLogStream(options = {}) {
  const logDir = String(options.logDir || process.env.PROMPTX_LOG_DIR || '').trim()
  const logName = normalizeLogName(options.logName || process.env.PROMPTX_LOG_NAME || '')
  const retentionDays = parseRetentionDays(options.retentionDays || process.env.PROMPTX_LOG_RETENTION_DAYS)

  if (!logDir) {
    return null
  }

  fs.mkdirSync(logDir, { recursive: true })
  cleanupOldLogs(logDir, logName, retentionDays)

  let currentDate = ''
  let stream = null

  function ensureStream() {
    const nextDate = formatLocalLogDate()
    if (stream && currentDate === nextDate) {
      return stream
    }

    stream?.end?.()
    currentDate = nextDate
    cleanupOldLogs(logDir, logName, retentionDays)
    stream = fs.createWriteStream(path.join(logDir, `${logName}-${currentDate}.log`), {
      flags: 'a',
    })
    stream.on('error', () => {
      // Logging failures must never crash the service.
    })
    return stream
  }

  return {
    write(chunk) {
      try {
        ensureStream().write(chunk)
      } catch {
        // Ignore logging failures; callers should keep running.
      }
    },
  }
}

export function createFastifyLoggerOptions(options = {}) {
  const stream = createDailyLogStream(options)
  return stream ? { stream } : true
}
