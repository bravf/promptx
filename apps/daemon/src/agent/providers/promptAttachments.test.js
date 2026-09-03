import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildCodexInput } from './codex.js'
import { buildClaudePrompt } from './claude.js'
import { buildAcpPrompt } from './acp.js'

test('Provider 将图片和文件转换成各自协议要求的输入', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-provider-assets-'))
  const imagePath = path.join(directory, 'image.png')
  fs.writeFileSync(imagePath, Buffer.from('image-bytes'))
  const content = [
    { type: 'text', text: '检查附件' },
    { type: 'image', name: 'image.png', mimeType: 'image/png', size: 11, absolutePath: imagePath },
    { type: 'file', name: 'config.json', mimeType: 'application/json', size: 12, absolutePath: '/tmp/config.json' },
  ]

  try {
    const codex = buildCodexInput(content)
    assert.deepEqual(codex[1], { type: 'localImage', path: imagePath })
    assert.match(codex[2].text, /Path: \/tmp\/config\.json/)

    const claudePrompt = await buildClaudePrompt(content)
    const { value: claudeMessage } = await claudePrompt[Symbol.asyncIterator]().next()
    assert.equal(claudeMessage.message.content[1].source.data, Buffer.from('image-bytes').toString('base64'))
    assert.match(claudeMessage.message.content[2].text, /Uploaded file: config\.json/)

    const acp = await buildAcpPrompt(content)
    assert.deepEqual(acp[1], {
      type: 'image',
      data: Buffer.from('image-bytes').toString('base64'),
      mimeType: 'image/png',
    })
    assert.match(acp[2].text, /MIME: application\/json/)
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
