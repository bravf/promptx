import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MAX_ASSET_SIZE = 50 * 1024 * 1024

export function normalizeAssetName(value = '') {
  const baseName = path.basename(String(value || '').replaceAll('\\', '/')).trim()
  const normalized = baseName.replace(/[\u0000-\u001f\u007f]/g, '').replace(/[/\\]/g, '-').slice(0, 180)
  return normalized || 'attachment'
}

export function publicAsset(asset) {
  return {
    id: asset.id,
    workspaceId: asset.workspaceId,
    name: asset.name,
    mimeType: asset.mimeType,
    size: asset.size,
    createdAt: asset.createdAt,
  }
}

export async function storeAsset({ part, workspaceId, assetsDir, repository }) {
  const id = randomUUID()
  const name = normalizeAssetName(part.filename)
  const mimeType = String(part.mimetype || 'application/octet-stream').trim().toLowerCase() || 'application/octet-stream'
  const workspaceDir = path.join(assetsDir, workspaceId)
  const storagePath = path.join(workspaceDir, id)
  const hash = createHash('sha256')
  let size = 0
  fs.mkdirSync(workspaceDir, { recursive: true })

  const hasher = new Transform({
    transform(chunk, encoding, callback) {
      size += chunk.length
      hash.update(chunk)
      callback(null, chunk)
    },
  })

  try {
    await pipeline(part.file, hasher, fs.createWriteStream(storagePath, { flags: 'wx' }))
    if (part.file.truncated) {
      const error = new Error(`附件不能超过 ${Math.round(MAX_ASSET_SIZE / 1024 / 1024)} MB。`)
      error.statusCode = 413
      throw error
    }
    return repository.createAsset(workspaceId, {
      id,
      name,
      mimeType,
      size,
      sha256: hash.digest('hex'),
      storagePath,
    })
  } catch (error) {
    fs.rmSync(storagePath, { force: true })
    throw error
  }
}

export function removeStoredAssets(assets = []) {
  for (const asset of assets) fs.rmSync(asset.storagePath, { force: true })
}
