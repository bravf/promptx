import os from 'node:os'
import path from 'node:path'

export function resolvePromptxPaths() {
  const promptxHomeDir = path.resolve(process.env.PROMPTX_HOME || path.join(os.homedir(), '.promptx'))
  return {
    promptxHomeDir,
    dataDir: path.resolve(process.env.PROMPTX_DATA_DIR || path.join(promptxHomeDir, 'data')),
    uploadsDir: path.resolve(process.env.PROMPTX_UPLOADS_DIR || path.join(promptxHomeDir, 'uploads-v2')),
    tmpDir: path.resolve(process.env.PROMPTX_TMP_DIR || path.join(promptxHomeDir, 'tmp')),
  }
}
