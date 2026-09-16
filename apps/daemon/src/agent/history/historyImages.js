import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { MAX_ASSET_SIZE, normalizeAssetName } from '../../assets/assetStorage.js'

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['image/png', 'png']
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', 'jpg']
  if (/^GIF8[79]a$/.test(bytes.subarray(0, 6).toString())) return ['image/gif', 'gif']
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP') return ['image/webp', 'webp']
  throw new Error('不支持的图片格式')
}

async function importImage(source, { taskId, assetsDir, repository }) {
  const id = `history-image-${createHash('sha256').update(`${taskId}\0${source}`).digest('hex')}`
  const existing = repository.getAsset(id)
  if (existing) {
    try { await fs.access(existing.storagePath); return existing } catch {}
  }
  if (!assetsDir) throw new Error('附件目录不可用')
  let bytes
  let name
  if (source.startsWith('data:')) {
    const match = /^data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/=\r\n]+)$/.exec(source)
    if (!match || match[1].length > Math.ceil(MAX_ASSET_SIZE / 3) * 4 + 1024) throw new Error('图片内容无效或过大')
    bytes = Buffer.from(match[1], 'base64')
  } else {
    // 只读取 Provider 明确记录的本地附件，不从普通消息文字提取路径。
    if (!path.isAbsolute(source)) throw new Error('图片路径不可用')
    const file = await fs.open(source, 'r')
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.size > MAX_ASSET_SIZE) throw new Error('图片文件不可用或过大')
      bytes = Buffer.alloc(stat.size)
      let offset = 0
      while (offset < bytes.length) {
        const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset)
        if (!bytesRead) break
        offset += bytesRead
      }
      bytes = bytes.subarray(0, offset)
    } finally { await file.close() }
    name = normalizeAssetName(source)
  }
  if (!bytes.length || bytes.length > MAX_ASSET_SIZE) throw new Error('图片大小无效')
  const [mimeType, extension] = imageType(bytes)
  const directory = path.join(assetsDir, taskId)
  await fs.mkdir(directory, { recursive: true })
  const storagePath = path.join(directory, id)
  await fs.writeFile(storagePath, bytes)
  if (existing) return existing
  try {
    return repository.createAsset(taskId, { id, name: name || `导入图片.${extension}`, mimeType, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), storagePath })
  } catch (error) { await fs.rm(storagePath, { force: true }); throw error }
}

export async function materializeHistoryImages(snapshot, options) {
  const cache = new Map()
  for (const turn of snapshot.turns) for (const entry of turn.items || []) {
    if (entry.item?.type !== 'user_message') continue
    const content = []
    for (const block of entry.item.content || []) {
      if (block.type !== 'history_image') { content.push(block); continue }
      const source = String(block.source || '')
      if (!cache.has(source)) cache.set(source, importImage(source, options).catch(() => null))
      const asset = await cache.get(source)
      if (asset) {
        if (!content.some(item => item.assetId === asset.id)) content.push({ type: 'image', assetId: asset.id, mimeType: asset.mimeType, name: asset.name, size: asset.size })
      } else {
        const name = path.isAbsolute(source) ? normalizeAssetName(source) : '历史图片'
        content.push({ type: 'text', text: `[原图片已不可用：${name}]` })
      }
    }
    entry.item.content = content
  }
  return snapshot
}
