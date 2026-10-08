<script setup>
import { computed, reactive, ref } from 'vue'
import { MessageCircleQuestion } from 'lucide-vue-next'
import { validateInteractionResponse } from '../../../../packages/protocol/src/interactionAnswers.js'
import { v2Api } from '../lib/v2Api.js'
import PxButton from './PxButton.vue'
import TimelineMarkdown from './TimelineMarkdown.vue'

const props = defineProps({
  request: { type: Object, required: true },
  taskId: { type: String, default: '' },
  pending: { type: Boolean, default: false },
  ready: { type: Boolean, default: true },
  isDark: { type: Boolean, default: false },
})
const emit = defineEmits(['refresh'])
const answers = reactive(Object.fromEntries(props.request.questions.map(question => [question.id, { optionIds: [], text: '' }])))
const busy = ref(false)
const error = ref('')
const allAnswered = computed(() => {
  try { validateInteractionResponse(props.request, { decision: 'answer', answers }); return true } catch { return false }
})
const statusText = computed(() => ({ answered: '已回答', dismissed: '已取消', expired: '已失效' })[props.request.status] || '等待你回答')

function select(question, id) {
  const answer = answers[question.id]
  answer.text = ''
  answer.optionIds = question.multiSelect
    ? answer.optionIds.includes(id) ? answer.optionIds.filter(value => value !== id) : [...answer.optionIds, id]
    : [id]
}

async function submit(input) {
  if (busy.value || !props.ready) return
  busy.value = true
  error.value = ''
  try {
    await v2Api.respondToInteraction(props.taskId, props.request.id, input)
    emit('refresh')
  } catch (cause) {
    error.value = cause.message
    if (cause.statusCode === 409) emit('refresh')
  } finally { busy.value = false }
}
</script>

<template>
  <section v-if="pending" class="interaction-card panel mb-5 min-w-0 rounded-lg border p-4" :data-request-id="request.id" aria-label="等待你回答">
    <header class="mb-3 flex items-center gap-2 text-sm font-bold"><MessageCircleQuestion class="h-4 w-4 shrink-0" /><span>{{ request.title }}</span><span class="theme-muted-text ml-auto text-xs font-normal">等待你回答</span></header>
    <TimelineMarkdown v-if="request.description" :text="request.description" :is-dark="isDark" :task-id="taskId" />
    <p v-if="request.delivery === 'async'" class="theme-muted-text mb-3 text-xs">Agent 发出了异步问题，提交回答后会继续会话。</p>
    <fieldset v-for="question in request.questions" :key="question.id" :disabled="busy || !ready" class="mb-4 min-w-0">
      <legend class="mb-2 text-sm font-medium whitespace-pre-wrap break-words">{{ question.question }}</legend>
      <p v-if="question.multiSelect" class="theme-muted-text mb-2 text-xs">可多选</p>
      <div class="space-y-2">
        <label v-for="option in question.options" :key="option.id" class="interaction-option flex cursor-pointer items-start gap-2 rounded-sm border p-2.5" :class="{ 'is-selected': answers[question.id].optionIds.includes(option.id) }">
          <input :type="question.multiSelect ? 'checkbox' : 'radio'" :name="`${request.id}-${question.id}`" :checked="answers[question.id].optionIds.includes(option.id)" class="mt-0.5 shrink-0" @change="select(question, option.id)" />
          <span class="min-w-0 text-xs"><span class="block whitespace-pre-wrap break-words font-medium">{{ option.label }}</span><span v-if="option.description" class="theme-muted-text mt-1 block whitespace-pre-wrap break-words">{{ option.description }}</span></span>
        </label>
        <label v-if="question.allowOther" class="block text-xs"><span class="theme-muted-text mb-1 block">{{ question.options.length ? '其他回答' : '你的回答' }}</span>
          <input v-if="question.secret" v-model="answers[question.id].text" type="password" autocomplete="off" class="interaction-text w-full rounded-sm border px-3 py-2" maxlength="8000" :aria-label="question.header" @input="answers[question.id].optionIds = []" />
          <textarea v-else v-model="answers[question.id].text" rows="2" class="interaction-text w-full resize-y rounded-sm border px-3 py-2" maxlength="8000" :aria-label="question.header" @input="answers[question.id].optionIds = []" />
        </label>
      </div>
    </fieldset>
    <p v-if="error" class="mb-3 text-xs text-[var(--theme-dangerText)]" role="alert">{{ error }}</p>
    <p v-if="!ready" class="theme-muted-text mb-3 text-xs">正在确认问题状态…</p>
    <footer class="mt-3 flex flex-wrap gap-2">
      <PxButton v-if="request.kind === 'question'" variant="primary" size="sm" :disabled="!ready || !allAnswered" :loading="busy" @click="submit({ decision: 'answer', answers })">提交回答</PxButton>
      <PxButton v-for="action in request.actions" :key="action.id" variant="primary" size="sm" :disabled="!ready || busy" @click="submit({ decision: 'answer', actionId: action.id })">{{ action.label }}</PxButton>
      <PxButton variant="ghost" size="sm" :disabled="!ready || busy" @click="submit({ decision: 'dismiss' })">取消询问</PxButton>
    </footer>
  </section>
  <details v-else class="interaction-summary theme-muted-text ml-7 rounded-sm border px-3 py-2 text-xs">
    <summary class="cursor-pointer break-words">{{ request.title }} · {{ statusText }}<span v-if="request.selectedAction"> · {{ request.selectedAction }}</span></summary>
    <div class="mt-2 space-y-2">
      <div v-for="question in request.questions" :key="question.id"><p class="whitespace-pre-wrap break-words">{{ question.question }}</p><p v-if="request.answers?.[question.id]" class="mt-1 whitespace-pre-wrap break-words text-[var(--theme-textPrimary)]">{{ request.answers[question.id].join('、') }}</p></div>
      <p v-if="request.message">{{ request.message }}</p>
      <TimelineMarkdown v-if="request.description" :text="request.description" :is-dark="isDark" :task-id="taskId" />
    </div>
  </details>
</template>

<style scoped>
.interaction-card { border-color: var(--theme-primaryBorder); }
.interaction-option { border-color: var(--theme-inputBorder); background: var(--theme-inputBg); }
.interaction-option.is-selected { border-color: var(--theme-primaryBorder); background: var(--theme-accentSoft); }
.interaction-option input { accent-color: var(--theme-primaryBg); }
.interaction-text { background: var(--theme-inputBg); color: var(--theme-textPrimary); border-color: var(--theme-inputBorder); }
.interaction-text:focus { outline: 1px solid var(--theme-primaryBorder); }
</style>
