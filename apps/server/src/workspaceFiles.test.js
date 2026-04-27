import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  listDirectoryPickerTree,
  listWorkspaceTree,
  readWorkspaceFileContent,
  searchWorkspaceFileContent,
  searchWorkspaceEntries,
  searchDirectoryPickerEntries,
} from './workspaceFiles.js'

test('listDirectoryPickerTree returns filesystem roots when path is empty', () => {
  const payload = listDirectoryPickerTree()

  assert.equal(payload.path, path.resolve(os.homedir()))
  assert.equal(payload.parentPath, path.dirname(path.resolve(os.homedir())))
  assert.equal(Array.isArray(payload.items), true)
  assert.equal(Array.isArray(payload.roots), true)
  assert.equal(payload.roots[0]?.path, path.resolve(os.homedir()))
  assert.equal(payload.roots[0]?.type, 'directory')
  assert.equal(typeof payload.roots[0]?.name, 'string')
  assert.equal(Boolean(payload.roots[0]?.name), true)
  assert.equal(payload.items.length > 0, true)
  assert.equal(payload.items.every((item) => item.type === 'directory'), true)
})

test('listDirectoryPickerTree returns parentPath for nested paths', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-picker-parent-'))
  const childDir = path.join(tempDir, 'project-a')

  fs.mkdirSync(childDir)

  const payload = listDirectoryPickerTree({ path: childDir })

  assert.equal(payload.path, childDir)
  assert.equal(payload.parentPath, tempDir)
})

test('listDirectoryPickerTree lists child directories and excludes files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-picker-'))
  const childDir = path.join(tempDir, 'project-a')
  const nestedDir = path.join(tempDir, 'project-b')
  const hiddenDir = path.join(tempDir, '.secret')
  const downloadsDir = path.join(tempDir, 'Downloads')
  const filePath = path.join(tempDir, 'note.txt')

  fs.mkdirSync(childDir)
  fs.mkdirSync(nestedDir)
  fs.mkdirSync(hiddenDir)
  fs.mkdirSync(downloadsDir)
  fs.writeFileSync(filePath, 'hello')

  const payload = listDirectoryPickerTree({ path: tempDir })

  assert.equal(payload.path, tempDir)
  assert.equal(payload.items.some((item) => item.path === childDir), true)
  assert.equal(payload.items.some((item) => item.path === nestedDir), true)
  assert.equal(payload.items.some((item) => item.path === hiddenDir), false)
  assert.equal(payload.items.some((item) => item.path === downloadsDir), false)
  assert.equal(payload.items.some((item) => item.path === filePath), false)
})

test('searchDirectoryPickerEntries returns matching directories only', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-dir-search-'))
  const alphaDir = path.join(tempDir, 'alpha-project')
  const betaDir = path.join(tempDir, 'beta-notes')
  const hiddenAlphaDir = path.join(tempDir, '.alpha-hidden')
  const alphaFile = path.join(tempDir, 'alpha-project.txt')

  fs.mkdirSync(alphaDir)
  fs.mkdirSync(betaDir)
  fs.mkdirSync(hiddenAlphaDir)
  fs.writeFileSync(alphaFile, 'hello')

  const payload = searchDirectoryPickerEntries({
    path: tempDir,
    query: 'alpha',
  })

  assert.equal(payload.items.some((item) => item.path === alphaDir), true)
  assert.equal(payload.items.some((item) => item.path === betaDir), false)
  assert.equal(payload.items.some((item) => item.path === hiddenAlphaDir), false)
  assert.equal(payload.items.some((item) => item.path === alphaFile), false)
})

test('listWorkspaceTree keeps project tmp directory visible', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-tree-'))
  const tmpDir = path.join(tempDir, 'tmp')
  const uploadsDir = path.join(tempDir, 'uploads')
  const nodeModulesDir = path.join(tempDir, 'node_modules')

  fs.mkdirSync(tmpDir)
  fs.mkdirSync(uploadsDir)
  fs.mkdirSync(nodeModulesDir)

  const payload = listWorkspaceTree(tempDir)

  assert.equal(payload.items.some((item) => item.path === 'tmp' && item.type === 'directory'), true)
  assert.equal(payload.items.some((item) => item.path === 'uploads' && item.type === 'directory'), true)
  assert.equal(payload.items.some((item) => item.path === 'node_modules'), false)
})

test('searchWorkspaceEntries keeps tmp files searchable', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-search-'))
  const screenshotPath = path.join(tempDir, 'tmp', 'screenshots', 'mobile.png')
  const hiddenPath = path.join(tempDir, 'node_modules', 'pkg', 'index.js')

  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true })
  fs.mkdirSync(path.dirname(hiddenPath), { recursive: true })
  fs.writeFileSync(screenshotPath, 'image')
  fs.writeFileSync(hiddenPath, 'export default 1')

  const payload = searchWorkspaceEntries(tempDir, {
    query: 'mobile',
  })

  assert.equal(payload.items.some((item) => item.path === 'tmp/screenshots/mobile.png'), true)
  assert.equal(payload.items.some((item) => item.path.includes('node_modules')), false)
})

test('searchWorkspaceFileContent finds text matches with line metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-content-search-'))
  const sourcePath = path.join(tempDir, 'src', 'main.ts')
  const hiddenPath = path.join(tempDir, 'node_modules', 'pkg', 'index.js')
  const binaryPath = path.join(tempDir, 'assets', 'icon.bin')

  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.mkdirSync(path.dirname(hiddenPath), { recursive: true })
  fs.mkdirSync(path.dirname(binaryPath), { recursive: true })

  fs.writeFileSync(sourcePath, 'const answer = 42\nconsole.log("needle here")\n', 'utf8')
  fs.writeFileSync(hiddenPath, 'needle in hidden dependency', 'utf8')
  fs.writeFileSync(binaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]))

  const payload = searchWorkspaceFileContent(tempDir, {
    query: 'needle',
  })

  assert.equal(payload.items.length, 1)
  assert.deepEqual(payload.items[0], {
    name: 'main.ts',
    path: 'src/main.ts',
    type: 'file',
    line: 2,
    column: 14,
    preview: 'console.log("needle here")',
  })
  assert.equal(payload.items.some((item) => item.path.includes('node_modules')), false)
})

test('searchWorkspaceFileContent dedupes repeated matches on the same line', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-content-dedupe-'))
  const sourcePath = path.join(tempDir, 'src', 'main.ts')

  fs.mkdirSync(path.dirname(sourcePath), { recursive: true })
  fs.writeFileSync(sourcePath, 'const needle = "needle needle"\n', 'utf8')

  const payload = searchWorkspaceFileContent(tempDir, {
    query: 'needle',
  })

  assert.equal(payload.items.length, 1)
  assert.equal(payload.items[0].line, 1)
  assert.equal(payload.items[0].column, 7)
})

test('readWorkspaceFileContent returns text preview for workspace file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-file-'))
  const filePath = path.join(tempDir, 'src', 'main.ts')

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'export const answer = 42\n', 'utf8')

  const payload = readWorkspaceFileContent(tempDir, {
    path: 'src/main.ts',
  })

  assert.equal(payload.path, 'src/main.ts')
  assert.equal(payload.language, 'typescript')
  assert.equal(payload.binary, false)
  assert.equal(payload.content, 'export const answer = 42\n')
})

test('readWorkspaceFileContent returns image preview for svg file', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-svg-'))
  const filePath = path.join(tempDir, 'assets', 'logo.svg')

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(
    filePath,
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#18ac71"/></svg>',
    'utf8'
  )

  const payload = readWorkspaceFileContent(tempDir, {
    path: 'assets/logo.svg',
  })

  assert.equal(payload.path, 'assets/logo.svg')
  assert.equal(payload.mimeType, 'image/svg+xml')
  assert.equal(payload.binary, true)
  assert.match(payload.previewUrl, /^data:image\/svg\+xml;base64,/)
  assert.equal(payload.content, '')
})

test('readWorkspaceFileContent detects language for extensionless python script by file name', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-pip3-'))
  const filePath = path.join(tempDir, 'bin', 'pip3')

  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, '#!/usr/bin/python3\nprint("hello")\n', 'utf8')

  const payload = readWorkspaceFileContent(tempDir, {
    path: 'bin/pip3',
  })

  assert.equal(payload.language, 'python')
  assert.equal(payload.binary, false)
})

test('readWorkspaceFileContent detects shell language variants', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-shell-variants-'))
  const fishPath = path.join(tempDir, 'scripts', 'hello.fish')
  const ps1Path = path.join(tempDir, 'scripts', 'hello.ps1')
  const cshPath = path.join(tempDir, 'scripts', 'hello.csh')

  fs.mkdirSync(path.dirname(fishPath), { recursive: true })
  fs.writeFileSync(fishPath, 'echo hello\n', 'utf8')
  fs.writeFileSync(ps1Path, 'Write-Host "hello"\n', 'utf8')
  fs.writeFileSync(cshPath, 'echo hello\n', 'utf8')

  assert.equal(readWorkspaceFileContent(tempDir, { path: 'scripts/hello.fish' }).language, 'fish')
  assert.equal(readWorkspaceFileContent(tempDir, { path: 'scripts/hello.ps1' }).language, 'powershell')
  assert.equal(readWorkspaceFileContent(tempDir, { path: 'scripts/hello.csh' }).language, 'bash')
})

test('readWorkspaceFileContent detects common style and config languages', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-style-config-'))
  const scssPath = path.join(tempDir, 'src', 'style.scss')
  const envPath = path.join(tempDir, '.env')
  const tomlPath = path.join(tempDir, 'config.toml')

  fs.mkdirSync(path.dirname(scssPath), { recursive: true })
  fs.writeFileSync(scssPath, '$color: #18ac71;\n.button { color: $color; }\n', 'utf8')
  fs.writeFileSync(envPath, 'PROMPTX_TEST=1\n', 'utf8')
  fs.writeFileSync(tomlPath, 'name = "promptx"\n', 'utf8')

  assert.equal(readWorkspaceFileContent(tempDir, { path: 'src/style.scss' }).language, 'scss')
  assert.equal(readWorkspaceFileContent(tempDir, { path: '.env' }).language, 'dotenv')
  assert.equal(readWorkspaceFileContent(tempDir, { path: 'config.toml' }).language, 'toml')
})

test('readWorkspaceFileContent blocks paths outside workspace', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-escape-'))

  assert.throws(() => {
    readWorkspaceFileContent(tempDir, {
      path: '../secret.txt',
    })
  }, /路径不合法|只能访问当前工作目录内的文件/)
})

test('readWorkspaceFileContent marks binary files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-workspace-binary-'))
  const filePath = path.join(tempDir, 'sample.bin')

  fs.writeFileSync(filePath, Buffer.from([0x00, 0x01, 0x02, 0x03, 0xff]))

  const payload = readWorkspaceFileContent(tempDir, {
    path: 'sample.bin',
  })

  assert.equal(payload.binary, true)
  assert.equal(payload.content, '')
})
