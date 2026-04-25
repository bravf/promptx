export const EXPIRY_PRESETS = {
  none: {
    label: '不过期',
    hours: null,
  },
}

export const EXPIRY_OPTIONS = Object.entries(EXPIRY_PRESETS).map(([value, preset]) => ({
  value,
  label: preset.label,
}))

export const VISIBILITY_OPTIONS = [
  { value: 'private', label: '仅自己可见' },
]

export const AGENT_ENGINES = {
  CODEX: 'codex',
  CLAUDE_CODE: 'claude-code',
  OPENCODE: 'opencode',
  KIMI_CODE: 'kimi-code',
}

export const AGENT_ENGINE_OPTIONS = [
  {
    value: AGENT_ENGINES.CODEX,
    label: 'Codex',
    enabled: true,
  },
  {
    value: AGENT_ENGINES.CLAUDE_CODE,
    label: 'Claude Code',
    enabled: true,
  },
  {
    value: AGENT_ENGINES.OPENCODE,
    label: 'OpenCode',
    enabled: true,
  },
  {
    value: AGENT_ENGINES.KIMI_CODE,
    label: 'Kimi Code',
    enabled: true,
  },
]

export const BLOCK_TYPES = {
  TEXT: 'text',
  IMAGE: 'image',
  IMPORTED_TEXT: 'imported_text',
}

export {
  extractShellCommandIntent,
  isShellCommandPrompt,
  normalizeShellPromptPrefix,
} from './shellCommands.js'

export const BLOCK_TYPE_LABELS = {
  [BLOCK_TYPES.TEXT]: '文本',
  [BLOCK_TYPES.IMAGE]: '图片',
  [BLOCK_TYPES.IMPORTED_TEXT]: '导入文件',
}

export const TASK_AUTOMATION_TIMEZONE_OPTIONS = [
  { value: 'local', label: '跟随本机时区' },
]

export const TASK_AUTOMATION_CONCURRENCY_POLICIES = {
  SKIP: 'skip',
}

export const TASK_AUTOMATION_CONCURRENCY_POLICY_OPTIONS = [
  { value: TASK_AUTOMATION_CONCURRENCY_POLICIES.SKIP, label: '已有运行时跳过本次' },
]

export const TASK_NOTIFICATION_CHANNELS = {
  DINGTALK: 'dingtalk',
  FEISHU: 'feishu',
  WEBHOOK: 'webhook',
}

export const TASK_NOTIFICATION_CHANNEL_OPTIONS = [
  { value: TASK_NOTIFICATION_CHANNELS.DINGTALK, label: '钉钉 Webhook' },
  { value: TASK_NOTIFICATION_CHANNELS.FEISHU, label: '飞书 Webhook' },
  { value: TASK_NOTIFICATION_CHANNELS.WEBHOOK, label: '通用 Webhook' },
]

export const TASK_NOTIFICATION_TRIGGERS = {
  COMPLETED: 'completed',
  SUCCESS: 'success',
  ERROR: 'error',
}

export const TASK_NOTIFICATION_TRIGGER_OPTIONS = [
  { value: TASK_NOTIFICATION_TRIGGERS.COMPLETED, label: '本次运行结束后' },
  { value: TASK_NOTIFICATION_TRIGGERS.SUCCESS, label: '本次运行成功后' },
  { value: TASK_NOTIFICATION_TRIGGERS.ERROR, label: '本次运行失败后' },
]

export const TASK_NOTIFICATION_MESSAGE_MODES = {
  SUMMARY: 'summary',
}

export const TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS = [
  { value: TASK_NOTIFICATION_MESSAGE_MODES.SUMMARY, label: '摘要消息' },
]

export const TASK_NOTIFICATION_LOCALES = {
  ZH_CN: 'zh-CN',
  EN_US: 'en-US',
}

export const TASK_NOTIFICATION_LOCALE_OPTIONS = [
  { value: TASK_NOTIFICATION_LOCALES.ZH_CN, label: '简体中文' },
  { value: TASK_NOTIFICATION_LOCALES.EN_US, label: 'English' },
]

export function normalizeVisibility(value) {
  return 'private'
}

export function normalizeExpiry(value) {
  return 'none'
}

export function getVisibilityLabel(value) {
  return VISIBILITY_OPTIONS.find((item) => item.value === value)?.label || '仅自己可见'
}

export function normalizeAgentEngine(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return AGENT_ENGINE_OPTIONS.find((item) => item.value === normalized)?.value || AGENT_ENGINES.CODEX
}

export function normalizeTaskAutomationTimezone(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TASK_AUTOMATION_TIMEZONE_OPTIONS.find((item) => item.value === normalized)?.value || 'local'
}

export function normalizeTaskAutomationConcurrencyPolicy(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TASK_AUTOMATION_CONCURRENCY_POLICY_OPTIONS.find((item) => item.value === normalized)?.value
    || TASK_AUTOMATION_CONCURRENCY_POLICIES.SKIP
}

export function normalizeTaskNotificationChannel(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TASK_NOTIFICATION_CHANNEL_OPTIONS.find((item) => item.value === normalized)?.value
    || TASK_NOTIFICATION_CHANNELS.DINGTALK
}

export function normalizeTaskNotificationTrigger(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TASK_NOTIFICATION_TRIGGER_OPTIONS.find((item) => item.value === normalized)?.value
    || TASK_NOTIFICATION_TRIGGERS.COMPLETED
}

export function normalizeTaskNotificationMessageMode(value) {
  const normalized = String(value || '').trim().toLowerCase()
  return TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS.find((item) => item.value === normalized)?.value
    || TASK_NOTIFICATION_MESSAGE_MODES.SUMMARY
}

export function normalizeTaskNotificationLocale(value) {
  const normalized = String(value || '').trim()
  return TASK_NOTIFICATION_LOCALE_OPTIONS.find((item) => item.value === normalized)?.value
    || TASK_NOTIFICATION_LOCALES.ZH_CN
}

export function getAgentEngineLabel(value) {
  return AGENT_ENGINE_OPTIONS.find((item) => item.value === normalizeAgentEngine(value))?.label || 'Codex'
}

export function getBlockTypeLabel(value) {
  return BLOCK_TYPE_LABELS[value] || '内容'
}

export function resolveExpiresAt(expiry = 'none', now = new Date()) {
  const preset = EXPIRY_PRESETS[normalizeExpiry(expiry)]
  if (!preset || preset.hours === null) {
    return null
  }

  return new Date(now.getTime() + preset.hours * 60 * 60 * 1000).toISOString()
}

export function getExpiryValue(expiresAt, now = new Date()) {
  if (!expiresAt) {
    return 'none'
  }

  const diffMs = new Date(expiresAt).getTime() - now.getTime()
  if (diffMs <= 24 * 60 * 60 * 1000 + 60 * 1000) {
    return 'none'
  }
  return 'none'
}

export function clampText(value = '', max = 20000) {
  return String(value).slice(0, max)
}

export function normalizeComparablePath(value = '') {
  const raw = String(value || '').trim()
  if (!raw) {
    return ''
  }

  const isWindowsPath = /^[a-z]:[\\/]/i.test(raw) || raw.includes('\\')
  let normalized = raw.replace(/\\/g, '/')

  if (normalized.length > 1 && !/^[a-z]:\/$/i.test(normalized)) {
    normalized = normalized.replace(/\/+$/, '')
  }

  return isWindowsPath ? normalized.toLowerCase() : normalized
}

export function slugifyTitle(title = '') {
  const base = String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36)

  return base || 'task'
}

export function deriveTitleFromBlocks(blocks = [], max = 10) {
  const firstText = blocks.find(
    (block) =>
      (block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.IMPORTED_TEXT) &&
      block.content?.trim()
  )
  if (!firstText) {
    return ''
  }

  return firstText.content.replace(/\s+/g, ' ').trim().slice(0, max)
}

export function buildRawTaskText(task) {
  const parts = []
  if (task.title) {
    parts.push(`标题：${task.title}`, '')
  }

  for (const [index, block] of (task.blocks || []).entries()) {
    if (block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.IMPORTED_TEXT) {
      parts.push(block.content?.trim() || '', '')
      continue
    }

    if (block.type === BLOCK_TYPES.IMAGE) {
      parts.push(`图片 ${index + 1}：${block.content || ''}`)
      parts.push('')
    }
  }

  return parts.join('\n').trim() + '\n'
}

export function summarizeTask(task) {
  const textBlock = (task.blocks || []).find(
    (block) =>
      (block.type === BLOCK_TYPES.TEXT || block.type === BLOCK_TYPES.IMPORTED_TEXT) &&
      block.content?.trim()
  )
  return (textBlock?.content || '').replace(/\s+/g, ' ').trim().slice(0, 180)
}

export {
  CODEX_RUN_EVENTS_MODES,
  normalizeCodexRunEventsMode,
} from './codexRunEventsMode.js'

export {
  AGENT_RUN_ENVELOPE_EVENT_TYPES,
  normalizeAgentRunEnvelopeEventType,
  createAgentRunEnvelopeEvent,
  createSessionEnvelopeEvent,
  createSessionUpdatedEnvelopeEvent,
  createStatusEnvelopeEvent,
  createStdoutEnvelopeEvent,
  createStderrEnvelopeEvent,
  createAgentEventEnvelopeEvent,
  createCompletedEnvelopeEvent,
  createStoppedEnvelopeEvent,
  createErrorEnvelopeEvent,
} from './agentRunEnvelopeEvents.js'

export {
  AGENT_RUN_EVENT_TYPES,
  AGENT_RUN_ITEM_TYPES,
  createAgentRunEvent,
  createThreadStartedEvent,
  createTurnCompletedEvent,
  createTurnFailedEvent,
  createErrorEvent,
  createItemStartedEvent,
  createItemUpdatedEvent,
  createItemCompletedEvent,
} from './agentRunEvents.js'
