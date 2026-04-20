<script setup>
import { Blocks, CircleAlert, Clock3, GripVertical, PencilLine, Plus, Settings2, Trash2 } from 'lucide-vue-next'
import { ref, watch } from 'vue'
import { VueDraggable } from 'vue-draggable-plus'
import { formatDateTime, useI18n } from '../composables/useI18n.js'

const props = defineProps({
  loadingTasks: {
    type: Boolean,
    default: false,
  },
  tasks: {
    type: Array,
    default: () => [],
  },
  currentTaskSlug: {
    type: String,
    default: '',
  },
  editingTaskTitleSlug: {
    type: String,
    default: '',
  },
  draftTitle: {
    type: String,
    default: '',
  },
  currentTaskAutoTitle: {
    type: String,
    default: '',
  },
  creatingTask: {
    type: Boolean,
    default: false,
  },
  loadingTask: {
    type: Boolean,
    default: false,
  },
  uploading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: String,
    default: '',
  },
  removingTask: {
    type: Boolean,
    default: false,
  },
  isCurrentTaskSending: {
    type: Boolean,
    default: false,
  },
  mobile: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits([
  'open-settings',
  'create-task',
  'reorder-task',
  'select-task',
  'title-click',
  'title-blur',
  'cancel-title-edit',
  'update:draftTitle',
  'edit-task',
  'delete-task',
])

const { t } = useI18n()
const localTasks = ref([])

watch(
  () => props.tasks,
  (tasks) => {
    localTasks.value = Array.isArray(tasks) ? [...tasks] : []
  },
  { immediate: true }
)

function getTaskCardClass(task) {
  if (task.slug === props.currentTaskSlug) {
    return 'workbench-task-card--active theme-card-selected'
  }

  if (task.sending) {
    return 'workbench-task-card--running theme-card-warning'
  }

  return 'theme-card-idle-muted'
}

function getTaskRunningBadgeClass() {
  return 'theme-status-warning'
}

function formatTaskUpdatedAt(task) {
  const value = new Date(task.updatedAt)
  if (Number.isNaN(value.getTime())) {
    return ''
  }

  return formatDateTime(value.toISOString(), {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function shouldShowWorkspaceBadge(task) {
  return Boolean(task?.workspaceDiffSummary?.supported && task?.workspaceDiffSummary?.fileCount)
}

function getTaskWorkspaceBadgeClass(task) {
  return task.slug === props.currentTaskSlug
    ? 'theme-badge-strong'
    : 'theme-badge-muted'
}

function handleDragEnd(event) {
  if (props.mobile) {
    return
  }

  const oldIndex = Number(event?.oldIndex)
  const newIndex = Number(event?.newIndex)
  if (!Number.isInteger(oldIndex) || !Number.isInteger(newIndex) || oldIndex === newIndex) {
    return
  }

  emit('reorder-task', localTasks.value.map((task) => String(task?.slug || '').trim()).filter(Boolean))
}

</script>

<template>
  <aside class="workbench-sidebar-panel panel flex h-full min-h-0 flex-col overflow-hidden">
    <div class="workbench-panel-header theme-divider border-b px-4 py-4">
      <div class="flex items-center justify-between gap-3">
        <div class="flex min-h-8 items-center">
          <div class="theme-heading inline-flex items-center gap-2 text-sm font-medium">
            <Blocks class="h-4 w-4" />
            <span>{{ t('workbench.title') }}</span>
          </div>
        </div>
        <button
          type="button"
          class="tool-button inline-flex items-center gap-2 whitespace-nowrap px-3 py-2 text-xs"
          :title="t('workbench.settings')"
          @click="emit('open-settings')"
        >
          <Settings2 class="h-4 w-4" />
          <span :class="mobile ? 'whitespace-nowrap' : 'hidden whitespace-nowrap sm:inline'">{{ t('workbench.settings') }}</span>
        </button>
      </div>
      <button
        type="button"
        class="tool-button tool-button-primary mt-4 inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
        :disabled="creatingTask || uploading"
        :title="creatingTask ? t('workbench.creatingTask') : t('workbench.createTask')"
        @click="emit('create-task')"
      >
        <Plus class="h-4 w-4" />
        <span class="whitespace-nowrap">{{ creatingTask ? t('workbench.creatingTask') : t('workbench.createTask') }}</span>
      </button>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto px-3 py-3">
      <div v-if="loadingTasks && !tasks.length" class="theme-empty-state px-3 py-4 text-sm">
        {{ t('workbench.loadingTasks') }}
      </div>

      <VueDraggable
        v-else
        v-model="localTasks"
        class="space-y-2"
        :animation="180"
        :disabled="mobile || tasks.length <= 1"
        handle=".task-drag-handle"
        ghost-class="workbench-task-card--ghost"
        chosen-class="workbench-task-card--chosen"
        drag-class="workbench-task-card--dragging"
        fallback-tolerance="6"
        @end="handleDragEnd"
      >
        <article
          v-for="task in localTasks"
          :key="task.slug"
          class="workbench-task-card group relative cursor-default rounded-sm border px-3 py-3 transition"
          :class="getTaskCardClass(task)"
          @click="emit('select-task', task.slug)"
        >
          <span
            v-if="task.slug === currentTaskSlug"
            class="theme-selection-indicator absolute inset-y-2 left-0 w-1 rounded-full"
          />
          <span
            v-if="task.hasUnreadUpdate"
            class="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-[var(--theme-danger)] shadow-[0_0_0_2px_var(--theme-appPanel)]"
            aria-hidden="true"
          />
          <div class="flex items-start justify-between gap-3">
            <div class="flex min-w-0 flex-1 items-start gap-2 overflow-hidden">
              <button
                v-if="!mobile"
                type="button"
                class="task-drag-handle mt-0.5 inline-flex h-4 w-4 shrink-0 cursor-grab items-center justify-center rounded-sm opacity-45 transition hover:opacity-80 active:cursor-grabbing"
                :title="t('workbench.dragToReorder')"
                :aria-label="t('workbench.dragToReorder')"
                tabindex="-1"
                @click.stop
              >
                <GripVertical class="h-3.5 w-3.5" />
              </button>
              <div class="min-w-0 h-5 flex-1 overflow-hidden">
              <input
                v-if="task.slug === currentTaskSlug && editingTaskTitleSlug === task.slug"
                :value="draftTitle"
                type="text"
                maxlength="140"
                data-task-title-input="current"
                class="block h-5 min-h-0 w-full appearance-none border-0 bg-transparent p-0 text-left text-sm font-semibold leading-5 outline-none placeholder:text-[var(--theme-textMuted)]"
                :placeholder="currentTaskAutoTitle || t('workbench.untitledTask')"
                @click.stop
                @input="emit('update:draftTitle', $event.target.value)"
                @keydown.enter.prevent="$event.target.blur()"
                @keydown.esc.prevent="emit('cancel-title-edit')"
                @blur="emit('title-blur')"
              >
              <button
                v-else
                type="button"
                class="inline-flex h-5 w-full items-center gap-1.5 truncate bg-transparent p-0 text-left text-sm leading-5"
                :class="task.slug === currentTaskSlug ? 'font-semibold' : 'font-medium'"
                :title="task.displayTitle"
                @click.stop="emit('title-click', task.slug)"
              >
                <Clock3
                  v-if="task.automation?.enabled"
                  class="h-3.5 w-3.5 shrink-0 opacity-70"
                />
                <span class="min-w-0 truncate">{{ task.displayTitle }}</span>
              </button>
              </div>
            </div>
            <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
              <span
                v-if="task.sending"
                class="inline-flex items-center gap-1.5 rounded-sm border border-dashed px-1.5 py-0.5"
                :class="getTaskRunningBadgeClass()"
              >
                <span class="task-loading-dots" aria-hidden="true">
                  <span class="task-loading-dots__dot"></span>
                  <span class="task-loading-dots__dot"></span>
                  <span class="task-loading-dots__dot"></span>
                </span>
                <span>{{ t('workbench.running') }}</span>
              </span>
            </div>
          </div>
          <div class="workbench-task-card__preview mt-2 truncate text-xs opacity-80">{{ task.lastPromptPreview || t('workbench.noMessagesYet') }}</div>
          <div class="mt-2 flex items-center justify-between gap-3">
            <div class="min-w-0 text-[11px] opacity-70">{{ formatTaskUpdatedAt(task) }}</div>
            <div class="flex shrink-0 items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] opacity-80">
              <span
                v-if="shouldShowWorkspaceBadge(task)"
                class="inline-flex items-center gap-1 rounded-sm border border-dashed px-1.5 py-0.5"
                :class="getTaskWorkspaceBadgeClass(task)"
              >
                <span>{{ t('workbench.filesCount', { count: task.workspaceDiffSummary?.fileCount || 0 }) }}</span>
              </span>
            </div>
          </div>
        </article>
      </VueDraggable>
    </div>

    <div class="theme-divider border-t px-3 py-3">
      <div v-if="error" class="theme-danger-text mb-3 inline-flex min-w-0 items-start gap-2 text-xs">
        <CircleAlert class="mt-0.5 h-4 w-4 shrink-0" />
        <span class="min-w-0 break-words">{{ error }}</span>
      </div>
      <div class="grid grid-cols-2 gap-2">
        <button
          type="button"
          class="tool-button inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          :disabled="!currentTaskSlug || removingTask || creatingTask"
          :title="t('workbench.editTask')"
          @click="emit('edit-task')"
        >
          <PencilLine class="h-4 w-4" />
          <span class="whitespace-nowrap">{{ t('workbench.editTask') }}</span>
        </button>
        <button
          type="button"
          class="tool-button tool-button-danger-subtle inline-flex w-full items-center justify-center gap-2 whitespace-nowrap px-3 py-2 text-sm"
          :disabled="!currentTaskSlug || removingTask || creatingTask || isCurrentTaskSending"
          :title="removingTask ? t('workbench.deletingTask') : t('workbench.deleteTask')"
          @click="emit('delete-task')"
        >
          <Trash2 class="h-4 w-4" />
          <span class="whitespace-nowrap">{{ removingTask ? t('workbench.deletingTask') : t('workbench.deleteTask') }}</span>
        </button>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.workbench-task-card--ghost {
  opacity: 0.38;
}

.workbench-task-card--chosen {
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--theme-accent) 28%, transparent 72%),
    0 10px 28px color-mix(in srgb, var(--theme-accent) 12%, transparent 88%);
}

.workbench-task-card--dragging {
  opacity: 0.96;
  transform: rotate(1deg);
}
</style>
