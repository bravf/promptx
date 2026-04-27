import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runtimeDirs = [
  path.join(rootDir, 'apps', 'server', 'src'),
  path.join(rootDir, 'apps', 'runner', 'src'),
]
const forbiddenPackageImports = [
  '@promptx/shared',
]

function walk(dir, files = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(entryPath, files)
      continue
    }
    if (!entry.isFile() || !entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) {
      continue
    }
    files.push(entryPath)
  }
  return files
}

function normalizePath(filePath) {
  return path.relative(rootDir, filePath).split(path.sep).join('/')
}

const failures = []

for (const filePath of runtimeDirs.flatMap((dir) => walk(dir))) {
  const source = fs.readFileSync(filePath, 'utf8')
  for (const packageName of forbiddenPackageImports) {
    const importPattern = new RegExp(`(?:from\\s+['"]${packageName}(?:/[^'"]*)?['"]|import\\s*\\(\\s*['"]${packageName}(?:/[^'"]*)?['"]\\s*\\))`)
    if (importPattern.test(source)) {
      failures.push(`${normalizePath(filePath)} 引用了 ${packageName}`)
    }
  }
}

if (failures.length) {
  console.error('[package-imports] 发布运行时代码不能依赖 workspace 裸包名：')
  for (const failure of failures) {
    console.error(`- ${failure}`)
  }
  console.error('[package-imports] 请改用发布包内可解析的相对路径，或把依赖作为真实 npm 依赖发布。')
  process.exitCode = 1
} else {
  console.log('[package-imports] 发布运行时 import 检查通过。')
}
