<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  images: {
    type: Array,
    default: () => [],
  },
})

const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const previewScale = ref(1)

const normalizedImages = computed(() => (
  props.images
    .map((item) => String(item || '').trim())
    .filter(Boolean)
))

const currentPreviewIndex = computed(() => (
  normalizedImages.value.findIndex((item) => item === props.modelValue)
))

const currentPreviewImageUrl = computed(() => (
  currentPreviewIndex.value >= 0 ? normalizedImages.value[currentPreviewIndex.value] : ''
))

function closePreview() {
  emit('update:modelValue', '')
  previewScale.value = 1
}

function setPreviewImage(url) {
  emit('update:modelValue', String(url || '').trim())
  previewScale.value = 1
}

function showPreviousPreview() {
  if (currentPreviewIndex.value <= 0) {
    return
  }

  setPreviewImage(normalizedImages.value[currentPreviewIndex.value - 1])
}

function showNextPreview() {
  if (currentPreviewIndex.value < 0 || currentPreviewIndex.value >= normalizedImages.value.length - 1) {
    return
  }

  setPreviewImage(normalizedImages.value[currentPreviewIndex.value + 1])
}

function adjustPreviewScale(delta) {
  const nextScale = Math.min(3, Math.max(0.5, previewScale.value + delta))
  previewScale.value = Math.round(nextScale * 100) / 100
}

function resetPreviewScale() {
  previewScale.value = 1
}

function handlePreviewWheel(event) {
  if (!currentPreviewImageUrl.value) {
    return
  }

  event.preventDefault()
  adjustPreviewScale(event.deltaY < 0 ? 0.1 : -0.1)
}

function handleWindowKeydown(event) {
  if (!currentPreviewImageUrl.value) {
    return
  }

  event.stopPropagation?.()
  event.stopImmediatePropagation?.()

  if (event.key === 'Escape') {
    event.preventDefault()
    closePreview()
    return
  }

  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    showPreviousPreview()
    return
  }

  if (event.key === 'ArrowRight') {
    event.preventDefault()
    showNextPreview()
    return
  }

  if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    adjustPreviewScale(0.1)
    return
  }

  if (event.key === '-') {
    event.preventDefault()
    adjustPreviewScale(-0.1)
    return
  }

  if (event.key === '0') {
    event.preventDefault()
    resetPreviewScale()
  }
}

watch(
  () => props.modelValue,
  (value) => {
    if (!value) {
      previewScale.value = 1
    }
  }
)

watch(
  normalizedImages,
  (images) => {
    if (!props.modelValue) {
      return
    }

    if (!images.length) {
      closePreview()
      return
    }

    if (!images.includes(props.modelValue)) {
      const fallbackIndex = Math.min(currentPreviewIndex.value, images.length - 1)
      setPreviewImage(images[fallbackIndex] || images[0])
    }
  },
  { immediate: true }
)

onMounted(() => {
  window.addEventListener('keydown', handleWindowKeydown, { capture: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', handleWindowKeydown, { capture: true })
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="currentPreviewImageUrl"
      class="theme-modal-backdrop image-preview-overlay fixed inset-0 z-[120] flex items-center justify-center p-6"
      @click="closePreview"
      @wheel="handlePreviewWheel"
    >
      <div class="absolute left-4 top-4 flex items-center gap-2" @click.stop>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition"
          @click="adjustPreviewScale(-0.1)"
        >
          {{ t('imagePreview.zoomOut') }}
        </button>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition"
          @click="resetPreviewScale"
        >
          {{ Math.round(previewScale * 100) }}%
        </button>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition"
          @click="adjustPreviewScale(0.1)"
        >
          {{ t('imagePreview.zoomIn') }}
        </button>
      </div>
      <div class="absolute right-4 top-4 flex items-center gap-2" @click.stop>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="currentPreviewIndex <= 0"
          @click="showPreviousPreview"
        >
          {{ t('imagePreview.previous') }}
        </button>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition disabled:cursor-not-allowed disabled:opacity-40"
          :disabled="currentPreviewIndex < 0 || currentPreviewIndex >= normalizedImages.length - 1"
          @click="showNextPreview"
        >
          {{ t('imagePreview.next') }}
        </button>
        <button
          type="button"
          class="image-preview-overlay__button rounded-sm border px-3 py-2 text-sm transition"
          @click="closePreview"
        >
          {{ t('imagePreview.close') }}
        </button>
      </div>
      <img
        :src="currentPreviewImageUrl"
        :alt="t('imagePreview.alt')"
        class="image-preview-overlay__image max-h-[90vh] max-w-[90vw] object-contain shadow-2xl transition-transform"
        :style="{ transform: `scale(${previewScale})` }"
        @click.stop
      />
    </div>
  </Teleport>
</template>
