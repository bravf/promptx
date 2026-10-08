// 各 Provider 保留原始输入；统一协议只携带显示问题所需的字段。
export function normalizeInteractionQuestions(questions = [], { allowOther = false } = {}) {
  return questions.map((question, index) => ({
    id: String(question.id || index),
    header: String(question.header || `问题 ${index + 1}`),
    question: String(question.question || ''),
    options: (question.options || []).map((option, optionIndex) => ({
      id: String(optionIndex),
      label: String(option.label || ''),
      ...(option.description ? { description: String(option.description) } : {}),
    })),
    multiSelect: question.multiSelect === true,
    allowOther: allowOther || question.isOther === true || question.allowOther === true || !question.options?.length,
    secret: question.isSecret === true,
  }))
}

export function validateInteractionResponse(request, response) {
  if (response.decision === 'dismiss') return {}
  if (request.kind !== 'question') {
    if (!request.actions.some(action => action.id === response.actionId)) throw new Error('请选择有效的操作。')
    return {}
  }
  const answers = {}
  for (const question of request.questions) {
    const answer = response.answers?.[question.id]
    if (!answer) throw new Error(`请回答：${question.header}`)
    const ids = [...new Set(answer.optionIds)]
    const text = answer.text.trim()
    if (ids.some(id => !question.options.some(option => option.id === id))) throw new Error('选项已失效，请重新选择。')
    if (!question.multiSelect && ids.length > 1) throw new Error('该问题只能选择一个选项。')
    if (text && !question.allowOther) throw new Error('该问题不支持文字回答。')
    if (!ids.length && !text) throw new Error(`请回答：${question.header}`)
    // 补充文字作为“其他”答案，避免同时提交互相矛盾的选择。
    answers[question.id] = text ? [text] : ids.map(id => question.options.find(option => option.id === id).label)
  }
  return answers
}
