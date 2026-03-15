<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Check,
  ChevronDown,
  LoaderCircle,
} from 'lucide-vue-next'

const props = defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  sessions: {
    type: Array,
    default: () => [],
  },
  loading: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue', 'refresh-intent'])

const rootRef = ref(null)
const panelRef = ref(null)
const open = ref(false)
const openUpward = ref(false)
const panelStyle = ref({})

const selectedSession = computed(() => props.sessions.find((session) => session.id === props.modelValue) || null)

function getSessionTitle(session) {
  return session?.title || '未命名会话'
}

function getSessionCwd(session) {
  return session?.cwd || '未设置路径'
}

function getRuntimeStatusLabel(session) {
  return session?.running ? '执行中' : '空闲'
}

function getRuntimeStatusClass(session) {
  return session?.running
    ? 'border-amber-300 bg-amber-50 text-amber-700 dark:border-[#7f6949] dark:bg-[#392f20] dark:text-[#e5ce9a]'
    : 'border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-[#5b7562] dark:bg-[#243228] dark:text-[#deecdf]'
}

function openDropdown() {
  if (props.disabled) {
    return
  }

  if (!open.value) {
    emit('refresh-intent')
  }
  open.value = true
}

function closeDropdown() {
  open.value = false
}

function toggleDropdown() {
  if (open.value) {
    closeDropdown()
    return
  }
  openDropdown()
}

function selectSession(sessionId) {
  emit('update:modelValue', String(sessionId || '').trim())
  closeDropdown()
}

function updatePanelPosition() {
  if (!open.value || !rootRef.value || typeof window === 'undefined') {
    return
  }

  const rect = rootRef.value.getBoundingClientRect()
  const viewportWidth = window.innerWidth
  const viewportHeight = window.innerHeight
  const gap = 8
  const edgePadding = 8
  const minPanelHeight = 160
  const preferredPanelHeight = 360
  const spaceBelow = Math.max(0, viewportHeight - rect.bottom - edgePadding)
  const spaceAbove = Math.max(0, rect.top - edgePadding)

  openUpward.value = spaceBelow < 260 && spaceAbove > spaceBelow

  const availableHeight = openUpward.value ? spaceAbove - gap : spaceBelow - gap
  const maxHeight = Math.max(
    Math.min(preferredPanelHeight, Math.max(availableHeight, 0)),
    Math.min(minPanelHeight, openUpward.value ? spaceAbove : spaceBelow)
  )

  const width = Math.min(rect.width, viewportWidth - edgePadding * 2)
  const left = Math.min(
    Math.max(edgePadding, rect.left),
    Math.max(edgePadding, viewportWidth - edgePadding - width)
  )

  panelStyle.value = {
    left: `${left}px`,
    top: openUpward.value ? `${rect.top - gap}px` : `${rect.bottom + gap}px`,
    width: `${width}px`,
    maxHeight: `${Math.max(maxHeight, 120)}px`,
    transform: openUpward.value ? 'translateY(-100%)' : 'none',
  }
}

function handleDocumentPointerDown(event) {
  if (!open.value || !rootRef.value) {
    return
  }

  if (rootRef.value.contains(event.target) || panelRef.value?.contains(event.target)) {
    return
  }

  if (!rootRef.value.contains(event.target)) {
    closeDropdown()
  }
}

function handleDocumentKeydown(event) {
  if (event.key === 'Escape') {
    closeDropdown()
  }
}

watch(
  () => props.disabled,
  (disabled) => {
    if (disabled) {
      closeDropdown()
    }
  }
)

watch(open, async (value) => {
  if (!value) {
    return
  }

  await nextTick()
  updatePanelPosition()
})

onMounted(() => {
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('keydown', handleDocumentKeydown)
  window.addEventListener('resize', updatePanelPosition)
  window.addEventListener('scroll', updatePanelPosition, true)
})

onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('keydown', handleDocumentKeydown)
  window.removeEventListener('resize', updatePanelPosition)
  window.removeEventListener('scroll', updatePanelPosition, true)
})
</script>

<template>
  <div ref="rootRef" class="relative min-w-0">
    <button
      type="button"
      class="flex w-full items-center gap-3 rounded-sm border border-stone-300 bg-white px-3 py-2 text-left transition hover:border-stone-500 focus:border-stone-500 focus:outline-none dark:border-[#544941] dark:bg-[#211c19] dark:hover:border-[#73665c] dark:focus:border-stone-400"
      :class="disabled ? 'cursor-not-allowed opacity-60' : ''"
      :disabled="disabled"
      @click="toggleDropdown"
      @keydown.down.prevent="openDropdown"
      @keydown.enter.prevent="toggleDropdown"
      @keydown.space.prevent="toggleDropdown"
    >
      <div class="min-w-0 flex-1">
        <template v-if="selectedSession">
          <div class="flex items-center gap-2 text-sm">
            <span class="min-w-0 flex-1 truncate font-medium text-stone-900 dark:text-stone-100">
              {{ getSessionTitle(selectedSession) }} - {{ getSessionCwd(selectedSession) }}
            </span>
            <span class="inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getRuntimeStatusClass(selectedSession)">
              {{ getRuntimeStatusLabel(selectedSession) }}
            </span>
          </div>
        </template>
        <template v-else>
          <div class="text-sm text-stone-500 dark:text-stone-400">
            {{ loading ? '正在同步会话...' : '请选择 PromptX 会话' }}
          </div>
        </template>
      </div>

      <div class="flex shrink-0 items-center gap-2 text-stone-400 dark:text-stone-500">
        <LoaderCircle v-if="loading" class="h-4 w-4 animate-spin" />
        <ChevronDown class="h-4 w-4 transition" :class="open ? 'rotate-180' : ''" />
      </div>
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="panelRef"
        class="fixed z-30 flex overflow-hidden rounded-sm border border-stone-300 bg-white shadow-sm dark:border-[#544941] dark:bg-[#28231f]"
        :style="panelStyle"
      >
        <div class="flex min-h-0 w-full flex-col">
          <div class="flex items-center justify-between gap-3 border-b border-dashed border-stone-300 px-3 py-2 text-[11px] text-stone-500 dark:border-[#544941] dark:text-stone-400">
            <span>{{ loading ? '正在同步最新会话...' : `共 ${sessions.length} 个会话` }}</span>
            <LoaderCircle v-if="loading" class="h-3.5 w-3.5 animate-spin" />
          </div>

          <div class="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
            <button
              v-for="session in sessions"
              :key="session.id"
              type="button"
              class="w-full rounded-sm border border-dashed p-3 text-left transition"
              :class="session.id === modelValue
                ? 'border-stone-500 bg-stone-50 dark:border-[#73665c] dark:bg-[#332c27]'
                : 'border-stone-300 bg-white hover:border-stone-500 dark:border-[#453c36] dark:bg-[#26211d] dark:hover:border-[#73665c]'"
              @click="selectSession(session.id)"
            >
              <div class="flex items-start gap-3">
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-2 text-sm">
                    <span class="min-w-0 flex-1 truncate font-medium text-stone-900 dark:text-stone-100">
                      {{ getSessionTitle(session) }} - {{ getSessionCwd(session) }}
                    </span>
                    <span class="inline-flex items-center rounded-sm border border-dashed px-1.5 py-0.5 text-[10px]" :class="getRuntimeStatusClass(session)">
                      {{ getRuntimeStatusLabel(session) }}
                    </span>
                  </div>
                </div>

                <Check
                  v-if="session.id === modelValue"
                  class="mt-0.5 h-4 w-4 shrink-0 text-stone-700 dark:text-stone-200"
                />
              </div>
            </button>

            <div
              v-if="!sessions.length"
              class="rounded-sm border border-dashed border-stone-300 bg-stone-50 px-3 py-4 text-sm text-stone-500 dark:border-[#544941] dark:bg-[#2d2723] dark:text-stone-400"
            >
              还没有会话，请先到管理弹窗里新建。
            </div>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>
