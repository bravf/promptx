import fs from 'node:fs'
import path from 'node:path'
import { resolvePromptxPaths } from './lib/promptxPaths.mjs'

const paths = resolvePromptxPaths()
const databasePath = path.join(paths.dataDir, 'promptx-v2.sqlite')
const targets = [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, paths.uploadsDir]

for (const target of targets) {
  fs.rmSync(target, { recursive: true, force: true })
}

console.log(`已清理 PromptX 开发数据：${databasePath}`)
