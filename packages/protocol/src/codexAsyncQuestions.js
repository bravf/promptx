import { normalizeInteractionQuestions } from './interactionAnswers.js'

// request_user_input_async 是 AgentMessage 中的结构化数据，不从普通文字推断问题。
export function codexAsyncInteraction(item) {
  if (item?.delivery !== 'async' || !item.id || !item.questions?.length) return null
  return {
    type: 'interaction_request', id: `codex-async:${item.id}`, sourceMessageId: item.id,
    kind: 'question', title: '需要你回答', delivery: 'async', status: 'pending',
    questions: normalizeInteractionQuestions(item.questions.map((question, index) => ({
      id: String(index), header: `问题 ${index + 1}`, question: question.title,
      options: (question.options || []).map(label => ({ label })), isOther: true,
    }))),
  }
}

export function codexAsyncAnswerText(request, answers) {
  const replies = request.questions.map((question, index) => ({
    questionItemId: JSON.stringify(['request_user_input_async', request.sourceMessageId, index]),
    question: question.question,
    answer: answers[question.id].join(', '),
  }))
  return `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`
}
