<script setup>
import { computed } from 'vue'
import { FileDiff } from 'lucide-vue-next'
import { useI18n } from '../composables/useI18n.js'
import DialogShell from './DialogShell.vue'
import TaskDiffReviewPanel from './TaskDiffReviewPanel.vue'

const props = defineProps({
  open: {
    type: Boolean,
    default: false,
  },
  reviewComments: {
    type: Array,
    default: () => [],
  },
  taskSlug: {
    type: String,
    default: '',
  },
  taskTitle: {
    type: String,
    default: '',
  },
  preferredScope: {
    type: String,
    default: 'task',
  },
  preferredRunId: {
    type: String,
    default: '',
  },
  focusToken: {
    type: Number,
    default: 0,
  },
})

const emit = defineEmits(['close', 'save-review-comment', 'remove-review-comment'])
const { t } = useI18n()

const titleText = computed(() => {
  const taskTitle = String(props.taskTitle || '').trim()
  return taskTitle ? t('diffReview.dialogTitleWithTask', { title: taskTitle }) : t('diffReview.dialogTitle')
})
</script>

<template>
  <DialogShell
    :open="open"
    :stack-level="2"
    panel-class="settings-dialog-panel h-full sm:h-[90vh] sm:w-[90vw] sm:max-w-[90vw]"
    header-class="settings-dialog-header px-5 py-4"
    body-class="settings-dialog-body min-h-0 flex-1 overflow-hidden p-3 sm:p-4"
    @close="emit('close')"
  >
    <template #title>
      <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
        <FileDiff class="h-4 w-4" />
        <span>{{ titleText }}</span>
      </div>
    </template>

    <TaskDiffReviewPanel
      :review-comments="reviewComments"
      :task-slug="taskSlug"
      :active="open"
      :preferred-scope="preferredScope"
      :preferred-run-id="preferredRunId"
      :focus-token="focusToken"
      @save-review-comment="emit('save-review-comment', $event)"
      @remove-review-comment="emit('remove-review-comment', $event)"
    />
  </DialogShell>
</template>
