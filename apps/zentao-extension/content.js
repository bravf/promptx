const ROOT_ID = 'promptx-zentao-bridge-root'
const FIELD_ALIASES = {
  status: ['状态'],
  priority: ['优先级'],
  severity: ['严重程度', '严重性'],
  assignedTo: ['指派给', '由谁处理'],
  openedBy: ['由谁创建', '创建者'],
  openedDate: ['创建时间', '创建日期'],
  deadline: ['截止日期'],
  module: ['所属模块'],
  project: ['所属项目', '项目'],
  execution: ['所属执行', '所属迭代', '执行'],
  branch: ['平台', '分支'],
  os: ['操作系统', '系统'],
  browser: ['浏览器'],
  bugType: ['Bug类型', '类型'],
  frequency: ['重现频率'],
  version: ['影响版本', '版本'],
}
const SECTION_ALIASES = [
  { title: '现象', aliases: ['Bug描述', '描述', '现象', '问题描述'] },
  { title: '重现步骤', aliases: ['重现步骤', '复现步骤', '步骤'] },
  { title: '期望结果', aliases: ['期望结果', '预期结果'] },
  { title: '实际结果', aliases: ['实际结果', '实际表现'] },
  { title: '备注', aliases: ['备注', '补充说明', '附注'] },
]
const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tr',
  'td',
  'th',
  'ul',
])
const TEXT_BREAK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'dd',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'thead',
  'tfoot',
  'tr',
  'td',
  'th',
  'ul',
])

let ui = null
let lastUrl = location.href

function normalizeInlineText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim()
}

function normalizeMultilineText(value = '') {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

function normalizeLabel(value = '') {
  return normalizeInlineText(value).replace(/[：:]+$/g, '')
}

function normalizeRichText(value = '') {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trimEnd())
    .join('\n')
    .trim()
}

function toAbsoluteUrl(value = '') {
  try {
    return new URL(value, location.href).toString()
  } catch {
    return ''
  }
}

function isDecorativeImage(element) {
  const clues = [
    element.getAttribute('class') || '',
    element.getAttribute('alt') || '',
    element.getAttribute('title') || '',
    element.getAttribute('src') || '',
  ]
    .join(' ')
    .toLowerCase()

  return /avatar|gravatar|emoji|icon|operate|sort|priority-icon/.test(clues)
}

function extractRichTextFromNode(node) {
  if (!node) {
    return ''
  }

  const parts = []

  function push(value) {
    if (value) {
      parts.push(value)
    }
  }

  function visit(current) {
    if (!current) {
      return
    }

    if (current.nodeType === Node.TEXT_NODE) {
      const text = current.textContent.replace(/\s+/g, ' ')
      push(text)
      return
    }

    if (current.nodeType !== Node.ELEMENT_NODE) {
      return
    }

    const tag = current.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'template'].includes(tag)) {
      return
    }
    if (current.matches?.('[hidden], .hidden, .hide')) {
      return
    }

    if (tag === 'br') {
      push('\n')
      return
    }

    if (tag === 'img') {
      if (isDecorativeImage(current)) {
        return
      }
      const src = toAbsoluteUrl(
        current.getAttribute('src')
          || current.getAttribute('data-src')
          || current.getAttribute('data-original')
          || ''
      )
      if (src) {
        const alt = normalizeInlineText(current.getAttribute('alt') || current.getAttribute('title') || '')
        push(`\n[图片] ${alt ? `${alt}：` : ''}${src}\n`)
      }
      return
    }

    const isBlock = BLOCK_TAGS.has(tag)
    if (isBlock && parts.length && !String(parts[parts.length - 1]).endsWith('\n')) {
      push('\n')
    }

    Array.from(current.childNodes).forEach(visit)

    if (tag === 'a') {
      const href = toAbsoluteUrl(current.getAttribute('href') || '')
      const text = normalizeInlineText(current.textContent || '')
      if (href && !current.querySelector('img') && href !== text) {
        push(` (${href})`)
      }
    }

    if (isBlock) {
      push('\n')
    }
  }

  visit(node)
  return normalizeRichText(parts.join(''))
}

function removeNodes(root, selectors = []) {
  selectors.forEach((selector) => {
    root.querySelectorAll(selector).forEach((node) => node.remove())
  })
}

function dedupeEntries(items = [], getKey) {
  const seen = new Set()
  return items.filter((item) => {
    const key = getKey(item)
    if (!key || seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function createTextBlock(content = '') {
  const value = normalizeRichText(content)
  if (!value) {
    return null
  }
  return {
    type: 'text',
    content: value,
    meta: {},
  }
}

function createImageBlock(url = '') {
  const value = toAbsoluteUrl(url)
  if (!value) {
    return null
  }
  return {
    type: 'image',
    content: value,
    meta: {},
  }
}

function mergeTrailingTextBlocks(blocks = []) {
  const merged = []
  blocks.forEach((block) => {
    if (!block) {
      return
    }
    const previous = merged[merged.length - 1]
    if (previous?.type === 'text' && block.type === 'text') {
      previous.content = normalizeRichText(`${previous.content}\n\n${block.content}`)
      return
    }
    merged.push(block)
  })
  return merged
}

function getAccessibleFrameDocuments() {
  return Array.from(document.querySelectorAll('iframe'))
    .map((frame) => {
      try {
        return frame.contentDocument || frame.contentWindow?.document || null
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function resolveTargetDocument() {
  const selectors = [
    '.detail-content.article-content',
    '.detail-content',
    '.article-content',
  ]

  for (const selector of selectors) {
    if (document.querySelector(selector)) {
      return document
    }
  }

  for (const frameDocument of getAccessibleFrameDocuments()) {
    for (const selector of selectors) {
      if (frameDocument.querySelector(selector)) {
        return frameDocument
      }
    }
  }

  return document
}

function extractContentFromDiv(selector, sourceDocument = document) {
  const root = sourceDocument.querySelector(selector)
  if (!root) {
    return []
  }

  const result = []

  function walk(node) {
    if (!node) {
      return
    }

    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent.replace(/\s+/g, ' ').trim()
      if (text) {
        result.push({
          type: 'text',
          content: text,
          meta: {},
        })
      }
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return
    }

    const tag = node.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'template'].includes(tag)) {
      return
    }

    if (tag === 'img') {
      const src = node.src || node.getAttribute('src') || ''
      if (src && !isDecorativeImage(node)) {
        result.push({
          type: 'image',
          content: toAbsoluteUrl(src),
          meta: {},
        })
      }
      return
    }

    Array.from(node.childNodes).forEach(walk)
  }

  walk(root)
  return mergeTrailingTextBlocks(
    result.map((block) => {
      if (block.type === 'image') {
        return block
      }
      return createTextBlock(block.content)
    }).filter(Boolean)
  )
}

function isLikelyZenTaoBugPage() {
  const href = location.href.toLowerCase()
  const query = location.search.toLowerCase()
  const hasSelfContent = Boolean(document.querySelector('.detail-content.article-content, .detail-content, .article-content'))
  const hasUrlMatch = (
    href.includes('bug-view-')
    || href.includes('/bug/view/')
    || (query.includes('m=bug') && query.includes('f=view'))
  )
  if (hasSelfContent) {
    return true
  }
  if (window.top !== window) {
    return hasUrlMatch
  }
  return false
}

function queryFirstText(selectors = [], sourceDocument = document) {
  for (const selector of selectors) {
    const text = normalizeInlineText(sourceDocument.querySelector(selector)?.innerText || '')
    if (text) {
      return text
    }
  }
  return ''
}

function deriveTitle(sourceDocument = document) {
  const directTitle = queryFirstText([
    '#titlebar .title',
    '.main-header h1',
    '.main-header h2',
    '.page-title',
    'h1',
  ], sourceDocument)
  if (directTitle) {
    return directTitle
  }

  return normalizeInlineText(sourceDocument.title.split('-')[0] || sourceDocument.title)
}

function extractTablePairs() {
  const pairs = []

  document.querySelectorAll('tr').forEach((row) => {
    const cells = Array.from(row.children).filter((cell) => /^(TH|TD)$/.test(cell.tagName))
    if (cells.length < 2) {
      return
    }

    if (cells.length === 2) {
      const label = normalizeLabel(cells[0].innerText)
      const value = normalizeMultilineText(cells[1].innerText)
      if (label && value) {
        pairs.push({ label, value })
      }
      return
    }

    for (let index = 0; index < cells.length - 1; index += 2) {
      const label = normalizeLabel(cells[index].innerText)
      const value = normalizeMultilineText(cells[index + 1].innerText)
      if (label && value) {
        pairs.push({ label, value })
      }
    }
  })

  document.querySelectorAll('dl').forEach((list) => {
    Array.from(list.children).forEach((child) => {
      if (child.tagName !== 'DT') {
        return
      }
      let sibling = child.nextElementSibling
      while (sibling && sibling.tagName !== 'DD') {
        sibling = sibling.nextElementSibling
      }
      const label = normalizeLabel(child.innerText)
      const value = normalizeMultilineText(sibling?.innerText || '')
      if (label && value) {
        pairs.push({ label, value })
      }
    })
  })

  const seen = new Set()
  return pairs.filter((pair) => {
    const key = `${pair.label}::${pair.value}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function pickPairValue(pairs, aliases = []) {
  const normalizedAliases = aliases.map((alias) => normalizeLabel(alias))
  for (const alias of normalizedAliases) {
    const matched = pairs.find((pair) => normalizeLabel(pair.label).includes(alias))
    if (matched?.value) {
      return matched.value
    }
  }
  return ''
}

function findSectionFromDom(aliases = []) {
  const normalizedAliases = aliases.map((alias) => normalizeLabel(alias))
  const root = document.querySelector('#mainContent > .main-col') || document
  const candidates = root.querySelectorAll(
    'h1, h2, h3, h4, h5, h6, dt, th, strong, label, legend, .detail-title, .panel-heading, .cell .title'
  )

  for (const candidate of candidates) {
    const label = normalizeLabel(candidate.innerText)
    if (!label || label.length > 20) {
      continue
    }
    if (!normalizedAliases.some((alias) => label.includes(alias))) {
      continue
    }

    const siblingCandidates = [
      candidate.nextElementSibling,
      candidate.parentElement?.nextElementSibling,
      candidate.closest('tr')?.querySelector('td:last-child'),
      candidate.closest('dl')?.querySelector('dd'),
      candidate.closest('.panel, .cell, section, fieldset')?.querySelector('.panel-body, .detail-content, .content, .article-content'),
    ].filter(Boolean)

    for (const sibling of siblingCandidates) {
      const text = extractRichTextFromNode(sibling)
      if (text && text !== label) {
        return text
      }
    }
  }

  return ''
}

function extractAttachments() {
  const links = []
  document.querySelectorAll('a[href]').forEach((anchor) => {
    const href = anchor.getAttribute('href') || ''
    const text = normalizeInlineText(anchor.innerText)
    const absoluteUrl = toAbsoluteUrl(href)

    if (!absoluteUrl || absoluteUrl.startsWith('javascript:') || absoluteUrl.startsWith('mailto:')) {
      return
    }

    const isAttachment = /attachment|download|file-|api.php\?m=file/i.test(absoluteUrl)
      || /(附件|下载)/.test(text)
      || /\.(png|jpg|jpeg|gif|webp|pdf|zip|rar|7z|txt|md)$/i.test(absoluteUrl)
    if (!isAttachment) {
      return
    }

    links.push({
      label: text || '附件链接',
      url: absoluteUrl,
    })
  })

  const seen = new Set()
  return links.filter((item) => {
    if (seen.has(item.url)) {
      return false
    }
    seen.add(item.url)
    return true
  }).slice(0, 10)
}

function extractPageExcerpt() {
  const containers = [
    '#mainContent',
    '#maincontent',
    '.main-content',
    '.main-row',
    '#main',
    'main',
  ]

  for (const selector of containers) {
    const node = document.querySelector(selector)
    const text = normalizeMultilineText(node?.innerText || '')
    if (text.length >= 120) {
      return text.slice(0, 2200)
    }
  }

  return ''
}

function buildBlocksFromNode(root, options = {}) {
  if (!root) {
    return []
  }

  const {
    stripSelectors = [],
    prependText = '',
  } = options

  const clone = root.cloneNode(true)
  removeNodes(clone, [
    'script',
    'style',
    'noscript',
    'template',
    '[hidden]',
    '.hidden',
    '.hide',
    '.actions',
    '.toolbar',
    '.btn',
    '.btn-link',
    '.btn-toolbar',
    '.table-actions',
    '.breadcrumb',
    '.pager',
    '.nav',
    '.menu',
    '.dropdown',
    '.icon',
    `#${ROOT_ID}`,
    ...stripSelectors,
  ])

  const blocks = []
  let textBuffer = []

  function pushText(value) {
    if (value) {
      textBuffer.push(value)
    }
  }

  function flushText() {
    const block = createTextBlock(textBuffer.join(''))
    textBuffer = []
    if (!block) {
      return
    }
    const previous = blocks[blocks.length - 1]
    if (previous?.type === 'text') {
      previous.content = normalizeRichText(`${previous.content}\n\n${block.content}`)
      return
    }
    blocks.push(block)
  }

  function visit(node) {
    if (!node) {
      return
    }

    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent.replace(/\s+/g, ' '))
      return
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return
    }

    const tag = node.tagName.toLowerCase()
    if (['script', 'style', 'noscript', 'template'].includes(tag)) {
      return
    }
    if (node.matches?.('[hidden], .hidden, .hide')) {
      return
    }

    if (tag === 'br') {
      pushText('\n')
      return
    }

    if (tag === 'img') {
      if (isDecorativeImage(node)) {
        return
      }
      const src = node.getAttribute('src') || node.getAttribute('data-src') || node.getAttribute('data-original') || ''
      const imageBlock = createImageBlock(src)
      if (imageBlock) {
        flushText()
        blocks.push(imageBlock)
      }
      return
    }

    const isBreakTag = TEXT_BREAK_TAGS.has(tag)
    if (isBreakTag && textBuffer.length && !String(textBuffer[textBuffer.length - 1]).endsWith('\n')) {
      pushText('\n')
    }
    if (tag === 'li') {
      pushText('- ')
    }

    const href = tag === 'a' ? toAbsoluteUrl(node.getAttribute('href') || '') : ''
    const hasImageChild = Boolean(node.querySelector?.('img'))
    Array.from(node.childNodes).forEach(visit)

    if (tag === 'a' && href && !hasImageChild) {
      const anchorText = normalizeInlineText(node.textContent || '')
      if (href !== anchorText) {
        pushText(` (${href})`)
      }
    }

    if (isBreakTag) {
      pushText('\n')
    }
  }

  if (prependText) {
    pushText(`${prependText}\n\n`)
  }
  Array.from(clone.childNodes).forEach(visit)
  flushText()
  return mergeTrailingTextBlocks(blocks)
}

function extractBlocksFromDetailNode(detailNode) {
  if (!detailNode) {
    return []
  }

  const title = normalizeLabel(detailNode.querySelector('.detail-title')?.innerText || '')
  const contentNode = detailNode.querySelector('.detail-content, .article-content, .comment-content')
  const textContent = normalizeRichText(contentNode?.innerText || '')
  const imageBlocks = Array.from(contentNode?.querySelectorAll('img') || [])
    .filter((img) => !isDecorativeImage(img))
    .map((img) => createImageBlock(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''))
    .filter(Boolean)
  const contentBlocks = []
  if (textContent) {
    contentBlocks.push(createTextBlock(textContent))
  }
  contentBlocks.push(...imageBlocks)
  if (!contentBlocks.length) {
    return []
  }

  if (!title || /历史记录/.test(title)) {
    return contentBlocks
  }

  const [firstBlock, ...restBlocks] = contentBlocks
  if (firstBlock?.type === 'text') {
    return [
      createTextBlock(`${title}\n\n${firstBlock.content}`),
      ...restBlocks,
    ].filter(Boolean)
  }

  return [
    createTextBlock(title),
    ...contentBlocks,
  ].filter(Boolean)
}

function extractMainBlocks() {
  const root = document.querySelector('#mainContent > .main-col')
    || document.querySelector('#mainContent .main-col')
  if (!root) {
    return []
  }

  const clonedRoot = root.cloneNode(true)
  removeNodes(clonedRoot, [
    '.histories',
    '.histories-list',
    '#actionbox',
    '.modal',
    'script',
    'style',
    'button',
  ])
  const fallbackMainText = normalizeRichText(clonedRoot.innerText || '')
  const fallbackMainImages = Array.from(clonedRoot.querySelectorAll('img') || [])
    .filter((img) => !isDecorativeImage(img))
    .map((img) => createImageBlock(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''))
    .filter(Boolean)

  const detailBlocks = Array.from(root.querySelectorAll('.cell > .detail, .detail'))
    .filter((node) => !node.closest('.histories-list') && !node.classList.contains('histories') && !node.closest('.modal'))
    .flatMap((node) => extractBlocksFromDetailNode(node))

  if (detailBlocks.length) {
    return mergeTrailingTextBlocks(detailBlocks)
  }

  return mergeTrailingTextBlocks([
    createTextBlock(fallbackMainText),
    ...fallbackMainImages,
  ].filter(Boolean))
}

function extractCommentBlocks() {
  const list = document.querySelector('.histories-list')
  if (!list) {
    return []
  }

  const directItems = Array.from(list.children || []).filter((node) => node.nodeType === Node.ELEMENT_NODE)
  const candidates = directItems.length
    ? directItems
    : Array.from(list.querySelectorAll(':scope > li, :scope > .history, :scope > .history-item, :scope > .comment-item'))

  const blocks = []

  const listText = normalizeRichText(list.innerText || '')
  const listImages = Array.from(list.querySelectorAll('img') || [])
    .filter((img) => !isDecorativeImage(img))
    .map((img) => createImageBlock(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''))
    .filter(Boolean)

  if (!candidates.length) {
    return mergeTrailingTextBlocks([
      createTextBlock(listText ? `历史记录：\n${listText}` : ''),
      ...listImages,
    ].filter(Boolean))
  }

  candidates.forEach((item, index) => {
    const headerText = normalizeInlineText(item.childNodes[0]?.textContent || '')
      || normalizeInlineText(
        item.querySelector('.history-head, .heading, .title, .comment-title, header, .text-muted, .small')?.innerText || ''
      )
    const commentBodyBlocks = []
    const changeText = normalizeRichText(item.querySelector('.history-changes')?.innerText || '')
    const commentText = normalizeRichText(item.querySelector('.comment-content, .article-content.comment')?.innerText || '')
    const mergedText = [changeText, commentText].filter(Boolean).join('\n\n')
    if (mergedText) {
      commentBodyBlocks.push(createTextBlock(mergedText))
    }
    const commentImageBlocks = Array.from(item.querySelectorAll('.comment-content img, .article-content.comment img') || [])
      .filter((img) => !isDecorativeImage(img))
      .map((img) => createImageBlock(img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-original') || ''))
      .filter(Boolean)
    commentBodyBlocks.push(...commentImageBlocks)
    const introBlock = createTextBlock(headerText ? `评论 ${index + 1}：${headerText}` : `评论 ${index + 1}`)
    const commentBlocks = [introBlock, ...commentBodyBlocks].filter(Boolean)
    blocks.push(...commentBlocks)
  })

  return mergeTrailingTextBlocks(blocks)
}

function extractBugDraft() {
  const sourceDocument = resolveTargetDocument()
  const detailTitle = normalizeLabel(
    sourceDocument.querySelector('#mainContent > .main-col .detail-title, #mainContent .main-col .detail-title, .detail-title')?.innerText || ''
  )
  const detailTitleBlock = detailTitle ? createTextBlock(detailTitle) : null
  const contentBlocks = extractContentFromDiv('#mainContent > .main-col .detail-content.article-content', sourceDocument)
  const fallbackScopedContentBlocks = contentBlocks.length
    ? []
    : extractContentFromDiv('#mainContent > .main-col .detail-content', sourceDocument)
  const fallbackContentBlocks = contentBlocks.length
    || fallbackScopedContentBlocks.length
    ? []
    : extractContentFromDiv('.detail-content.article-content', sourceDocument)
  const lastFallbackContentBlocks = contentBlocks.length
    || fallbackScopedContentBlocks.length
    || fallbackContentBlocks.length
    ? []
    : extractContentFromDiv('.detail-content', sourceDocument)
  const blocks = mergeTrailingTextBlocks([
    detailTitleBlock,
    ...contentBlocks,
    ...fallbackScopedContentBlocks,
    ...fallbackContentBlocks,
    ...lastFallbackContentBlocks,
  ].filter(Boolean))

  const pageExcerpt = blocks.length ? '' : extractPageExcerpt()
  return {
    title: deriveTitle(sourceDocument),
    metaPairs: [],
    sections: [],
    blocks,
    pageExcerpt,
  }
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
        return
      }
      if (!response?.ok) {
        reject(new Error(response?.error || '生成 PromptX 链接失败。'))
        return
      }
      resolve(response)
    })
  })
}

function createRoot() {
  const host = document.createElement('div')
  host.id = ROOT_ID
  document.documentElement.appendChild(host)

  const shadow = host.attachShadow({ mode: 'open' })
  shadow.innerHTML = `
    <style>
      :host {
        all: initial;
      }
      .wrap {
        position: fixed;
        right: 24px;
        bottom: 24px;
        z-index: 2147483647;
        display: flex;
        flex-direction: column;
        align-items: flex-end;
        gap: 12px;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      .button {
        border: 1px solid #1c1917;
        background: #1c1917;
        color: #fafaf9;
        border-radius: 4px;
        padding: 10px 14px;
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
      }
      .button[disabled] {
        opacity: 0.75;
        cursor: default;
      }
    </style>
    <div class="wrap">
      <button class="button" type="button">AI修复</button>
    </div>
  `

  const refs = {
    host,
    button: shadow.querySelector('.button'),
    state: {
      busy: false,
      error: false,
    },
  }

  refs.button.addEventListener('click', () => handleCreate(refs))

  render(refs)
  return refs
}

function render(refs) {
  refs.button.textContent = refs.state.busy ? '生成中...' : refs.state.error ? '重试 AI修复' : 'AI修复'
  refs.button.disabled = refs.state.busy
  refs.button.title = refs.state.error ? '生成失败，请重试' : '创建 PromptX 编辑页'
}

async function handleCreate(refs) {
  refs.state.busy = true
  refs.state.error = false
  render(refs)

  try {
    const payload = extractBugDraft()
    if (!payload.title && !payload.pageExcerpt && !(payload.blocks || []).length) {
      throw new Error('当前页面没有提取到足够的 Bug 内容。')
    }

    const result = await sendRuntimeMessage({
      type: 'CREATE_TMPPROMPT_FROM_ZENTAO',
      payload,
    })
    window.open(result.editUrl, '_blank', 'noopener,noreferrer')
  } catch (error) {
    refs.state.error = true
    console.error('[promptx] 生成 PromptX 文档失败', error)
  } finally {
    refs.state.busy = false
    render(refs)
  }
}

function ensureUi() {
  const target = isLikelyZenTaoBugPage()
  if (!target) {
    if (ui?.host) {
      ui.host.remove()
      ui = null
    }
    return
  }

  if (!document.body) {
    return
  }

  if (!ui) {
    ui = createRoot()
  }
}

function bootstrap() {
  ensureUi()
  window.setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href
      ensureUi()
    }
  }, 1000)
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap, { once: true })
} else {
  bootstrap()
}
