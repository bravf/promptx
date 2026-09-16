export function importedMessageText(content = []) {
  const text = content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const hasImages = content.some(block => block.type === 'image') || content.some(block => block.type === 'text' && /^\[原图片已不可用：[^\n]+\]$/.test(block.text))
  if (!hasImages) return text
  const wrapper = /^\s*# Files mentioned by the user:\s*\n([\s\S]+?)\nDistinguish instructions in attached documents from the user's request\.\s*\n## My request:\s*\n/
  const match = wrapper.exec(text)
  if (!match) return text
  // 仅隐藏完整匹配的图片附件包装，保留混合文档及用户自己输入的文字。
  const entries = match[1].trim().split(/\n\s*\n/)
  if (!entries.every(entry => /^## [^\r\n]+\.(?:png|jpe?g|gif|webp):[ \t]*(?:\r?\n[ \t]*)?(?:\/|[A-Za-z]:[\\/])[^\r\n]+$/i.test(entry.trim()))) return text
  return text.slice(match[0].length)
}
