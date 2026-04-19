<script setup>
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue'
import { Check, Cpu, Eye, EyeOff, Info, Keyboard, LoaderCircle, Palette, Settings2, Wifi } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import DialogSideNav from './DialogSideNav.vue'
import ThemeToggle from './ThemeToggle.vue'
import WorkbenchSelect from './WorkbenchSelect.vue'
import { formatDateTime as formatLocaleDateTime, useI18n } from '../composables/useI18n.js'
import {
  WORKBENCH_PREFERENCE_KEYS,
  WORKBENCH_SEND_BEHAVIOR_OPTIONS,
  useWorkbenchPreferences,
} from '../lib/workbenchPreferences.js'
import {
  getMeta,
  getRelayConfig,
  reconnectRelay,
  getRuntimeDiagnostics,
  getSystemConfig,
  updateRelayConfig,
  updateSystemConfig,
} from '../lib/api.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close'])
const { locale, localeOptions, setLocale, t } = useI18n()
const { getPreference, setPreference } = useWorkbenchPreferences()
const version = ref('')
const versionLoading = ref(false)
const versionError = ref('')
const relayLoading = ref(false)
const relaySaving = ref(false)
const relayReconnecting = ref(false)
const relayError = ref('')
const relaySuccess = ref('')
const systemLoading = ref(false)
const systemSaving = ref(false)
const systemError = ref('')
const systemSuccess = ref('')
const generalSecuritySaving = ref(false)
const generalSecuritySaved = ref(false)
const systemDiagnosticsLoading = ref(false)
const systemDiagnosticsError = ref('')
const systemDiagnostics = ref(null)
const relayStatus = ref(null)
const relayManagedByEnv = ref(false)
const systemManagedByEnv = reactive({
  runnerMaxConcurrentRuns: false,
})
const relayToggleSaving = ref(false)
const relayTokenVisible = ref(false)
const relayCopied = ref(false)
const systemCopied = ref(false)
const relayForm = reactive({
  enabled: false,
  relayUrl: '',
  deviceId: '',
  deviceToken: '',
})
const systemForm = reactive({
  runnerMaxConcurrentRuns: 3,
})
const generalForm = reactive({
  sendBehavior: '',
  remoteCommandSecurityEnabled: false,
  remoteCommandSecurityMode: 'relay',
  trustedProxyToken: '',
})
const activeSection = ref('general')
let relayCopyTimer = null
let systemCopyTimer = null
let systemDiagnosticsTimer = null
let generalSecuritySavedTimer = null

const settingsSections = computed(() => ([
  {
    id: 'general',
    label: t('settingsDialog.general.sectionLabel'),
    description: t('settingsDialog.general.sectionDescription'),
    icon: Keyboard,
  },
  {
    id: 'theme',
    label: t('theme.title'),
    description: t('theme.sectionDescription'),
    icon: Palette,
  },
  {
    id: 'relay',
    label: t('settingsDialog.relay.sectionLabel'),
    description: t('settingsDialog.relay.sectionDescription'),
    icon: Wifi,
  },
  {
    id: 'system',
    label: t('settingsDialog.system.sectionLabel'),
    description: t('settingsDialog.system.sectionDescription'),
    icon: Cpu,
  },
  {
    id: 'shortcuts',
    label: t('settingsDialog.shortcuts.sectionLabel'),
    description: t('settingsDialog.shortcuts.sectionDescription'),
    icon: Keyboard,
  },
  {
    id: 'about',
    label: t('settingsDialog.about.sectionLabel'),
    description: t('settingsDialog.about.sectionDescription'),
    icon: Info,
  },
]))

const sendBehaviorOptions = computed(() => WORKBENCH_SEND_BEHAVIOR_OPTIONS.map((item) => ({
  value: item.value,
  label: t(item.labelKey),
  description: t(item.descriptionKey),
})))

function resolvePayloadMessage(payload = null, fallbackKey = '') {
  const messageKey = String(payload?.messageKey || '').trim()
  if (messageKey) {
    const translated = t(messageKey)
    if (translated && translated !== messageKey) {
      return translated
    }
  }

  return String(payload?.message || '').trim() || (fallbackKey ? t(fallbackKey) : '')
}

function resolveRelayReason(code = '', fallback = '') {
  const normalizedCode = String(code || '').trim()
  if (normalizedCode) {
    const key = `settingsDialog.relay.reason.${normalizedCode}`
    const translated = t(key)
    if (translated !== key) {
      return translated
    }
  }

  return String(fallback || '').trim() || t('common.notAvailable')
}

function resolveRelayEventLabel(event = null) {
  const type = String(event?.type || '').trim() || 'unknown'
  const key = `settingsDialog.relay.event.${type}`
  const translated = t(key)
  return translated !== key ? translated : type
}

function resolveRelayErrorText(status = null) {
  const errorKey = String(status?.lastErrorKey || '').trim()
  const params = status?.lastErrorParams && typeof status.lastErrorParams === 'object'
    ? status.lastErrorParams
    : {}

  if (errorKey === 'connect_failed') {
    return t('settingsDialog.relay.error.connect_failed')
  }
  if (errorKey === 'disconnected') {
    return t('settingsDialog.relay.error.disconnected', {
      reason: resolveRelayReason(params.reasonCode, status?.lastCloseReason),
    })
  }
  if (errorKey === 'rejected') {
    return t('settingsDialog.relay.error.rejected', {
      reason: resolveRelayReason(params.reasonCode, status?.lastCloseReason),
    })
  }
  if (errorKey === 'closed_with_code') {
    return t('settingsDialog.relay.error.closedWithCode', {
      code: params.code || status?.lastCloseCode || 0,
    })
  }

  return String(status?.lastError || '').trim()
}

const relayStatusLabel = computed(() => {
  if (relayReconnecting.value) {
    return t('settingsDialog.relay.status.reconnecting')
  }
  if (relaySaving.value || relayToggleSaving.value) {
    return t('settingsDialog.relay.status.saving')
  }
  if (relayLoading.value) {
    return t('settingsDialog.relay.status.loading')
  }
  if (relayStatus.value?.reconnectPaused) {
    return t('settingsDialog.relay.status.paused')
  }
  if (relayStatus.value?.connected) {
    return t('settingsDialog.relay.status.connected')
  }
  if ((relayStatus.value?.enabled ?? relayForm.enabled) && Number(relayStatus.value?.nextReconnectDelayMs || 0) > 0) {
    return t('settingsDialog.relay.status.waitingReconnect')
  }
  if (relayForm.enabled) {
    return t('settingsDialog.relay.status.disconnected')
  }
  return t('settingsDialog.relay.status.disabled')
})

const relayStatusClass = computed(() => {
  if (relayStatus.value?.reconnectPaused) {
    return 'theme-status-danger'
  }
  if (relayStatus.value?.connected) {
    return 'theme-status-success'
  }
  if (relayForm.enabled) {
    return 'theme-status-warning'
  }
  return 'theme-status-neutral'
})

const shortcutItems = computed(() => ([
  {
    id: 'open-settings',
    label: t('settingsDialog.shortcuts.openSettingsTitle'),
    description: t('settingsDialog.shortcuts.openSettingsDescription'),
    mac: '⌘ ⇧ ,',
    windows: 'Ctrl + Shift + ,',
  },
  {
    id: 'open-project-manager',
    label: t('settingsDialog.shortcuts.openProjectManagerTitle'),
    description: t('settingsDialog.shortcuts.openProjectManagerDescription'),
    mac: '⌘ ⇧ K',
    windows: 'Ctrl + Shift + K',
  },
  {
    id: 'open-source-browser',
    label: t('settingsDialog.shortcuts.openSourceBrowserTitle'),
    description: t('settingsDialog.shortcuts.openSourceBrowserDescription'),
    mac: '⌘ ⇧ O',
    windows: 'Ctrl + Shift + O',
  },
  {
    id: 'open-diff-review',
    label: t('settingsDialog.shortcuts.openDiffReviewTitle'),
    description: t('settingsDialog.shortcuts.openDiffReviewDescription'),
    mac: '⌘ ⇧ D',
    windows: 'Ctrl + Shift + D',
  },
  {
    id: 'close-top-dialog',
    label: t('settingsDialog.shortcuts.closeTopDialogTitle'),
    description: t('settingsDialog.shortcuts.closeTopDialogDescription'),
    mac: 'Esc',
    windows: 'Esc',
  },
]))

const showRelayDefaultHint = computed(() => (
  !relayManagedByEnv.value
  && !relayError.value
  && !relaySuccess.value
  && !relayStatus.value?.lastError
  && !relayStatus.value?.lastCloseReason
  && !relayStatus.value?.lastConnectedAt
))

const relayDiagnosticsText = computed(() => {
  const maskedToken = relayForm.deviceToken
    ? `${'*'.repeat(Math.max(0, relayForm.deviceToken.length - 4))}${relayForm.deviceToken.slice(-4)}`
    : ''

  return JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'local-settings',
    config: {
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceTokenMasked: maskedToken,
      managedByEnv: relayManagedByEnv.value,
    },
    status: relayStatus.value || null,
  }, null, 2)
})

const runnerDiagnostics = computed(() => systemDiagnostics.value?.runner?.runner || null)
const runnerDiagnosticsOk = computed(() => Boolean(systemDiagnostics.value?.runner?.ok && runnerDiagnostics.value))
const runnerMetrics = computed(() => runnerDiagnostics.value?.metrics || null)
const recoveryDiagnostics = computed(() => systemDiagnostics.value?.recovery || null)
const maintenanceDiagnostics = computed(() => systemDiagnostics.value?.maintenance || null)
const gitDiffWorkerDiagnostics = computed(() => systemDiagnostics.value?.gitDiffWorker || null)

const systemDiagnosticsText = computed(() => JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: 'local-settings',
  config: {
    runner: {
      maxConcurrentRuns: systemForm.runnerMaxConcurrentRuns,
      managedByEnv: systemManagedByEnv.runnerMaxConcurrentRuns,
    },
  },
  diagnostics: systemDiagnostics.value || null,
}, null, 2))

function formatDateTime(value) {
  const normalized = String(value || '').trim()
  if (!normalized) {
    return t('common.notAvailable')
  }

  const parsed = new Date(normalized)
  if (Number.isNaN(parsed.getTime())) {
    return normalized
  }

  return formatLocaleDateTime(parsed.toISOString(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

const runnerStopReasonRows = computed(() => ([
  {
    key: 'queued_cancelled',
    label: t('settingsDialog.system.stopReasons.queued_cancelled'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.queued_cancelled) || 0),
  },
  {
    key: 'user_requested',
    label: t('settingsDialog.system.stopReasons.user_requested'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested) || 0),
  },
  {
    key: 'user_requested_after_error',
    label: t('settingsDialog.system.stopReasons.user_requested_after_error'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.user_requested_after_error) || 0),
  },
  {
    key: 'stop_timeout',
    label: t('settingsDialog.system.stopReasons.stop_timeout'),
    value: Math.max(0, Number(runnerMetrics.value?.stopReasons?.stop_timeout) || 0),
  },
]))

const runnerStopTimeoutPhaseRows = computed(() => ([
  {
    key: 'runner_timeout_without_stop_request',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_timeout_without_stop_request'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_without_stop_request) || 0),
  },
  {
    key: 'runner_timeout_before_cancel',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_timeout_before_cancel'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_timeout_before_cancel) || 0),
  },
  {
    key: 'cli_not_exiting',
    label: t('settingsDialog.system.stopTimeoutPhases.cli_not_exiting'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.cli_not_exiting) || 0),
  },
  {
    key: 'os_kill_slow',
    label: t('settingsDialog.system.stopTimeoutPhases.os_kill_slow'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.os_kill_slow) || 0),
  },
  {
    key: 'runner_finalize_after_exit',
    label: t('settingsDialog.system.stopTimeoutPhases.runner_finalize_after_exit'),
    value: Math.max(0, Number(runnerMetrics.value?.stopTimeoutPhases?.runner_finalize_after_exit) || 0),
  },
]))

const localeFieldOptions = computed(() => localeOptions.value.map((item) => ({
  value: item.value,
  label: item.value === 'zh-CN' ? t('locale.zhHans') : t('locale.enUs'),
  englishLabel: item.englishLabel,
})))

async function loadMeta() {
  versionLoading.value = true
  versionError.value = ''

  try {
    const payload = await getMeta()
    const nextVersion = String(payload?.version || '').trim()
    version.value = nextVersion
    if (!nextVersion) {
      versionError.value = t('settingsDialog.about.versionPending')
    }
  } catch (error) {
    version.value = ''
    versionError.value = error?.message || t('settingsDialog.about.versionLoadFailed')
  } finally {
    versionLoading.value = false
  }
}

function syncRelayForm(payload = {}) {
  relayForm.enabled = Boolean(payload?.enabled)
  relayForm.relayUrl = String(payload?.relayUrl || '')
  relayForm.deviceId = String(payload?.deviceId || '')
  relayForm.deviceToken = String(payload?.deviceToken || '')
}

function syncSystemForm(payload = {}) {
  systemForm.runnerMaxConcurrentRuns = Math.max(1, Number(payload?.runner?.maxConcurrentRuns) || 3)
  generalForm.remoteCommandSecurityEnabled = Boolean(payload?.remoteCommandSecurity?.enabled)
  generalForm.remoteCommandSecurityMode = String(payload?.remoteCommandSecurity?.mode || 'relay').trim() || 'relay'
  generalForm.trustedProxyToken = String(payload?.remoteCommandSecurity?.trustedProxyToken || '')
}

function syncGeneralForm() {
  generalForm.sendBehavior = String(
    getPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR)
      || WORKBENCH_SEND_BEHAVIOR_OPTIONS[1]?.value
      || ''
  )
}

async function loadRelayConfig() {
  relayLoading.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await getRelayConfig()
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayConfigLoadFailed')
    relayStatus.value = null
  } finally {
    relayLoading.value = false
  }
}

async function loadSystemConfig() {
  systemLoading.value = true
  systemError.value = ''
  systemSuccess.value = ''

  try {
    const payload = await getSystemConfig()
    syncSystemForm(payload?.config || {})
    systemManagedByEnv.runnerMaxConcurrentRuns = Boolean(payload?.managedByEnv?.runner?.maxConcurrentRuns)
    loadRuntimeDiagnostics()
  } catch (error) {
    systemError.value = error?.message || t('settingsDialog.system.systemConfigLoadFailed')
  } finally {
    systemLoading.value = false
  }
}

async function loadRuntimeDiagnostics() {
  systemDiagnosticsLoading.value = true
  systemDiagnosticsError.value = ''

  try {
    systemDiagnostics.value = await getRuntimeDiagnostics()
  } catch (error) {
    systemDiagnosticsError.value = error?.message || t('settingsDialog.system.systemDiagnosticsLoadFailed')
  } finally {
    systemDiagnosticsLoading.value = false
  }
}

async function handleSaveRelay() {
  relaySaving.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await updateRelayConfig({
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceToken: relayForm.deviceToken,
    })
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
    relaySuccess.value = relayForm.enabled
      ? t('settingsDialog.relay.relayConfigSavedEnabled')
      : t('settingsDialog.relay.relayConfigSavedDisabled')
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayConfigSaveFailed')
  } finally {
    relaySaving.value = false
  }
}

async function handleReconnectRelay() {
  relayReconnecting.value = true
  relayError.value = ''
  relaySuccess.value = ''

  try {
    const payload = await reconnectRelay()
    relayStatus.value = payload?.relay || null
    relaySuccess.value = t('settingsDialog.relay.relayReconnectTriggered')
    setTimeout(() => {
      loadRelayConfig()
    }, 1200)
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayReconnectFailed')
  } finally {
    relayReconnecting.value = false
  }
}

async function handleSaveSystem() {
  systemSaving.value = true
  systemError.value = ''
  systemSuccess.value = ''

  try {
    const payload = await updateSystemConfig({
      runner: {
        maxConcurrentRuns: systemForm.runnerMaxConcurrentRuns,
      },
      remoteCommandSecurity: {
        enabled: generalForm.remoteCommandSecurityEnabled,
        mode: generalForm.remoteCommandSecurityMode,
        trustedProxyToken: generalForm.remoteCommandSecurityMode === 'trusted-proxy'
          ? generalForm.trustedProxyToken
          : '',
      },
    })
    syncSystemForm(payload?.config || {})
    systemManagedByEnv.runnerMaxConcurrentRuns = Boolean(payload?.managedByEnv?.runner?.maxConcurrentRuns)
    systemSuccess.value = t('settingsDialog.system.systemConfigSaved')
    loadRuntimeDiagnostics()
  } catch (error) {
    systemError.value = error?.message || t('settingsDialog.system.systemConfigSaveFailed')
  } finally {
    systemSaving.value = false
  }
}

function clearGeneralSecuritySavedState() {
  if (generalSecuritySavedTimer) {
    clearTimeout(generalSecuritySavedTimer)
    generalSecuritySavedTimer = null
  }
  generalSecuritySaved.value = false
}

async function handleSaveRemoteCommandSecurity() {
  generalSecuritySaving.value = true
  systemError.value = ''

  try {
    const payload = await updateSystemConfig({
      runner: {
        maxConcurrentRuns: systemForm.runnerMaxConcurrentRuns,
      },
      remoteCommandSecurity: {
        enabled: generalForm.remoteCommandSecurityEnabled,
        mode: generalForm.remoteCommandSecurityMode,
        trustedProxyToken: generalForm.remoteCommandSecurityMode === 'trusted-proxy'
          ? generalForm.trustedProxyToken
          : '',
      },
    })

    syncSystemForm(payload?.config || {})
    clearGeneralSecuritySavedState()
    generalSecuritySaved.value = true
    generalSecuritySavedTimer = setTimeout(() => {
      generalSecuritySaved.value = false
      generalSecuritySavedTimer = null
    }, 1200)
  } catch (error) {
    systemError.value = error?.message || t('settingsDialog.system.systemConfigSaveFailed')
  } finally {
    generalSecuritySaving.value = false
  }
}

function hasCompleteRelayFields() {
  return Boolean(
    String(relayForm.relayUrl || '').trim()
    && String(relayForm.deviceId || '').trim()
    && String(relayForm.deviceToken || '').trim()
  )
}

async function handleToggleRelayEnabled() {
  if (relayManagedByEnv.value) {
    return
  }

  relayError.value = ''
  relaySuccess.value = ''

  if (relayForm.enabled && !hasCompleteRelayFields()) {
    relayForm.enabled = false
    relayError.value = t('settingsDialog.relay.relayFieldsRequired')
    return
  }

  relayToggleSaving.value = true
  try {
    const payload = await updateRelayConfig({
      enabled: relayForm.enabled,
      relayUrl: relayForm.relayUrl,
      deviceId: relayForm.deviceId,
      deviceToken: relayForm.deviceToken,
    })
    syncRelayForm(payload?.config || {})
    relayManagedByEnv.value = Boolean(payload?.managedByEnv)
    relayStatus.value = payload?.relay || null
    relaySuccess.value = relayForm.enabled
      ? t('settingsDialog.relay.relayEnabledSaved')
      : t('settingsDialog.relay.relayConfigSavedDisabled')
  } catch (error) {
    relayForm.enabled = Boolean(relayStatus.value?.enabled)
    relayError.value = error?.message || t('settingsDialog.relay.relayToggleFailed')
  } finally {
    relayToggleSaving.value = false
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    await navigator.clipboard.writeText(text)
    return
  }

  const textarea = document.createElement('textarea')
  textarea.value = text
  textarea.setAttribute('readonly', 'true')
  textarea.style.position = 'fixed'
  textarea.style.opacity = '0'
  textarea.style.pointerEvents = 'none'
  document.body.appendChild(textarea)
  textarea.select()
  document.execCommand('copy')
  document.body.removeChild(textarea)
}

async function handleCopyRelayDiagnostics() {
  try {
    await copyText(relayDiagnosticsText.value)
    relayCopied.value = true
    if (relayCopyTimer) {
      clearTimeout(relayCopyTimer)
    }
    relayCopyTimer = setTimeout(() => {
      relayCopied.value = false
      relayCopyTimer = null
    }, 2000)
  } catch (error) {
    relayError.value = error?.message || t('settingsDialog.relay.relayDiagnosticsCopyFailed')
  }
}

async function handleCopySystemDiagnostics() {
  try {
    await copyText(systemDiagnosticsText.value)
    systemCopied.value = true
    if (systemCopyTimer) {
      clearTimeout(systemCopyTimer)
    }
    systemCopyTimer = setTimeout(() => {
      systemCopied.value = false
      systemCopyTimer = null
    }, 2000)
  } catch (error) {
    systemDiagnosticsError.value = error?.message || t('settingsDialog.system.systemDiagnosticsCopyFailed')
  }
}

function handleLocaleChange(nextLocale) {
  setLocale(nextLocale)
}

function stopSystemDiagnosticsPolling() {
  if (systemDiagnosticsTimer) {
    clearInterval(systemDiagnosticsTimer)
    systemDiagnosticsTimer = null
  }
}

function startSystemDiagnosticsPolling() {
  stopSystemDiagnosticsPolling()
  if (!props.open || activeSection.value !== 'system') {
    return
  }

  loadRuntimeDiagnostics()
  systemDiagnosticsTimer = setInterval(() => {
    loadRuntimeDiagnostics()
  }, 5000)
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = 'general'
      syncGeneralForm()
      loadMeta()
      loadRelayConfig()
      loadSystemConfig()
      return
    }
  },
  { immediate: true }
)

watch(
  [() => props.open, activeSection],
  ([open, section]) => {
    if (open && section === 'system') {
      startSystemDiagnosticsPolling()
      return
    }

    stopSystemDiagnosticsPolling()
  },
  { immediate: true }
)

onBeforeUnmount(() => {
  if (relayCopyTimer) {
    clearTimeout(relayCopyTimer)
    relayCopyTimer = null
  }
  if (systemCopyTimer) {
    clearTimeout(systemCopyTimer)
    systemCopyTimer = null
  }
  clearGeneralSecuritySavedState()
  stopSystemDiagnosticsPolling()
})
</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="2"
    panel-class="settings-dialog-panel h-full max-w-5xl sm:h-[42rem] sm:max-h-[88vh]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex flex-1 flex-col sm:flex-row"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <Settings2 class="h-4 w-4" />
        <span>{{ t('common.settings') }}</span>
      </div>
    </template>

    <DialogSideNav
      v-model="activeSection"
      :sections="settingsSections"
    />

    <div class="settings-dialog-content min-h-0 flex-1 overflow-y-auto px-5 py-5">
            <section
              v-if="activeSection === 'general'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Keyboard class="h-4 w-4" />
                  <span>{{ t('settingsDialog.general.title') }}</span>
                </div>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div>
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.general.sendBehavior.title') }}</div>
                  <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.general.sendBehavior.description') }}</p>
                </div>

                <div class="grid gap-3">
                  <label
                    v-for="option in sendBehaviorOptions"
                    :key="option.value"
                    class="settings-form-card flex items-start gap-3 px-3 py-3"
                  >
                    <input
                      v-model="generalForm.sendBehavior"
                      :value="option.value"
                      type="radio"
                      name="workbench-send-behavior"
                      class="mt-0.5 h-4 w-4"
                      @change="setPreference(WORKBENCH_PREFERENCE_KEYS.SEND_BEHAVIOR, option.value)"
                    >
                    <div class="min-w-0">
                      <div class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ option.label }}</div>
                      <p class="theme-muted-text mt-1 text-xs leading-5">{{ option.description }}</p>
                    </div>
                  </label>
                </div>
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div>
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.general.remoteCommandSecurityTitle') }}</div>
                  <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.general.remoteCommandSecurityDescription') }}</p>
                </div>

                <label class="settings-form-card flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('settingsDialog.general.remoteCommandSecurityEnableTitle') }}</div>
                    <p class="theme-muted-text mt-1 text-xs">{{ t('settingsDialog.general.remoteCommandSecurityEnableDescription') }}</p>
                  </div>
                  <input
                    v-model="generalForm.remoteCommandSecurityEnabled"
                    type="checkbox"
                    class="h-4 w-4"
                  />
                </label>

                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('settingsDialog.general.remoteCommandSecurityModeField') }}</span>
                  <WorkbenchSelect
                    v-model="generalForm.remoteCommandSecurityMode"
                    :options="[
                      { value: 'relay', label: t('settingsDialog.general.remoteCommandSecurityModeRelay') },
                      { value: 'trusted-proxy', label: t('settingsDialog.general.remoteCommandSecurityModeTrustedProxy') },
                    ]"
                    :get-option-value="(option) => option.value"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                    <template #option="{ option, select }">
                      <button
                        type="button"
                        class="workbench-select-option theme-filter-idle w-full rounded-sm border border-dashed px-3 py-2 text-left text-sm"
                        @click="select()"
                      >
                        {{ option.label }}
                      </button>
                    </template>
                  </WorkbenchSelect>
                </label>

                <label v-if="generalForm.remoteCommandSecurityMode === 'trusted-proxy'" class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('settingsDialog.general.trustedProxyTokenField') }}</span>
                  <input
                    v-model="generalForm.trustedProxyToken"
                    type="password"
                    class="tool-input"
                    :placeholder="t('settingsDialog.general.trustedProxyTokenPlaceholder')"
                  >
                  <p class="theme-muted-text text-xs leading-5">
                    {{ t('settingsDialog.general.trustedProxyTokenHint') }}
                  </p>
                </label>

                <div class="settings-form-card px-3 py-3">
                  <p class="text-xs leading-5 text-[var(--theme-warningText)]">
                    {{ t('settingsDialog.general.remoteCommandSecurityWarning') }}
                  </p>
                </div>

                <div class="settings-form-footer flex flex-wrap items-center justify-end gap-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :class="generalSecuritySaved ? 'tool-button-accent-subtle' : 'tool-button-primary'"
                      :disabled="generalSecuritySaving"
                      @click="handleSaveRemoteCommandSecurity"
                    >
                      <LoaderCircle v-if="generalSecuritySaving" class="h-4 w-4 animate-spin" />
                      <Check v-else-if="generalSecuritySaved" class="h-4 w-4" />
                      <span>
                        {{
                          generalSecuritySaving
                            ? t('common.saving')
                            : generalSecuritySaved
                              ? t('settingsDialog.general.remoteCommandSecuritySaved')
                              : t('settingsDialog.general.remoteCommandSecuritySave')
                        }}
                      </span>
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'theme'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading text-base font-medium">{{ t('theme.title') }}</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('theme.sectionDescription') }}</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <ThemeToggle />
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div>
                  <div class="theme-heading text-sm font-medium">{{ t('locale.title') }}</div>
                  <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('locale.description') }}</p>
                </div>

                <label class="block space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('locale.field') }}</span>
                  <WorkbenchSelect
                    :model-value="locale"
                    :options="localeFieldOptions"
                    :get-option-value="(option) => option.value"
                    @update:model-value="handleLocaleChange"
                  >
                    <template #trigger="{ selectedOption }">
                      <div class="truncate text-sm text-[var(--theme-textPrimary)]">
                        {{ selectedOption?.label || t('common.select') }}
                      </div>
                    </template>
                    <template #option="{ option, selected, select }">
                      <button
                        type="button"
                        class="workbench-select-option theme-filter-idle w-full rounded-sm border border-dashed px-3 py-2 text-left text-sm"
                        @click="select()"
                      >
                        <div class="flex items-center justify-between gap-3">
                          <div class="min-w-0">
                            <div class="truncate text-[var(--theme-textPrimary)]">{{ option.label }}</div>
                            <div class="theme-muted-text mt-1 truncate text-xs">{{ option.englishLabel }}</div>
                          </div>
                          <span v-if="selected" class="theme-status-success rounded-sm border border-dashed px-2 py-0.5 text-[10px]">{{ t('common.enabled') }}</span>
                        </div>
                      </button>
                    </template>
                  </WorkbenchSelect>
                </label>

                <p class="theme-muted-text theme-note-text">{{ t('locale.immediateHint') }}</p>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'relay'"
              class="space-y-4"
            >
              <div class="flex items-start justify-between gap-3">
                  <div>
                    <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                      <Wifi class="h-4 w-4" />
                    <span>{{ t('settingsDialog.relay.title') }}</span>
                  </div>
                </div>
                <span
                  class="rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium"
                  :class="relayStatusClass"
                >
                  {{ relayStatusLabel }}
                </span>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="settings-form-card flex items-center justify-between gap-3 px-3 py-2">
                  <div>
                    <div class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('settingsDialog.relay.enableTitle') }}</div>
                    <p class="theme-muted-text mt-1 text-xs">{{ t('settingsDialog.relay.enableDescription') }}</p>
                  </div>
                  <input
                    v-model="relayForm.enabled"
                    type="checkbox"
                    class="h-4 w-4"
                    :disabled="relayManagedByEnv"
                    @change="handleToggleRelayEnabled"
                  />
                </label>

                <div class="grid gap-4 sm:grid-cols-2">
                  <label class="space-y-1.5 sm:col-span-2">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.relayUrl') }}</span>
                    <input
                      v-model="relayForm.relayUrl"
                      type="text"
                      placeholder="https://user1.promptx.example.com"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.deviceId') }}</span>
                    <input
                      v-model="relayForm.deviceId"
                      type="text"
                      placeholder="my-macbook"
                      class="tool-input"
                      :disabled="relayManagedByEnv"
                    >
                  </label>

                  <label class="space-y-1.5">
                    <span class="theme-muted-text text-xs">{{ t('settingsDialog.relay.deviceToken') }}</span>
                    <div class="relative">
                      <input
                        v-model="relayForm.deviceToken"
                        :type="relayTokenVisible ? 'text' : 'password'"
                        :placeholder="t('settingsDialog.relay.deviceTokenPlaceholder')"
                        class="tool-input pr-10"
                        :disabled="relayManagedByEnv"
                      >
                      <button
                        type="button"
                        class="theme-icon-button absolute inset-y-1 right-1 flex h-auto w-8 items-center justify-center"
                        :disabled="relayManagedByEnv"
                        @click="relayTokenVisible = !relayTokenVisible"
                      >
                        <Eye v-if="!relayTokenVisible" class="h-4 w-4" />
                        <EyeOff v-else class="h-4 w-4" />
                      </button>
                    </div>
                  </label>
                </div>

                <div class="settings-form-footer flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="relayStatus?.reconnectPausedReason"
                      class="theme-danger-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.pausedReconnect', { reason: resolveRelayReason(relayStatus.reconnectPausedReasonCode, relayStatus.reconnectPausedReason) }) }}
                    </p>
                    <p
                      v-if="relayManagedByEnv"
                      class="theme-status-warning theme-note-text"
                    >
                      {{ t('settingsDialog.relay.managedByEnv') }}
                    </p>
                    <p v-if="relayError" class="theme-danger-text theme-note-text">{{ relayError }}</p>
                    <p v-else-if="relaySuccess" class="theme-status-success theme-note-text">{{ relaySuccess }}</p>
                    <p
                      v-else-if="relayStatus?.lastError"
                      class="theme-danger-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastError', { value: resolveRelayErrorText(relayStatus) }) }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastCloseReason"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastClosed', { reason: resolveRelayReason(relayStatus.lastCloseReasonCode, relayStatus.lastCloseReason), code: relayStatus.lastCloseCode }) }}
                    </p>
                    <p
                      v-else-if="relayStatus?.lastConnectedAt"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.lastConnected', { value: formatDateTime(relayStatus.lastConnectedAt) }) }}
                    </p>
                    <p
                      v-if="relayStatus?.recentEvents?.length"
                      class="theme-muted-text theme-note-text"
                    >
                      {{ t('settingsDialog.relay.recentEvent', { value: resolveRelayEventLabel(relayStatus.recentEvents[0]) }) }}
                    </p>
                    <p
                      v-if="relayCopied"
                      class="theme-status-success theme-note-text"
                    >
                      {{ t('settingsDialog.relay.copied') }}
                    </p>
                    <p v-if="showRelayDefaultHint" class="theme-muted-text theme-note-text">
                      {{ t('settingsDialog.relay.defaultHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relaySaving || relayToggleSaving || relayReconnecting || !(relayStatus?.enabled ?? relayForm.enabled)"
                      @click="handleReconnectRelay"
                    >
                      <LoaderCircle v-if="relayReconnecting" class="h-4 w-4 animate-spin" />
                      <span>{{ relayReconnecting ? t('settingsDialog.relay.reconnecting') : t('settingsDialog.relay.reconnectNow') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relayReconnecting"
                      @click="handleCopyRelayDiagnostics"
                    >
                      <span>{{ relayCopied ? t('settingsDialog.relay.diagnosticsCopied') : t('settingsDialog.relay.copyDiagnostics') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="relayLoading || relaySaving || relayToggleSaving || relayReconnecting || relayManagedByEnv"
                      @click="handleSaveRelay"
                    >
                      <LoaderCircle v-if="relaySaving" class="h-4 w-4 animate-spin" />
                      <span>{{ relaySaving ? t('common.saving') : t('settingsDialog.relay.saveConfig') }}</span>
                    </button>
                  </div>
                </div>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'system'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Cpu class="h-4 w-4" />
                  <span>{{ t('settingsDialog.system.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">
                  {{ t('settingsDialog.system.intro') }}
                </p>
              </div>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <label class="space-y-1.5">
                  <span class="theme-muted-text text-xs">{{ t('settingsDialog.system.maxConcurrentRuns') }}</span>
                  <input
                    v-model.number="systemForm.runnerMaxConcurrentRuns"
                    type="number"
                    min="1"
                    max="16"
                    step="1"
                    class="tool-input"
                    :disabled="systemManagedByEnv.runnerMaxConcurrentRuns || systemLoading || systemSaving"
                  >
                  <p class="theme-muted-text text-xs leading-5">
                    {{ t('settingsDialog.system.maxConcurrentRunsHint') }}
                  </p>
                </label>

                <div class="settings-form-footer flex flex-wrap items-center justify-between gap-3">
                  <div class="min-w-0 space-y-1">
                    <p
                      v-if="systemManagedByEnv.runnerMaxConcurrentRuns"
                      class="theme-status-warning theme-note-text"
                    >
                      {{ t('settingsDialog.system.managedByEnv') }}
                    </p>
                    <p v-else-if="systemError" class="theme-danger-text theme-note-text">{{ systemError }}</p>
                    <p v-else-if="systemSuccess" class="theme-status-success theme-note-text">{{ systemSuccess }}</p>
                    <p v-else class="theme-muted-text theme-note-text">
                      {{ t('settingsDialog.system.diagnosticsHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button tool-button-primary inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="systemManagedByEnv.runnerMaxConcurrentRuns || systemLoading || systemSaving"
                      @click="handleSaveSystem"
                    >
                      <LoaderCircle v-if="systemSaving" class="h-4 w-4 animate-spin" />
                      <span>{{ systemSaving ? t('common.saving') : t('settingsDialog.system.saveConfig') }}</span>
                    </button>
                  </div>
                </div>
              </section>

              <section class="settings-section-card space-y-4 px-4 py-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.runtimeDiagnostics') }}</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ t('settingsDialog.system.runtimeDiagnosticsHint') }}
                    </p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      :disabled="systemDiagnosticsLoading"
                      @click="loadRuntimeDiagnostics"
                    >
                      <LoaderCircle v-if="systemDiagnosticsLoading" class="h-4 w-4 animate-spin" />
                      <span>{{ systemDiagnosticsLoading ? t('settingsDialog.system.refreshingDiagnostics') : t('settingsDialog.system.refreshDiagnostics') }}</span>
                    </button>
                    <button
                      type="button"
                      class="tool-button inline-flex items-center gap-2 px-3 py-2 text-xs"
                      @click="handleCopySystemDiagnostics"
                    >
                      <span>{{ systemCopied ? t('settingsDialog.system.diagnosticsCopied') : t('settingsDialog.system.copyDiagnostics') }}</span>
                    </button>
                  </div>
                </div>

                <div class="min-w-0 space-y-1">
                  <p v-if="systemDiagnosticsError" class="theme-danger-text theme-note-text">{{ systemDiagnosticsError }}</p>
                  <p v-else-if="systemCopied" class="theme-status-success theme-note-text">
                    {{ t('settingsDialog.system.diagnosticsCopiedHint') }}
                  </p>
                  <p v-else class="theme-muted-text theme-note-text">
                    {{ t('settingsDialog.system.diagnosticsHint') }}
                  </p>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">active</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.activeRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.active') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">tracked</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.trackedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.tracked') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">queued</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.queuedRunCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.queued') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">maxConcurrent</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerDiagnostics?.config?.maxConcurrentRuns || systemForm.runnerMaxConcurrentRuns }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.maxConcurrent') }}</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">completed</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalCompleted || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.completed') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stopped</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopped || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.stopped') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">error</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalErrored || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.error') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">stop_timeout</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.totalStopTimeout || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.stopTimeout') }}</p>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
                >
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">event flush failures</div>
                    <div class="theme-heading text-lg font-medium">{{ runnerMetrics?.eventFlushFailureCount || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.eventWriteFailures') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">recovered runs</div>
                    <div class="theme-heading text-lg font-medium">{{ recoveryDiagnostics?.metrics?.totalRecovered || 0 }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.recoveredRuns') }}</p>
                  </div>
                  <div class="settings-form-card space-y-1 px-3 py-3">
                    <div class="theme-muted-text text-xs">last cleanup</div>
                    <div class="theme-heading text-sm font-medium">{{ formatDateTime(maintenanceDiagnostics?.lastCleanup?.finishedAt) }}</div>
                    <p class="theme-muted-text text-xs">{{ t('settingsDialog.system.lastMaintenanceAt') }}</p>
                  </div>
                </div>

                <div class="grid gap-4 lg:grid-cols-2">
                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.baseStatus') }}</div>
                    <div class="space-y-2 text-xs">
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">runner baseUrl</span>
                        <span class="truncate text-right text-[var(--theme-textPrimary)]">{{ systemDiagnostics?.runner?.baseUrl || '-' }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">runner startedAt</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(runnerDiagnostics?.startedAt) }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">last sweep</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(recoveryDiagnostics?.metrics?.lastSweepFinishedAt) }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">git diff worker</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ gitDiffWorkerDiagnostics ? t('settingsDialog.system.available') : t('settingsDialog.system.unknown') }}</span>
                      </div>
                      <div class="flex items-center justify-between gap-3">
                        <span class="theme-muted-text">db vacuum</span>
                        <span class="text-right text-[var(--theme-textPrimary)]">{{ formatDateTime(maintenanceDiagnostics?.lastVacuumAt) }}</span>
                      </div>
                    </div>
                  </div>

                  <div class="settings-form-card space-y-3 px-3 py-3">
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.stopReasonTitle') }}</div>
                    <div class="space-y-2 text-xs">
                      <div
                        v-for="item in runnerStopReasonRows"
                        :key="item.key"
                        class="flex items-center justify-between gap-3"
                      >
                        <span class="theme-muted-text">{{ item.label }}</span>
                        <span class="text-[var(--theme-textPrimary)]">{{ item.value }}</span>
                      </div>
                    </div>
                  </div>
                </div>

                <div
                  v-if="runnerDiagnosticsOk"
                  class="settings-form-card space-y-3 px-3 py-3"
                >
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.stopTimeoutPhaseTitle') }}</div>
                  <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 text-xs">
                    <div
                      v-for="item in runnerStopTimeoutPhaseRows"
                      :key="item.key"
                      class="flex items-center justify-between gap-3 rounded-sm border border-dashed border-[var(--theme-borderMuted)] px-2.5 py-2"
                    >
                      <span class="theme-muted-text">{{ item.label }}</span>
                      <span class="text-[var(--theme-textPrimary)]">{{ item.value }}</span>
                    </div>
                  </div>
                </div>

                <div
                  v-if="!runnerDiagnosticsOk && !systemDiagnosticsLoading"
                  class="settings-form-card space-y-2 px-3 py-3"
                >
                  <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.system.runnerUnavailable') }}</div>
                  <p class="theme-muted-text text-xs leading-5">
                    {{ resolvePayloadMessage(systemDiagnostics?.runner, 'settingsDialog.system.runnerUnavailableDescription') }}
                  </p>
                  <p class="theme-muted-text text-xs leading-5">
                    baseUrl: {{ systemDiagnostics?.runner?.baseUrl || '-' }}
                  </p>
                </div>
              </section>
            </section>

            <section
              v-else-if="activeSection === 'shortcuts'"
              class="space-y-4"
            >
              <div>
                <div class="theme-heading inline-flex items-center gap-2 text-base font-medium">
                  <Keyboard class="h-4 w-4" />
                  <span>{{ t('settingsDialog.shortcuts.title') }}</span>
                </div>
                <p class="theme-muted-text mt-1 text-xs leading-5">
                  {{ t('settingsDialog.shortcuts.intro') }}
                </p>
              </div>

              <section class="settings-section-card space-y-3 px-4 py-4">
                <div
                  v-for="item in shortcutItems"
                  :key="item.id"
                  class="settings-form-card flex flex-col justify-between gap-3 px-3 py-3 sm:flex-row sm:items-center"
                >
                  <div class="min-w-0">
                    <div class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ item.label }}</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">{{ item.description }}</p>
                  </div>

                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-sm border border-dashed border-[var(--theme-borderDefault)] px-2.5 py-1 text-xs font-medium text-[var(--theme-textPrimary)]">
                      {{ item.mac }}
                    </span>
                    <span class="rounded-sm border border-dashed border-[var(--theme-borderDefault)] px-2.5 py-1 text-xs font-medium text-[var(--theme-textPrimary)]">
                      {{ item.windows }}
                    </span>
                  </div>
                </div>

                <p class="theme-muted-text theme-note-text">
                  {{ t('settingsDialog.shortcuts.note') }}
                </p>
              </section>
            </section>

            <section
              v-else
              class="space-y-4"
            >
              <div>
                <div class="theme-heading text-base font-medium">{{ t('settingsDialog.about.title') }}</div>
                <p class="theme-muted-text mt-1 text-xs leading-5">{{ t('settingsDialog.about.intro') }}</p>
              </div>

              <section class="settings-section-card px-4 py-4">
                <div class="flex items-center justify-between gap-3">
                  <div>
                    <div class="theme-heading text-sm font-medium">{{ t('settingsDialog.about.versionTitle') }}</div>
                    <p class="theme-muted-text mt-1 text-xs leading-5">
                      {{ versionError || t('settingsDialog.about.versionDescription') }}
                    </p>
                  </div>
                  <span class="theme-badge-strong rounded-sm border border-dashed px-2.5 py-1 text-xs font-medium">
                    {{ versionLoading ? t('common.loading') : version ? `v${version}` : t('common.unavailable') }}
                  </span>
                </div>
              </section>
            </section>
    </div>
  </DialogShell>
</template>
