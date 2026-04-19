<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { Bell, Clock3, LoaderCircle, PencilLine, Save } from 'lucide-vue-next'
import {
  TASK_AUTOMATION_CONCURRENCY_POLICY_OPTIONS,
  TASK_AUTOMATION_TIMEZONE_OPTIONS,
  TASK_NOTIFICATION_CHANNEL_OPTIONS,
  TASK_NOTIFICATION_LOCALE_OPTIONS,
  TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS,
  TASK_NOTIFICATION_TRIGGER_OPTIONS,
} from '@promptx/shared'
import DialogShell from './DialogShell.vue'
import DialogSideNav from './DialogSideNav.vue'
import WorkbenchSelect from './WorkbenchSelect.vue'
import { formatDateTime as formatLocaleDateTime, useI18n } from '../composables/useI18n.js'
import { getTask, updateTask } from '../lib/api.js'

const DEFAULT_AUTOMATION_CRON = '0 9 * * 1-5'
const DEFAULT_AUTOMATION_MODE = 'weekdays'
const DEFAULT_AUTOMATION_TIME = '09:00'
const DEFAULT_AUTOMATION_WEEKDAY = '1'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  taskSlug: {
    type: String,
    default: '',
  },
  taskTitle: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['close', 'saved'])
const { locale, t } = useI18n()

const loading = ref(false)
const saving = ref(false)
const error = ref('')
const activeSection = ref('basic')
const form = reactive({
  title: '',
  automationEnabled: false,
  automationMode: DEFAULT_AUTOMATION_MODE,
  automationTime: DEFAULT_AUTOMATION_TIME,
  automationWeekday: DEFAULT_AUTOMATION_WEEKDAY,
  automationTimezone: 'local',
  automationConcurrencyPolicy: 'skip',
  automationLastTriggeredAt: '',
  automationNextTriggerAt: '',
  notificationEnabled: false,
  notificationChannelType: 'dingtalk',
  notificationWebhookUrl: '',
  notificationSecret: '',
  notificationTriggerOn: 'completed',
  notificationLocale: 'zh-CN',
  notificationMessageMode: 'summary',
  notificationLastStatus: '',
  notificationLastError: '',
  notificationLastSentAt: '',
})

const normalizedTaskTitle = computed(() => String(props.taskTitle || '').trim() || t('workbench.untitledTask'))
const taskSections = computed(() => ([
  {
    id: 'basic',
    label: t('taskDialog.sections.basic.label'),
    description: t('taskDialog.sections.basic.description'),
    icon: PencilLine,
  },
  {
    id: 'automation',
    label: t('taskDialog.sections.automation.label'),
    description: t('taskDialog.sections.automation.description'),
    icon: Clock3,
  },
  {
    id: 'notification',
    label: t('taskDialog.sections.notification.label'),
    description: t('taskDialog.sections.notification.description'),
    icon: Bell,
  },
]))
const automationModeOptions = computed(() => ([
  { value: 'daily', label: t('taskDialog.sections.automation.modeDaily') },
  { value: 'weekdays', label: t('taskDialog.sections.automation.modeWeekdays') },
  { value: 'weekly', label: t('taskDialog.sections.automation.modeWeekly') },
]))
const weekdayOptions = computed(() => ([
  { value: '1', label: t('taskDialog.sections.automation.weekday1') },
  { value: '2', label: t('taskDialog.sections.automation.weekday2') },
  { value: '3', label: t('taskDialog.sections.automation.weekday3') },
  { value: '4', label: t('taskDialog.sections.automation.weekday4') },
  { value: '5', label: t('taskDialog.sections.automation.weekday5') },
  { value: '6', label: t('taskDialog.sections.automation.weekday6') },
  { value: '0', label: t('taskDialog.sections.automation.weekday0') },
]))
const timezoneOptions = computed(() => TASK_AUTOMATION_TIMEZONE_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'local'
    ? t('taskDialog.sections.automation.timezoneLocal')
    : option.label,
})))
const concurrencyPolicyOptions = computed(() => TASK_AUTOMATION_CONCURRENCY_POLICY_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'skip'
    ? t('taskDialog.sections.automation.concurrencySkip')
    : option.label,
})))
const notificationChannelOptions = computed(() => TASK_NOTIFICATION_CHANNEL_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'dingtalk'
    ? t('taskDialog.sections.notification.channelDingtalk')
    : option.value === 'feishu'
      ? t('taskDialog.sections.notification.channelFeishu')
      : option.value === 'webhook'
        ? t('taskDialog.sections.notification.channelWebhook')
        : option.label,
})))
const notificationTriggerOptions = computed(() => TASK_NOTIFICATION_TRIGGER_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'completed'
    ? t('taskDialog.sections.notification.triggerCompleted')
    : option.value === 'success'
      ? t('taskDialog.sections.notification.triggerSuccess')
      : option.value === 'error'
        ? t('taskDialog.sections.notification.triggerError')
        : option.label,
})))
const notificationMessageModeOptions = computed(() => TASK_NOTIFICATION_MESSAGE_MODE_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'summary'
    ? t('taskDialog.sections.notification.messageSummary')
    : option.label,
})))
const notificationLocaleOptions = computed(() => TASK_NOTIFICATION_LOCALE_OPTIONS.map((option) => ({
  ...option,
  label: option.value === 'zh-CN'
    ? t('taskDialog.sections.notification.localeZhCn')
    : option.value === 'en-US'
      ? t('taskDialog.sections.notification.localeEnUs')
      : option.label,
})))
const notificationStatusText = computed(() => {
  if (!form.notificationEnabled) {
    return t('taskDialog.sections.notification.statusDisabled')
  }
  if (form.notificationLastStatus === 'success') {
    return t('taskDialog.sections.notification.statusSuccess')
  }
  if (form.notificationLastStatus === 'error') {
    return t('taskDialog.sections.notification.statusError')
  }
  return t('taskDialog.sections.notification.statusPending')
})

function resetForm() {
  form.title = ''
  form.automationEnabled = false
  form.automationMode = DEFAULT_AUTOMATION_MODE
  form.automationTime = DEFAULT_AUTOMATION_TIME
  form.automationWeekday = DEFAULT_AUTOMATION_WEEKDAY
  form.automationTimezone = 'local'
  form.automationConcurrencyPolicy = 'skip'
  form.automationLastTriggeredAt = ''
  form.automationNextTriggerAt = ''
  form.notificationEnabled = false
  form.notificationChannelType = 'dingtalk'
  form.notificationWebhookUrl = ''
  form.notificationSecret = ''
  form.notificationTriggerOn = 'completed'
  form.notificationLocale = String(locale.value || 'zh-CN')
  form.notificationMessageMode = 'summary'
  form.notificationLastStatus = ''
  form.notificationLastError = ''
  form.notificationLastSentAt = ''
}

function padTimePart(value = 0) {
  return String(value).padStart(2, '0')
}

function parseAutomationCron(cron = '') {
  const normalized = String(cron || '').trim().replace(/\s+/g, ' ')

  let match = normalized.match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/)
  if (match) {
    return {
      mode: 'weekdays',
      time: `${padTimePart(match[2])}:${padTimePart(match[1])}`,
      weekday: DEFAULT_AUTOMATION_WEEKDAY,
    }
  }

  match = normalized.match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/)
  if (match) {
    return {
      mode: 'daily',
      time: `${padTimePart(match[2])}:${padTimePart(match[1])}`,
      weekday: DEFAULT_AUTOMATION_WEEKDAY,
    }
  }

  match = normalized.match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/)
  if (match) {
    return {
      mode: 'weekly',
      time: `${padTimePart(match[2])}:${padTimePart(match[1])}`,
      weekday: String(match[3]),
    }
  }

  return {
    mode: DEFAULT_AUTOMATION_MODE,
    time: DEFAULT_AUTOMATION_TIME,
    weekday: DEFAULT_AUTOMATION_WEEKDAY,
  }
}

function normalizeAutomationTime(value = '') {
  const normalized = String(value || '').trim()
  const match = normalized.match(/^(\d{1,2}):(\d{2})$/)
  if (!match) {
    return DEFAULT_AUTOMATION_TIME
  }

  const hour = Number(match[1])
  const minute = Number(match[2])
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return DEFAULT_AUTOMATION_TIME
  }

  return `${padTimePart(hour)}:${padTimePart(minute)}`
}

function buildAutomationCron() {
  const time = normalizeAutomationTime(form.automationTime)
  const [hourText, minuteText] = time.split(':')
  const hour = Number(hourText)
  const minute = Number(minuteText)

  if (form.automationMode === 'daily') {
    return `${minute} ${hour} * * *`
  }

  if (form.automationMode === 'weekly') {
    const weekday = weekdayOptions.value.find((item) => item.value === String(form.automationWeekday || ''))?.value || DEFAULT_AUTOMATION_WEEKDAY
    return `${minute} ${hour} * * ${weekday}`
  }

  return `${minute} ${hour} * * 1-5`
}

function applyTaskToForm(task = {}) {
  form.title = String(task.title || '')
  form.automationEnabled = Boolean(task.automation?.enabled)
  const parsedAutomation = parseAutomationCron(task.automation?.cron || DEFAULT_AUTOMATION_CRON)
  form.automationMode = parsedAutomation.mode
  form.automationTime = parsedAutomation.time
  form.automationWeekday = parsedAutomation.weekday
  form.automationTimezone = String(task.automation?.timezone || 'local')
  form.automationConcurrencyPolicy = String(task.automation?.concurrencyPolicy || 'skip')
  form.automationLastTriggeredAt = String(task.automation?.lastTriggeredAt || '')
  form.automationNextTriggerAt = String(task.automation?.nextTriggerAt || '')
  form.notificationEnabled = Boolean(task.notification?.enabled)
  form.notificationChannelType = String(task.notification?.channelType || 'dingtalk')
  form.notificationWebhookUrl = String(task.notification?.webhookUrl || '')
  form.notificationSecret = String(task.notification?.secret || '')
  form.notificationTriggerOn = String(task.notification?.triggerOn || 'completed')
  form.notificationLocale = String(task.notification?.locale || locale.value || 'zh-CN')
  form.notificationMessageMode = String(task.notification?.messageMode || 'summary')
  form.notificationLastStatus = String(task.notification?.lastStatus || '')
  form.notificationLastError = String(task.notification?.lastError || '')
  form.notificationLastSentAt = String(task.notification?.lastSentAt || '')
}

async function loadTaskSettings() {
  const taskSlug = String(props.taskSlug || '').trim()
  if (!taskSlug) {
    resetForm()
    return
  }

  loading.value = true
  error.value = ''

  try {
    const task = await getTask(taskSlug)
    applyTaskToForm(task)
  } catch (nextError) {
    error.value = nextError?.message || t('taskDialog.loadFailed')
  } finally {
    loading.value = false
  }
}

function buildUpdatePayload() {
  return {
    title: form.title,
    automation: {
      enabled: form.automationEnabled,
      cron: buildAutomationCron(),
      timezone: form.automationTimezone,
      concurrencyPolicy: form.automationConcurrencyPolicy,
    },
    notification: {
      enabled: form.notificationEnabled,
      channelType: form.notificationChannelType,
      webhookUrl: form.notificationWebhookUrl,
      secret: form.notificationSecret,
      triggerOn: form.notificationTriggerOn,
      locale: form.notificationLocale,
      messageMode: form.notificationMessageMode,
    },
  }
}

async function handleSave() {
  const taskSlug = String(props.taskSlug || '').trim()
  if (!taskSlug || loading.value || saving.value) {
    return
  }

  saving.value = true
  error.value = ''

  try {
    const task = await updateTask(taskSlug, buildUpdatePayload())
    applyTaskToForm(task)
    emit('saved', task)
    emit('close')
  } catch (nextError) {
    error.value = nextError?.message || t('taskDialog.saveFailed')
  } finally {
    saving.value = false
  }
}

function formatTime(value = '') {
  if (!value) {
    return t('common.notAvailable')
  }

  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return t('common.notAvailable')
  }

  return formatLocaleDateTime(date.toISOString(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = 'basic'
      loadTaskSettings()
      return
    }
  },
  { immediate: true }
)

watch(
  () => props.taskSlug,
  () => {
    if (props.open) {
      loadTaskSettings()
    }
  }
)

</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="3"
    panel-class="settings-dialog-panel h-[calc(100dvh-1rem)] max-w-5xl sm:h-[96vh] sm:max-h-[96vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex flex-1 flex-col overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div>
        <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
          <PencilLine class="h-4 w-4" />
          <span>{{ t('taskDialog.title') }}</span>
        </div>
        <p class="theme-muted-text mt-1 text-xs">{{ t('taskDialog.currentTask', { title: normalizedTaskTitle }) }}</p>
      </div>
    </template>

    <div class="min-h-0 flex flex-1 flex-col overflow-hidden sm:flex-row">
      <DialogSideNav
        v-model="activeSection"
        :sections="taskSections"
      />

      <div class="settings-dialog-content min-h-0 flex-1 overflow-y-auto px-5 py-5">
        <div v-if="loading" class="theme-muted-text flex items-center gap-2 py-4 text-sm">
          <LoaderCircle class="h-4 w-4 animate-spin" />
          <span>{{ t('taskDialog.loading') }}</span>
        </div>

        <div v-else class="space-y-4">
          <section v-if="activeSection === 'basic'" class="space-y-4">
            <div>
              <div class="theme-heading text-base font-medium">{{ t('taskDialog.sections.basic.title') }}</div>
              <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('taskDialog.sections.basic.intro') }}</p>
            </div>

            <section class="settings-section-card px-4 py-4">
              <label class="block space-y-1.5">
                <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.basic.taskTitle') }}</span>
                <input
                  v-model="form.title"
                  type="text"
                  maxlength="140"
                  class="tool-input"
                  :placeholder="t('taskDialog.sections.basic.taskTitlePlaceholder')"
                />
              </label>
            </section>
          </section>

          <section v-else-if="activeSection === 'automation'" class="space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Clock3 class="h-4 w-4" />
                  <span>{{ t('taskDialog.sections.automation.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('taskDialog.sections.automation.intro') }}</p>
              </div>

              <label class="inline-flex items-center gap-2 text-sm text-[var(--theme-textPrimary)]">
                <input v-model="form.automationEnabled" type="checkbox" class="h-4 w-4" />
                <span>{{ t('taskDialog.enabled') }}</span>
              </label>
            </div>

            <section class="settings-section-card px-4 py-4">
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="space-y-1.5 sm:col-span-2">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.automation.mode') }}</span>
                  <WorkbenchSelect
                    v-model="form.automationMode"
                    :options="automationModeOptions"
                    :disabled="!form.automationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.automation.time') }}</span>
                  <input
                    v-model="form.automationTime"
                    type="time"
                    class="tool-input"
                    :disabled="!form.automationEnabled"
                  />
                </label>

                <label
                  v-if="form.automationMode === 'weekly'"
                  class="space-y-1.5"
                >
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.automation.weekday') }}</span>
                  <WorkbenchSelect
                    v-model="form.automationWeekday"
                    :options="weekdayOptions"
                    :disabled="!form.automationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.automation.timezone') }}</span>
                  <WorkbenchSelect
                    v-model="form.automationTimezone"
                    :options="timezoneOptions"
                    :disabled="!form.automationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5" :class="form.automationMode === 'weekly' ? '' : 'sm:col-span-2'">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.automation.concurrencyPolicy') }}</span>
                  <WorkbenchSelect
                    v-model="form.automationConcurrencyPolicy"
                    :options="concurrencyPolicyOptions"
                    :disabled="!form.automationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>
              </div>

              <div class="theme-muted-text mt-3 space-y-1 text-xs leading-6">
                <p>{{ t('taskDialog.sections.automation.lastTriggered', { value: formatTime(form.automationLastTriggeredAt) }) }}</p>
                <p>{{ t('taskDialog.sections.automation.nextTriggered', { value: formatTime(form.automationNextTriggerAt) }) }}</p>
              </div>
            </section>
          </section>

          <section v-else class="space-y-4">
            <div class="flex items-start justify-between gap-3">
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Bell class="h-4 w-4" />
                  <span>{{ t('taskDialog.sections.notification.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('taskDialog.sections.notification.intro') }}</p>
              </div>

              <label class="inline-flex items-center gap-2 text-sm text-[var(--theme-textPrimary)]">
                <input v-model="form.notificationEnabled" type="checkbox" class="h-4 w-4" />
                <span>{{ t('taskDialog.enabled') }}</span>
              </label>
            </div>

            <section class="settings-section-card px-4 py-4">
              <div class="grid gap-4 sm:grid-cols-2">
                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.channelType') }}</span>
                  <WorkbenchSelect
                    v-model="form.notificationChannelType"
                    :options="notificationChannelOptions"
                    :disabled="!form.notificationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.triggerOn') }}</span>
                  <WorkbenchSelect
                    v-model="form.notificationTriggerOn"
                    :options="notificationTriggerOptions"
                    :disabled="!form.notificationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5 sm:col-span-2">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.webhookUrl') }}</span>
                  <input
                    v-model="form.notificationWebhookUrl"
                    type="text"
                    class="tool-input"
                    :placeholder="t('taskDialog.sections.notification.webhookUrlPlaceholder')"
                    :disabled="!form.notificationEnabled"
                  />
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.secret') }}</span>
                  <input
                    v-model="form.notificationSecret"
                    type="text"
                    class="tool-input"
                    :placeholder="t('taskDialog.sections.notification.secretPlaceholder')"
                    :disabled="!form.notificationEnabled"
                  />
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.locale') }}</span>
                  <WorkbenchSelect
                    v-model="form.notificationLocale"
                    :options="notificationLocaleOptions"
                    :disabled="!form.notificationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('taskDialog.sections.notification.messageMode') }}</span>
                  <WorkbenchSelect
                    v-model="form.notificationMessageMode"
                    :options="notificationMessageModeOptions"
                    :disabled="!form.notificationEnabled"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                  </WorkbenchSelect>
                </label>
              </div>

              <div class="theme-muted-text mt-3 space-y-1 text-xs leading-6">
                <p>{{ t('taskDialog.sections.notification.status', { value: notificationStatusText }) }}</p>
                <p>{{ t('taskDialog.sections.notification.lastSent', { value: formatTime(form.notificationLastSentAt) }) }}</p>
                <p v-if="form.notificationLastError" class="theme-danger-text">
                  {{ t('taskDialog.sections.notification.lastError', { value: form.notificationLastError }) }}
                </p>
              </div>
            </section>
          </section>

          <p v-if="error" class="theme-danger-text text-sm">{{ error }}</p>
        </div>
      </div>
    </div>

    <div class="theme-divider flex flex-col gap-3 border-t px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <p class="theme-muted-text theme-note-text">
        {{ t('taskDialog.footerHint') }}
      </p>

      <div class="flex items-center justify-end gap-2">
        <button
          type="button"
          class="tool-button px-3 py-2 text-sm"
          :disabled="saving"
          @click="emit('close')"
        >
          {{ t('common.cancel') }}
        </button>
        <button
          type="button"
          class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-sm"
          :disabled="saving || loading"
          @click="handleSave"
        >
          <LoaderCircle v-if="saving" class="h-4 w-4 animate-spin" />
          <Save v-else class="h-4 w-4" />
          <span>{{ saving ? t('common.saving') : t('taskDialog.saveTaskConfig') }}</span>
        </button>
      </div>
    </div>
  </DialogShell>
</template>
