<script setup>
import { computed, ref, watch } from 'vue'
import { Check, Copy, Info, LoaderCircle, Palette, RadioTower, RefreshCw, RotateCcw, Settings2, X } from 'lucide-vue-next'
import QRCode from 'qrcode'
import DialogShell from './DialogShell.vue'
import ConfirmDialog from './ConfirmDialog.vue'
import ThemeToggle from './ThemeToggle.vue'
import PxButton from './PxButton.vue'
import PxIconButton from './PxIconButton.vue'
import { v2Api } from '../lib/v2Api.js'
import { writeClipboardText } from '../lib/clipboard.js'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close'])
const activeSection = ref('appearance')
const relayLoading = ref(false)
const relaySaving = ref(false)
const relayError = ref('')
const relayData = ref(null)
const relayForm = ref({ enabled: true, relayUrl: '', appUrl: '' })
const pairingQr = ref('')
const copied = ref(false)
const confirmReset = ref(false)

const sections = [
  { id: 'appearance', label: '外观', icon: Palette },
  { id: 'remote', label: '远程访问', icon: RadioTower },
  { id: 'about', label: '关于', icon: Info },
]

const relayStatusLabel = computed(() => {
  if (!relayForm.value.enabled) return '已关闭'
  return relayData.value?.relay?.connected ? '已连接' : '连接中'
})

async function updateQr(url = '') {
  pairingQr.value = url ? await QRCode.toDataURL(url, { width: 224, margin: 1, errorCorrectionLevel: 'M' }) : ''
}

async function loadRelay() {
  relayLoading.value = true
  relayError.value = ''
  try {
    relayData.value = await v2Api.getRelayConfig()
    relayForm.value = { ...relayData.value.config }
    await updateQr(relayData.value.pairing?.url)
  } catch (error) {
    relayError.value = error.message
  } finally {
    relayLoading.value = false
  }
}

async function saveRelay() {
  if (relaySaving.value) return
  relaySaving.value = true
  relayError.value = ''
  try {
    relayData.value = await v2Api.updateRelayConfig(relayForm.value)
    relayForm.value = { ...relayData.value.config }
    await updateQr(relayData.value.pairing?.url)
  } catch (error) {
    relayError.value = error.message
  } finally {
    relaySaving.value = false
  }
}

async function copyPairingUrl() {
  const url = relayData.value?.pairing?.url
  if (!url) return
  relayError.value = ''
  try {
    await writeClipboardText(url)
    copied.value = true
    setTimeout(() => { copied.value = false }, 1500)
  } catch {
    copied.value = false
    relayError.value = '复制链接失败，请长按链接手动复制。'
  }
}

async function reconnectRelay() {
  relayLoading.value = true
  relayError.value = ''
  try {
    relayData.value = await v2Api.reconnectRelay()
  } catch (error) {
    relayError.value = error.message
  } finally {
    relayLoading.value = false
    setTimeout(loadRelay, 800)
  }
}

async function resetIdentity() {
  confirmReset.value = false
  relayLoading.value = true
  relayError.value = ''
  try {
    relayData.value = await v2Api.resetRelayIdentity()
    relayForm.value = { ...relayData.value.config }
    await updateQr(relayData.value.pairing?.url)
  } catch (error) {
    relayError.value = error.message
  } finally {
    relayLoading.value = false
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      activeSection.value = 'appearance'
      loadRelay()
    }
  }
)
</script>

<template>
  <DialogShell
    :open="open"
    :show-close="false"
    :stack-level="2"
    panel-class="v2-settings-panel h-[100dvh] max-w-none sm:h-[min(88vh,760px)] sm:max-w-4xl"
    header-class="v2-settings-header h-14 px-4 sm:px-5"
    body-class="v2-settings-body flex min-h-0 flex-1 flex-col sm:flex-row"
    @close="emit('close')"
  >
    <template #title>
      <div class="flex h-full items-center justify-between gap-4">
        <h2 class="theme-heading flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Settings2 class="h-4 w-4 shrink-0" />
          <span>设置</span>
        </h2>
        <PxIconButton class="h-8 w-8 shrink-0" label="关闭设置" @click="emit('close')"><X class="h-4 w-4" /></PxIconButton>
      </div>
    </template>

    <aside class="v2-settings-nav shrink-0 px-2 py-2 sm:w-52 sm:px-3 sm:py-4">
      <nav class="flex gap-1 overflow-x-auto sm:flex-col sm:overflow-visible">
        <button
          v-for="section in sections"
          :key="section.id"
          type="button"
          class="v2-settings-nav-item flex h-9 shrink-0 items-center justify-start gap-2 rounded-sm border-0 px-3 text-left text-xs sm:w-full"
          :class="activeSection === section.id ? 'is-active' : ''"
          @click="activeSection = section.id"
        >
          <component :is="section.icon" class="h-4 w-4 shrink-0" />
          <span>{{ section.label }}</span>
        </button>
      </nav>
    </aside>

    <div class="v2-settings-content min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-8 sm:py-7">
      <section v-if="activeSection === 'appearance'" class="mx-auto w-full max-w-2xl">
        <div class="mb-6">
          <h2 class="theme-heading text-lg font-semibold">外观</h2>
          <p class="theme-muted-text mt-1 text-xs">选择 PromptX 的界面皮肤。</p>
        </div>
        <ThemeToggle />
      </section>

      <section v-else-if="activeSection === 'remote'" class="mx-auto w-full max-w-2xl">
        <div class="mb-6 flex items-start justify-between gap-4">
          <div>
            <h2 class="theme-heading text-lg font-semibold">远程访问</h2>
            <p class="theme-muted-text mt-1 text-xs">通过端到端加密 Relay 从手机访问这台电脑。</p>
          </div>
          <div class="relay-status flex shrink-0 items-center gap-2 text-xs" :class="relayData?.relay?.connected ? 'is-connected' : ''">
            <span class="h-2 w-2 rounded-full" />{{ relayStatusLabel }}
          </div>
        </div>

        <div v-if="relayLoading && !relayData" class="theme-muted-text flex h-40 items-center justify-center"><LoaderCircle class="h-4 w-4 animate-spin" /></div>
        <template v-else>
          <div v-if="relayError" class="relay-error mb-4 rounded-sm px-3 py-2 text-xs">{{ relayError }}</div>

          <label class="relay-toggle flex items-center justify-between gap-4 py-3">
            <span><span class="theme-heading block text-sm font-medium">启用 Relay</span><span class="theme-muted-text mt-1 block text-xs">daemon 将主动连接公共 Relay。</span></span>
            <input v-model="relayForm.enabled" type="checkbox" class="h-4 w-4" @change="saveRelay" />
          </label>

          <div class="mt-5 grid gap-4">
            <label class="block">
              <span class="theme-muted-text mb-1.5 block text-xs">Relay 地址</span>
              <input v-model="relayForm.relayUrl" class="relay-input h-9 w-full rounded-sm px-3 font-mono text-xs" spellcheck="false" @change="saveRelay" />
            </label>
            <label class="block">
              <span class="theme-muted-text mb-1.5 block text-xs">公网 Web 地址</span>
              <input v-model="relayForm.appUrl" class="relay-input h-9 w-full rounded-sm px-3 font-mono text-xs" spellcheck="false" @change="saveRelay" />
            </label>
          </div>

          <div v-if="relayData?.pairing?.url" class="mt-7 grid items-start gap-5 sm:grid-cols-[1fr_auto]">
            <div class="min-w-0">
              <div class="theme-heading text-sm font-medium">配对链接</div>
              <p class="theme-muted-text mt-1 text-xs">完整链接等同远程访问凭证，不要公开分享。</p>
              <div class="relay-link mt-3 flex min-w-0 items-center gap-2 rounded-sm px-3 py-2">
                <span class="min-w-0 flex-1 truncate font-mono text-[11px]">{{ relayData.pairing.url }}</span>
                <PxIconButton class="h-7 w-7 shrink-0" :label="copied ? '已复制' : '复制链接'" @click="copyPairingUrl"><Check v-if="copied" class="h-3.5 w-3.5" /><Copy v-else class="h-3.5 w-3.5" /></PxIconButton>
              </div>
              <div class="mt-4 flex flex-wrap gap-2">
                <PxButton variant="secondary" size="sm" class="h-8 gap-1.5 text-xs" :disabled="relayLoading" @click="reconnectRelay"><RefreshCw class="h-3.5 w-3.5" :class="relayLoading ? 'animate-spin' : ''" />重新连接</PxButton>
                <PxButton variant="secondary" size="sm" class="h-8 gap-1.5 text-xs" :disabled="relayLoading" @click="confirmReset = true"><RotateCcw class="h-3.5 w-3.5" />重置远程身份</PxButton>
              </div>
            </div>
            <img v-if="pairingQr" :src="pairingQr" alt="PromptX 远程访问二维码" class="relay-qr h-40 w-40 rounded-sm p-2" />
          </div>
        </template>
      </section>

      <section v-else class="mx-auto w-full max-w-2xl">
        <div class="mb-6">
          <h2 class="theme-heading text-lg font-semibold">关于</h2>
        </div>
        <div class="v2-settings-about flex items-center justify-between gap-4 py-3">
          <div>
            <div class="theme-heading text-sm font-medium">PromptX</div>
            <div class="theme-muted-text mt-1 text-xs">本地 AI 编程工作台</div>
          </div>
          <span class="theme-muted-text font-mono text-xs">V2</span>
        </div>
      </section>
    </div>
  </DialogShell>

  <ConfirmDialog
    :open="confirmReset"
    title="重置远程访问身份？"
    description="重置后，旧的远程访问链接会立即失效。"
    confirm-text="重置"
    :danger="true"
    @cancel="confirmReset = false"
    @confirm="resetIdentity"
  />
</template>

<style scoped>
.v2-settings-header,
.v2-settings-nav {
  border-color: var(--theme-borderDefault);
}

.v2-settings-header {
  background: var(--theme-appPanel);
}

.v2-settings-nav {
  background: var(--theme-appPanelMuted);
  border-bottom: 1px solid var(--theme-borderDefault);
}

.v2-settings-nav-item {
  color: var(--theme-textMuted);
  transition: background-color 140ms ease, color 140ms ease;
}

.v2-settings-nav-item:hover {
  background: var(--theme-appPanelHover);
  color: var(--theme-textPrimary);
}

.v2-settings-nav-item.is-active {
  background: var(--theme-appPanelActive);
  color: var(--theme-textPrimary);
}

.v2-settings-content {
  background: var(--theme-appPanel);
}

.v2-settings-about {
  border-top: 1px solid var(--theme-borderMuted);
  border-bottom: 1px solid var(--theme-borderMuted);
}

.relay-status { color: var(--theme-textMuted); }
.relay-status span { background: var(--theme-textMuted); }
.relay-status.is-connected { color: var(--theme-successText); }
.relay-status.is-connected span { background: var(--theme-successText); }
.relay-toggle { border-bottom: 1px solid var(--theme-borderMuted); }
.relay-input,
.relay-link,
.relay-qr { background: var(--theme-appPanelInset); color: var(--theme-textPrimary); }
.relay-input { border: 1px solid var(--theme-borderMuted); outline: none; }
.relay-input:focus { border-color: var(--theme-borderStrong); }
.relay-qr { image-rendering: auto; }
.relay-error { background: var(--theme-dangerSoft); color: var(--theme-dangerText); }

@media (min-width: 640px) {
  .v2-settings-nav {
    border-right: 1px solid var(--theme-borderDefault);
    border-bottom: 0;
  }
}

@media (max-width: 639px) {
  .v2-settings-panel {
    border: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .v2-settings-nav-item {
    transition: none;
  }
}
</style>
