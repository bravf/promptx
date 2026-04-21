<script setup>
import { computed, ref, watch } from 'vue'
import { Download, FileImage, FileText, Music4, Video } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import ImagePreviewOverlay from './ImagePreviewOverlay.vue'

const props = defineProps({
  getFileBlobUrl: {
    type: Function,
    default: () => '',
  },
  selectedFile: {
    type: Object,
    default: null,
  },
})

const { t } = useI18n()
const previewImageUrl = ref('')
const sideLoadError = ref({
  before: false,
  after: false,
})

function formatSize(size = 0) {
  const value = Math.max(0, Number(size) || 0)
  if (value < 1024) {
    return `${value} B`
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(value < 10 * 1024 ? 1 : 0)} KB`
  }
  return `${(value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

function resolveSideMeta(side = 'after') {
  return props.selectedFile?.binaryPreview?.[side] || {
    exists: false,
    size: 0,
    hashShort: '',
    mimeType: '',
    previewKind: 'binary',
    tooLarge: false,
  }
}

function getSideUrl(side = 'after') {
  if (!props.selectedFile) {
    return ''
  }
  return props.getFileBlobUrl(props.selectedFile, side)
}

function getPreviewIcon(kind = 'binary') {
  if (kind === 'image') {
    return FileImage
  }
  if (kind === 'audio') {
    return Music4
  }
  if (kind === 'video') {
    return Video
  }
  if (kind === 'pdf') {
    return FileText
  }
  return FileImage
}

const previewKind = computed(() => String(props.selectedFile?.binaryPreview?.kind || 'binary'))
const beforeMeta = computed(() => resolveSideMeta('before'))
const afterMeta = computed(() => resolveSideMeta('after'))
const beforeUrl = computed(() => getSideUrl('before'))
const afterUrl = computed(() => getSideUrl('after'))
const previewTitle = computed(() => String(props.selectedFile?.path || '').trim())
const canShowSplitPreview = computed(() => ['image', 'audio', 'video', 'pdf'].includes(previewKind.value))
const previewImageUrls = computed(() => {
  if (previewKind.value !== 'image') {
    return []
  }

  return [
    beforeMeta.value.exists && !beforeMeta.value.tooLarge && !sideLoadError.value.before ? beforeUrl.value : '',
    afterMeta.value.exists && !afterMeta.value.tooLarge && !sideLoadError.value.after ? afterUrl.value : '',
  ].filter(Boolean)
})

function canRenderSide(sideMeta) {
  return sideMeta?.exists && !sideMeta?.tooLarge
}

function markSideLoadError(side = 'before') {
  sideLoadError.value = {
    ...sideLoadError.value,
    [side]: true,
  }
}

function openImagePreview(url = '') {
  const normalizedUrl = String(url || '').trim()
  if (!normalizedUrl) {
    return
  }
  previewImageUrl.value = normalizedUrl
}

watch(
  () => [
    String(props.selectedFile?.path || '').trim(),
    String(beforeUrl.value || '').trim(),
    String(afterUrl.value || '').trim(),
    String(props.selectedFile?.binaryPreview?.before?.hash || '').trim(),
    String(props.selectedFile?.binaryPreview?.after?.hash || '').trim(),
  ].join('\n'),
  () => {
    previewImageUrl.value = ''
    sideLoadError.value = {
      before: false,
      after: false,
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="flex h-full min-h-0 flex-col overflow-hidden">
    <div class="theme-divider theme-secondary-text border-b px-4 py-3 text-[12px]">
      <div class="flex flex-wrap items-center gap-2">
        <span class="font-medium text-[var(--theme-textPrimary)]">{{ previewTitle }}</span>
        <span class="theme-muted-text">{{ t('diffReview.binaryPreviewTitle') }}</span>
      </div>
    </div>

    <div class="min-h-0 flex-1 overflow-auto p-4">
      <div
        v-if="canShowSplitPreview"
        class="grid min-h-full gap-4 md:grid-cols-2"
      >
        <section class="theme-inline-panel flex min-h-[20rem] flex-col rounded-sm border p-3">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('diffReview.binaryBefore') }}</p>
              <p class="theme-muted-text mt-1 text-[11px]">
                {{ beforeMeta.exists ? `${formatSize(beforeMeta.size)} · ${beforeMeta.hashShort || '-'}` : t('diffReview.binarySideMissing') }}
              </p>
            </div>
            <a
              v-if="canRenderSide(beforeMeta)"
              class="theme-icon-button h-8 w-8"
              :href="beforeUrl"
              :download="selectedFile?.path || 'before.bin'"
              :title="t('diffReview.downloadBinarySide')"
            >
              <Download class="h-4 w-4" />
            </a>
          </div>

          <div v-if="!beforeMeta.exists" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binarySideMissing') }}
          </div>
          <div v-else-if="beforeMeta.tooLarge" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binaryPreviewTooLarge') }}
          </div>
          <div v-else-if="sideLoadError.before" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binaryPreviewUnavailable') }}
          </div>
          <button
            v-else-if="previewKind === 'image'"
            type="button"
            class="task-diff-binary-image-wrap flex min-h-[16rem] flex-1 cursor-zoom-in items-center justify-center rounded-sm border p-3"
            :title="t('diffReview.openImagePreview')"
            @click="openImagePreview(beforeUrl)"
          >
            <img :src="beforeUrl" :alt="`${previewTitle} before`" class="max-h-full max-w-full object-contain" @error="markSideLoadError('before')">
          </button>
          <audio v-else-if="previewKind === 'audio'" class="w-full" :src="beforeUrl" controls preload="metadata" @error="markSideLoadError('before')" />
          <video v-else-if="previewKind === 'video'" class="max-h-[26rem] w-full rounded-sm border bg-black" :src="beforeUrl" controls preload="metadata" @error="markSideLoadError('before')" />
          <iframe v-else-if="previewKind === 'pdf'" class="min-h-[26rem] w-full rounded-sm border bg-white" :src="beforeUrl" :title="`${previewTitle} before`" @error="markSideLoadError('before')" />
        </section>

        <section class="theme-inline-panel flex min-h-[20rem] flex-col rounded-sm border p-3">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div class="min-w-0">
              <p class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('diffReview.binaryAfter') }}</p>
              <p class="theme-muted-text mt-1 text-[11px]">
                {{ afterMeta.exists ? `${formatSize(afterMeta.size)} · ${afterMeta.hashShort || '-'}` : t('diffReview.binarySideMissing') }}
              </p>
            </div>
            <a
              v-if="canRenderSide(afterMeta)"
              class="theme-icon-button h-8 w-8"
              :href="afterUrl"
              :download="selectedFile?.path || 'after.bin'"
              :title="t('diffReview.downloadBinarySide')"
            >
              <Download class="h-4 w-4" />
            </a>
          </div>

          <div v-if="!afterMeta.exists" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binarySideMissing') }}
          </div>
          <div v-else-if="afterMeta.tooLarge" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binaryPreviewTooLarge') }}
          </div>
          <div v-else-if="sideLoadError.after" class="theme-empty-state flex min-h-[16rem] flex-1 items-center justify-center text-[12px]">
            {{ t('diffReview.binaryPreviewUnavailable') }}
          </div>
          <button
            v-else-if="previewKind === 'image'"
            type="button"
            class="task-diff-binary-image-wrap flex min-h-[16rem] flex-1 cursor-zoom-in items-center justify-center rounded-sm border p-3"
            :title="t('diffReview.openImagePreview')"
            @click="openImagePreview(afterUrl)"
          >
            <img :src="afterUrl" :alt="`${previewTitle} after`" class="max-h-full max-w-full object-contain" @error="markSideLoadError('after')">
          </button>
          <audio v-else-if="previewKind === 'audio'" class="w-full" :src="afterUrl" controls preload="metadata" @error="markSideLoadError('after')" />
          <video v-else-if="previewKind === 'video'" class="max-h-[26rem] w-full rounded-sm border bg-black" :src="afterUrl" controls preload="metadata" @error="markSideLoadError('after')" />
          <iframe v-else-if="previewKind === 'pdf'" class="min-h-[26rem] w-full rounded-sm border bg-white" :src="afterUrl" :title="`${previewTitle} after`" @error="markSideLoadError('after')" />
        </section>
      </div>

      <div v-else class="theme-inline-panel flex min-h-full flex-col rounded-sm border p-4">
        <div class="flex items-center gap-2">
          <component :is="getPreviewIcon(previewKind)" class="h-5 w-5 text-[var(--theme-textSecondary)]" />
          <span class="text-sm font-medium text-[var(--theme-textPrimary)]">{{ t('diffReview.binaryMetaTitle') }}</span>
        </div>

        <div class="mt-4 grid gap-3 md:grid-cols-2">
          <div class="rounded-sm border border-dashed px-3 py-3">
            <div class="text-xs font-medium text-[var(--theme-textPrimary)]">{{ t('diffReview.binaryBefore') }}</div>
            <div class="theme-muted-text mt-2 space-y-1 text-[12px]">
              <p>{{ beforeMeta.exists ? `${formatSize(beforeMeta.size)} · ${beforeMeta.hashShort || '-'}` : t('diffReview.binarySideMissing') }}</p>
              <p v-if="beforeMeta.mimeType">{{ beforeMeta.mimeType }}</p>
            </div>
            <a
              v-if="canRenderSide(beforeMeta)"
              class="tool-button mt-3 inline-flex items-center gap-2 px-3 py-2 text-xs"
              :href="beforeUrl"
              :download="selectedFile?.path || 'before.bin'"
            >
              <Download class="h-3.5 w-3.5" />
              <span>{{ t('diffReview.downloadBinarySide') }}</span>
            </a>
          </div>

          <div class="rounded-sm border border-dashed px-3 py-3">
            <div class="text-xs font-medium text-[var(--theme-textPrimary)]">{{ t('diffReview.binaryAfter') }}</div>
            <div class="theme-muted-text mt-2 space-y-1 text-[12px]">
              <p>{{ afterMeta.exists ? `${formatSize(afterMeta.size)} · ${afterMeta.hashShort || '-'}` : t('diffReview.binarySideMissing') }}</p>
              <p v-if="afterMeta.mimeType">{{ afterMeta.mimeType }}</p>
            </div>
            <a
              v-if="canRenderSide(afterMeta)"
              class="tool-button mt-3 inline-flex items-center gap-2 px-3 py-2 text-xs"
              :href="afterUrl"
              :download="selectedFile?.path || 'after.bin'"
            >
              <Download class="h-3.5 w-3.5" />
              <span>{{ t('diffReview.downloadBinarySide') }}</span>
            </a>
          </div>
        </div>
      </div>
    </div>

    <ImagePreviewOverlay
      v-model="previewImageUrl"
      :images="previewImageUrls"
    />
  </div>
</template>

<style scoped>
.task-diff-binary-image-wrap {
  background:
    linear-gradient(45deg, color-mix(in srgb, var(--theme-borderMuted) 60%, transparent) 25%, transparent 25%),
    linear-gradient(-45deg, color-mix(in srgb, var(--theme-borderMuted) 60%, transparent) 25%, transparent 25%),
    linear-gradient(45deg, transparent 75%, color-mix(in srgb, var(--theme-borderMuted) 60%, transparent) 75%),
    linear-gradient(-45deg, transparent 75%, color-mix(in srgb, var(--theme-borderMuted) 60%, transparent) 75%);
  background-color: var(--theme-panel);
  background-position: 0 0, 0 8px, 8px -8px, -8px 0;
  background-size: 16px 16px;
}
</style>
