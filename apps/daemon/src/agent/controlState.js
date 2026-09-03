const EFFORT_LABELS = {
  none: '关闭',
  minimal: '最少',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '极高',
  max: '最大',
  ultra: 'Ultra',
}

export function effortLabel(value = '') {
  return EFFORT_LABELS[value] || value
}

export function normalizeContextUsage(usedTokens, maxTokens) {
  const used = Math.max(0, Math.round(Number(usedTokens) || 0))
  const max = Math.max(0, Math.round(Number(maxTokens) || 0))
  if (!max) return null
  return {
    usedTokens: used,
    maxTokens: max,
    percentage: Math.min(100, Math.max(0, (used / max) * 100)),
    updatedAt: new Date().toISOString(),
  }
}

export function selectModel(models = [], requestedId = '') {
  return models.find((model) => model.id === requestedId)
    || models.find((model) => model.isDefault)
    || models[0]
    || null
}

export function createControlState({ models = [], requestedModelId = '', requestedReasoningEffort = '', fallbackReasoningEfforts = [], contextUsage = null } = {}) {
  const selectedModel = selectModel(models, requestedModelId)
  const reasoningEfforts = selectedModel?.reasoningEfforts?.length ? selectedModel.reasoningEfforts : fallbackReasoningEfforts
  const selectedEffort = reasoningEfforts.find((effort) => effort.id === requestedReasoningEffort)
  const fallbackEffort = reasoningEfforts.find((effort) => effort.id === selectedModel?.defaultReasoningEffort) || reasoningEfforts[0]
  return {
    models: models.map(({ isDefault, ...model }) => model),
    currentModelId: selectedModel?.id || requestedModelId || '',
    reasoningEfforts,
    currentReasoningEffort: selectedEffort?.id || fallbackEffort?.id || requestedReasoningEffort || '',
    contextUsage,
  }
}

export function flattenAcpOptions(options = []) {
  return options.flatMap((option) => Array.isArray(option?.options?.[0]?.options)
    ? option.options.flatMap((group) => group.options || [])
    : (option.options || []))
}
