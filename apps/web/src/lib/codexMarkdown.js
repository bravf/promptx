import MarkdownIt from 'markdown-it'
import { renderHighlightedCodeLines, resolvePreviewLanguage } from './sourceCodePreview.js'
import { workspaceLinkForHref, timelineImageForHref } from './timelineWorkspaceLinks.js'

const markdownUtils = new MarkdownIt()
const FENCE_PLACEHOLDER_PREFIX = '__PROMPTX_FENCE__'
const TRANSPARENT_IMAGE_SRC = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='

function normalizeLanguage(value = '') {
  return String(value || '').trim().toLowerCase()
}

function escapeHtml(value = '') {
  return markdownUtils.utils.escapeHtml(String(value || ''))
}

function getDisplayLanguage(value = '') {
  const normalized = normalizeLanguage(value)

  if (!normalized) {
    return ''
  }

  if (['js', 'javascript'].includes(normalized)) {
    return 'JavaScript'
  }

  if (['jsx', 'react'].includes(normalized)) {
    return 'React'
  }

  if (['ts', 'typescript'].includes(normalized)) {
    return 'TypeScript'
  }

  if (normalized === 'tsx') {
    return 'TSX'
  }

  if (['sh', 'shell', 'zsh', 'bash', 'csh'].includes(normalized)) {
    return 'Bash'
  }

  if (normalized === 'fish') {
    return 'Fish'
  }

  if (['ps1', 'pwsh', 'powershell'].includes(normalized)) {
    return 'PowerShell'
  }

  if (normalized === 'md') {
    return 'Markdown'
  }

  if (normalized === 'html') {
    return 'HTML'
  }

  if (normalized === 'vue') {
    return 'Vue'
  }

  if (normalized === 'svg') {
    return 'SVG'
  }

  if (normalized === 'json') {
    return 'JSON'
  }

  if (normalized === 'sql') {
    return 'SQL'
  }

  if (normalized === 'scss') {
    return 'SCSS'
  }

  if (normalized === 'sass') {
    return 'Sass'
  }

  if (normalized === 'less') {
    return 'Less'
  }

  if (normalized === 'toml') {
    return 'TOML'
  }

  if (normalized === 'ini') {
    return 'INI'
  }

  if (['env', 'dotenv'].includes(normalized)) {
    return '.env'
  }

  if (['cs', 'csharp'].includes(normalized)) {
    return 'C#'
  }

  return normalized.charAt(0).toUpperCase() + normalized.slice(1)
}

function createMarkdownRenderer(options = {}) {
  const instance = new MarkdownIt({
    html: false,
    breaks: true,
    linkify: true,
    typographer: false,
  })

  // 无协议的域名形态也可能是项目文件（如 AGENTS.md、index.html）。
  instance.linkify.set({ fuzzyLink: false })

  const defaultLinkOpenRule = instance.renderer.rules.link_open
  const defaultTableOpenRule = instance.renderer.rules.table_open
  const defaultTableCloseRule = instance.renderer.rules.table_close
  const defaultFenceRule = instance.renderer.rules.fence
  const defaultImageRule = instance.renderer.rules.image

  instance.renderer.rules.link_open = (tokens, idx, renderOptions, env, self) => {
    const token = tokens[idx]
    token.attrSet('target', '_blank')
    token.attrSet('rel', 'noreferrer noopener')

    if (typeof defaultLinkOpenRule === 'function') {
      return defaultLinkOpenRule(tokens, idx, renderOptions, env, self)
    }

    return self.renderToken(tokens, idx, renderOptions)
  }

  instance.renderer.rules.table_open = (tokens, idx, renderOptions, env, self) => {
    const rendered = typeof defaultTableOpenRule === 'function'
      ? defaultTableOpenRule(tokens, idx, renderOptions, env, self)
      : self.renderToken(tokens, idx, renderOptions)

    return `<div class="codex-table-wrap">${rendered}`
  }

  instance.renderer.rules.table_close = (tokens, idx, renderOptions, env, self) => {
    const rendered = typeof defaultTableCloseRule === 'function'
      ? defaultTableCloseRule(tokens, idx, renderOptions, env, self)
      : self.renderToken(tokens, idx, renderOptions)

    return `${rendered}</div>`
  }

  instance.renderer.rules.image = (tokens, idx, renderOptions, env = {}, self) => {
    const token = tokens[idx]
    token.attrSet('tabindex', '0')
    token.attrSet('role', 'button')
    token.attrSet('title', '点击查看大图')
    const target = timelineImageForHref(token.attrGet('src'), env.workspaceCwd)
    const renderImage = () => typeof defaultImageRule === 'function'
      ? defaultImageRule(tokens, idx, renderOptions, env, self)
      : self.renderToken(tokens, idx, renderOptions)
    if (!target) return renderImage()

    token.attrSet('src', TRANSPARENT_IMAGE_SRC)
    return `<span class="workspace-image-preview" data-workspace-image-path="${escapeHtml(target.path)}" data-local-image="${target.local ? '1' : '0'}" data-workspace-image-state="loading" role="status"><span class="workspace-image-status">图片加载中</span>${renderImage()}</span>`
  }

  if (options.captureFences) {
    instance.renderer.rules.fence = (tokens, idx, renderOptions, env = {}, self) => {
      const token = tokens[idx]
      const fenceEntries = Array.isArray(env.__promptxFences) ? env.__promptxFences : []
      const fenceIndex = fenceEntries.length
      const placeholder = `${FENCE_PLACEHOLDER_PREFIX}${fenceIndex}__`

      fenceEntries.push({
        content: String(token?.content || ''),
        language: String(token?.info || '').trim().split(/\s+/)[0] || '',
        placeholder,
      })
      env.__promptxFences = fenceEntries

      return placeholder
    }
  } else if (typeof defaultFenceRule === 'function') {
    instance.renderer.rules.fence = defaultFenceRule
  }

  return instance
}

const markdown = createMarkdownRenderer({ captureFences: true })
const plainMarkdown = createMarkdownRenderer()

async function renderHighlightedFence(content = '', language = '', options = {}) {
  const normalizedContent = String(content || '').replace(/\r\n/g, '\n')
  const normalizedLanguage = normalizeLanguage(language)
  const resolvedLanguage = resolvePreviewLanguage(normalizedLanguage)
  const highlightedLines = await renderHighlightedCodeLines(normalizedContent.split('\n'), {
    isDark: Boolean(options.isDark),
    language: resolvedLanguage || normalizedLanguage,
  })
  const highlighted = highlightedLines.join('\n')
  const codeClassAttr = normalizedLanguage
    ? ` class="language-${escapeHtml(normalizedLanguage)}"`
    : ''
  const languageLabel = getDisplayLanguage(language)
  const copyLabel = escapeHtml(String(options.copyLabel || 'Copy'))
  const copyAriaLabel = escapeHtml(String(options.copyAriaLabel || copyLabel))
  const languageBadge = languageLabel
    ? `<span class="codex-code-block__language">${escapeHtml(languageLabel)}</span>`
    : '<span class="codex-code-block__language-placeholder" aria-hidden="true"></span>'
  const header = `<div class="codex-code-block__header">${languageBadge}<button type="button" class="codex-code-block__copy" data-copy-code="1" aria-label="${copyAriaLabel}">${copyLabel}</button></div>`
  const blockClass = languageLabel
    ? 'codex-code-block codex-code-block--labeled'
    : 'codex-code-block'

  return `<div class="${blockClass}">${header}<pre><code${codeClassAttr}>${highlighted}</code></pre></div>`
}

async function resolveFencePlaceholders(html = '', fenceEntries = [], options = {}) {
  if (!Array.isArray(fenceEntries) || !fenceEntries.length) {
    return html
  }

  const renderedEntries = await Promise.all(
    fenceEntries.map((entry) => renderHighlightedFence(entry.content, entry.language, options))
  )

  return fenceEntries.reduce((output, entry, index) => (
    output.replace(entry.placeholder, renderedEntries[index] || entry.placeholder)
  ), html)
}

export async function renderCodexMarkdown(value = '', options = {}) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  const env = { workspaceCwd: String(options.workspaceCwd || '') }
  const html = markdown.render(text, env)
  return resolveFencePlaceholders(html, env.__promptxFences || [], options)
}

export function renderPlainCodexMarkdown(value = '', options = {}) {
  const text = String(value || '').trim()
  if (!text) {
    return ''
  }

  return plainMarkdown.render(text, { workspaceCwd: String(options.workspaceCwd || '') })
}

export async function renderHighlightedCodeBlock(value = '', language = '', options = {}) {
  return renderHighlightedFence(value, language, options)
}
