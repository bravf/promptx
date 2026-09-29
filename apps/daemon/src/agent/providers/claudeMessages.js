// Claude 的内部占位消息不能当成模型回复，也不能触发自动续跑。
// 必须同时匹配 synthetic 来源和完整占位内容，保留正常回复及合成错误消息。
export function isClaudeNoResponsePlaceholder(entry) {
  const content = entry.message?.content
  return entry.type === 'assistant'
    && entry.message?.model === '<synthetic>'
    && !entry.isApiErrorMessage && !entry.error
    && Array.isArray(content) && content.length > 0
    && content.every(block => block?.type === 'text')
    && content.map(block => block.text || '').join('').trim() === 'No response requested.'
}
