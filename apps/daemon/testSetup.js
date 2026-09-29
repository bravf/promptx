import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 测试工作进程始终使用独立目录，不能加载或迁移用户真实的 Relay 身份。
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-daemon-tests-'))
process.env.PROMPTX_HOME = root
process.env.PROMPTX_DATA_DIR = path.join(root, 'data')
process.env.PROMPTX_UPLOADS_DIR = path.join(root, 'uploads')
process.env.PROMPTX_RELAY_ENABLED = 'false'
process.on('exit', () => fs.rmSync(root, { recursive: true, force: true }))
