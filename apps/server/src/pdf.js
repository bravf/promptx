import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { createCanvas, DOMMatrix, ImageData, Path2D } from '@napi-rs/canvas'
import { nanoid } from 'nanoid'

const require = createRequire(import.meta.url)

if (!process.getBuiltinModule) {
  process.getBuiltinModule = (name) => require(name)
}
if (!globalThis.DOMMatrix) {
  globalThis.DOMMatrix = DOMMatrix
}
if (!globalThis.ImageData) {
  globalThis.ImageData = ImageData
}
if (!globalThis.Path2D) {
  globalThis.Path2D = Path2D
}

const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
const currentDir = path.dirname(fileURLToPath(import.meta.url))
const standardFontDataUrl = `${path.resolve(currentDir, '../node_modules/pdfjs-dist/standard_fonts')}/`

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function normalizeText(text = '') {
  return String(text || '')
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function createImageBlock(content, meta = {}) {
  return {
    type: 'image',
    content,
    meta,
  }
}

function createTextBlock(content, meta = {}) {
  return {
    type: 'text',
    content,
    meta,
  }
}

function toPixelBox(bboxReader, index, width, height) {
  if (!bboxReader || bboxReader.isEmpty(index)) {
    return null
  }

  const minX = clamp(Math.floor(bboxReader.minX(index) * width), 0, width)
  const minY = clamp(Math.floor(bboxReader.minY(index) * height), 0, height)
  const maxX = clamp(Math.ceil(bboxReader.maxX(index) * width), 0, width)
  const maxY = clamp(Math.ceil(bboxReader.maxY(index) * height), 0, height)

  if (maxX <= minX || maxY <= minY) {
    return null
  }

  return {
    left: minX,
    top: minY,
    right: maxX,
    bottom: maxY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function mergeLines(items = [], pageHeight) {
  const lines = []
  let current = null

  for (const raw of items) {
    const value = raw.str ?? ''
    if (!value || !value.trim()) {
      if (current && raw.hasEOL) {
        lines.push(current)
        current = null
      }
      continue
    }

    const itemHeight = Math.max(Math.abs(raw.height || 0), Math.abs(raw.transform?.[3] || 0), 1)
    const top = clamp(pageHeight - raw.transform[5] - itemHeight, 0, pageHeight)
    const bottom = clamp(pageHeight - raw.transform[5], 0, pageHeight)
    const item = {
      text: value,
      x: raw.transform[4],
      top,
      bottom,
      height: Math.max(bottom - top, itemHeight),
    }

    if (!current) {
      current = {
        items: [item],
        top: item.top,
        bottom: item.bottom,
        height: item.height,
      }
    } else {
      const threshold = Math.max(current.height, item.height, 10) * 0.65
      if (Math.abs(item.top - current.top) <= threshold) {
        current.items.push(item)
        current.top = Math.min(current.top, item.top)
        current.bottom = Math.max(current.bottom, item.bottom)
        current.height = Math.max(current.height, item.height)
      } else {
        lines.push(current)
        current = {
          items: [item],
          top: item.top,
          bottom: item.bottom,
          height: item.height,
        }
      }
    }

    if (raw.hasEOL && current) {
      lines.push(current)
      current = null
    }
  }

  if (current) {
    lines.push(current)
  }

  return lines
    .map((line) => {
      const text = line.items
        .sort((left, right) => left.x - right.x)
        .map((item) => item.text)
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim()

      if (!text) {
        return null
      }

      return {
        text,
        top: line.top,
        bottom: line.bottom,
        height: line.height,
      }
    })
    .filter(Boolean)
}

function mergeParagraphs(lines = []) {
  const paragraphs = []
  let current = null

  for (const line of lines) {
    if (!current) {
      current = {
        text: line.text,
        top: line.top,
        bottom: line.bottom,
        height: line.height,
      }
      continue
    }

    const gap = line.top - current.bottom
    const threshold = Math.max(current.height, line.height, 12) * 0.9
    if (gap <= threshold) {
      current.text = `${current.text}\n${line.text}`
      current.bottom = Math.max(current.bottom, line.bottom)
      current.height = Math.max(current.height, line.height)
      continue
    }

    paragraphs.push(current)
    current = {
      text: line.text,
      top: line.top,
      bottom: line.bottom,
      height: line.height,
    }
  }

  if (current) {
    paragraphs.push(current)
  }

  return paragraphs
    .map((paragraph) => ({
      ...paragraph,
      text: normalizeText(paragraph.text.replace(/\n{3,}/g, '\n\n')),
    }))
    .filter((paragraph) => paragraph.text)
}

function extractImageOperations(operatorList, bboxReader, canvasWidth, canvasHeight, pageWidth, pageHeight) {
  const imageOps = []

  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const fn = operatorList.fnArray[index]
    if (![pdfjs.OPS.paintImageXObject, pdfjs.OPS.paintInlineImageXObject, pdfjs.OPS.paintImageXObjectRepeat].includes(fn)) {
      continue
    }

    const box = toPixelBox(bboxReader, index, canvasWidth, canvasHeight)
    if (!box) {
      continue
    }
    if (box.width < 32 || box.height < 32 || box.width * box.height < 4096) {
      continue
    }

    imageOps.push({
      top: bboxReader.minY(index) * pageHeight,
      bottom: bboxReader.maxY(index) * pageHeight,
      box,
    })
  }

  return imageOps
}

function uniqueImageOps(images = []) {
  const unique = []

  for (const image of images) {
    const duplicated = unique.some((existing) => {
      const dx = Math.abs(existing.box.left - image.box.left)
      const dy = Math.abs(existing.box.top - image.box.top)
      const dw = Math.abs(existing.box.width - image.box.width)
      const dh = Math.abs(existing.box.height - image.box.height)
      return dx <= 4 && dy <= 4 && dw <= 4 && dh <= 4
    })

    if (!duplicated) {
      unique.push(image)
    }
  }

  return unique
}

function saveCroppedImage(pageCanvas, image, uploadsDir) {
  const targetCanvas = createCanvas(image.box.width, image.box.height)
  const targetContext = targetCanvas.getContext('2d')
  targetContext.drawImage(
    pageCanvas,
    image.box.left,
    image.box.top,
    image.box.width,
    image.box.height,
    0,
    0,
    image.box.width,
    image.box.height
  )

  const outputName = `${nanoid(16)}.jpg`
  const outputPath = path.join(uploadsDir, outputName)
  fs.writeFileSync(outputPath, targetCanvas.toBuffer('image/jpeg'))
  return `/uploads/${outputName}`
}

async function renderPage(page, scale) {
  const viewport = page.getViewport({ scale })
  const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height))
  const context = canvas.getContext('2d')
  await page.render({
    canvasContext: context,
    viewport,
    recordOperations: true,
  }).promise

  return {
    viewport,
    canvas,
  }
}

export async function importPdfDocument(buffer, options = {}) {
  const { uploadsDir } = options
  const loadingTask = pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useWorkerFetch: false,
    isEvalSupported: false,
    standardFontDataUrl,
  })
  const pdf = await loadingTask.promise
  const pageEntries = []
  const createdAssets = []

  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber)
      const pageViewport = page.getViewport({ scale: 1 })
      const { viewport, canvas } = await renderPage(page, 2)
      const textContent = await page.getTextContent()
      const lines = mergeLines(textContent.items || [], pageViewport.height)
      const paragraphs = mergeParagraphs(lines).map((paragraph) => ({
        type: 'text',
        page: pageNumber,
        top: paragraph.top,
        bottom: paragraph.bottom,
        block: createTextBlock(paragraph.text, {
          source: 'pdf',
          page: pageNumber,
        }),
      }))

      const operatorList = await page.getOperatorList()
      const images = uniqueImageOps(
        extractImageOperations(
          operatorList,
          page.recordedBBoxes,
          canvas.width,
          canvas.height,
          pageViewport.width,
          pageViewport.height
        )
      ).map((image) => {
        const assetUrl = saveCroppedImage(canvas, image, uploadsDir)
        createdAssets.push(assetUrl)
        return {
          type: 'image',
          page: pageNumber,
          top: image.top,
          bottom: image.bottom,
          block: createImageBlock(assetUrl, {
            source: 'pdf',
            page: pageNumber,
          }),
        }
      })

      pageEntries.push(...paragraphs, ...images)
      page.cleanup()
    }
  } catch (error) {
    await pdf.destroy()
    throw Object.assign(error, { createdAssets })
  }

  await pdf.destroy()

  const blocks = pageEntries
    .sort((left, right) => {
      if (left.page !== right.page) {
        return left.page - right.page
      }
      if (left.top !== right.top) {
        return left.top - right.top
      }
      if (left.type !== right.type) {
        return left.type === 'text' ? -1 : 1
      }
      return left.bottom - right.bottom
    })
    .map((entry) => entry.block)

  if (!blocks.length) {
    return {
      blocks: [],
      pageCount: pdf.numPages,
      createdAssets,
    }
  }

  return {
    blocks,
    pageCount: pdf.numPages,
    createdAssets,
  }
}
