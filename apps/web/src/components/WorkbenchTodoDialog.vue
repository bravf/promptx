<script setup>
import { computed } from 'vue'
import { ArrowUpLeft, Clock3, FileText, Image as ImageIcon, List, Trash2 } from 'lucide-vue-next'
import DialogShell from './DialogShell.vue'
import { useI18n } from '../composables/useI18n.js'

const props = defineProps({
  items: {
    type: Array,
    default: () => [],
  },
  open: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['close', 'delete', 'use'])
const { t } = useI18n()

const formattedItems = computed(() => (
  (props.items || []).map((item) => {
    const blocks = Array.isArray(item?.blocks) ? item.blocks : []
    const textPreview = blocks
      .find((block) => ['text', 'imported_text'].includes(String(block?.type || '')) && String(block?.content || '').trim())
      ?.content || ''
    const preview = String(textPreview || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    const imageCount = blocks.filter((block) => String(block?.type || '') === 'image').length
    const importedCount = blocks.filter((block) => String(block?.type || '') === 'imported_text').length
    const textCount = blocks.filter((block) => String(block?.type || '') === 'text' && String(block?.content || '').trim()).length

    return {
      ...item,
      blockCount: blocks.length,
      imageCount,
      importedCount,
      preview: preview || (imageCount ? t('todoDialog.imagePreview', { count: imageCount }) : t('todoDialog.noPreview')),
      textCount,
      timeLabel: formatCreatedAt(item?.createdAt),
    }
  })
))

function formatCreatedAt(value = '') {
  const timestamp = Date.parse(String(value || ''))
  if (!timestamp) {
    return t('todoDialog.justAdded')
  }

  try {
    return new Intl.DateTimeFormat(undefined, {
      month: 'numeric',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(timestamp))
  } catch {
    return String(value || '')
  }
}

</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="2"
    panel-class="settings-dialog-panel h-[calc(100dvh-1rem)] max-w-3xl sm:h-[96vh] sm:max-h-[96vh]"
    header-class="px-5 py-4"
    body-class="min-h-0 flex flex-1 flex-col overflow-hidden"
    @close="emit('close')"
  >
    <template #title>
      <div class="min-w-0">
        <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
          <List class="h-4 w-4" />
          <span>{{ t('todoDialog.title') }}</span>
        </div>
        <p class="theme-muted-text mt-1 text-xs leading-5">
          {{ t('todoDialog.intro') }}
        </p>
      </div>
    </template>

    <div class="theme-divider flex items-center justify-between gap-3 border-b border-dashed px-5 py-3 text-xs">
      <span class="theme-muted-text">{{ t('todoDialog.summary', { count: formattedItems.length }) }}</span>
      <span class="theme-status-neutral inline-flex items-center rounded-sm border border-dashed px-2 py-1">
        {{ t('todoDialog.summaryHint') }}
      </span>
    </div>

    <div v-if="formattedItems.length" class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <div class="space-y-3">
            <article
              v-for="item in formattedItems"
              :key="item.id"
              class="theme-card-idle-muted rounded-sm border border-dashed p-4"
            >
              <div class="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                <div class="min-w-0 flex-1">
                  <div class="theme-heading flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span>{{ t('todoDialog.itemTitle') }}</span>
                    <span class="theme-status-neutral inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-0.5 text-[11px]">
                      <Clock3 class="h-3.5 w-3.5" />
                      {{ item.timeLabel }}
                    </span>
                  </div>
                  <p class="mt-2 whitespace-pre-wrap break-words text-sm leading-6">
                    {{ item.preview }}
                  </p>
                  <div class="theme-muted-text mt-3 flex flex-wrap items-center gap-2 text-[11px]">
                    <span class="rounded-sm border border-dashed px-2 py-1">
                      {{ t('todoDialog.blockCount', { count: item.blockCount }) }}
                    </span>
                    <span
                      v-if="item.textCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <FileText class="h-3.5 w-3.5" />
                      {{ t('todoDialog.textCount', { count: item.textCount }) }}
                    </span>
                    <span
                      v-if="item.importedCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <FileText class="h-3.5 w-3.5" />
                      {{ t('todoDialog.importedCount', { count: item.importedCount }) }}
                    </span>
                    <span
                      v-if="item.imageCount"
                      class="inline-flex items-center gap-1 rounded-sm border border-dashed px-2 py-1"
                    >
                      <ImageIcon class="h-3.5 w-3.5" />
                      {{ t('todoDialog.imageCount', { count: item.imageCount }) }}
                    </span>
                  </div>
                </div>

                <div class="flex w-full items-center gap-2 sm:w-auto sm:shrink-0">
                  <button
                    type="button"
                    class="tool-button inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs sm:flex-none"
                    @click="emit('use', item.id)"
                  >
                    <ArrowUpLeft class="h-4 w-4" />
                    <span>{{ t('todoDialog.use') }}</span>
                  </button>
                  <button
                    type="button"
                    class="tool-button tool-button-danger-subtle inline-flex flex-1 items-center justify-center gap-2 px-3 py-2 text-xs sm:flex-none"
                    @click="emit('delete', item.id)"
                  >
                    <Trash2 class="h-4 w-4" />
                    <span>{{ t('todoDialog.delete') }}</span>
                  </button>
                </div>
              </div>
            </article>
          </div>
    </div>

    <div v-else class="theme-empty-state flex min-h-0 flex-1 items-center justify-center px-6 py-10 text-sm">
      {{ t('todoDialog.empty') }}
    </div>
  </DialogShell>
</template>
