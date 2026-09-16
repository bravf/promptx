import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { materializeHistoryImages } from './historyImages.js'
import { mapCodexHistorySnapshot, mapCodexRolloutSnapshot } from './providers/codexHistory.js'

test('Codex 本地图片导入、去重并在原文件清理后继续读取附件', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'promptx-history-images-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const image = path.join(directory, 'one.png')
  await fs.writeFile(image, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'))
  const assets = new Map()
  const options = { taskId: 'task', assetsDir: path.join(directory, 'assets'), repository: { getAsset: id => assets.get(id), createAsset: (_task, asset) => { assets.set(asset.id, asset); return asset } } }
  const snapshot = () => mapCodexHistorySnapshot({ id: 'thread', turns: [{ id: 'turn', status: 'completed', items: [{ id: 'user', type: 'userMessage', content: [{ type: 'text', text: '正文' }, { type: 'localImage', path: image }] }] }] })
  const first = await materializeHistoryImages(snapshot(), options)
  assert.equal(first.turns[0].items[0].item.content[1].type, 'image')
  await fs.rm(image)
  assert.deepEqual(await materializeHistoryImages(snapshot(), options), first)
  assert.equal(assets.size, 1)
  const bytes = await fs.readFile([...assets.values()][0].storagePath)
  const embedded = mapCodexRolloutSnapshot({ id: 'embedded' }, JSON.stringify({ type: 'response_item', payload: { type: 'message', id: 'm', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${bytes.toString('base64')}` }] } }))
  await materializeHistoryImages(embedded, options)
  assert.equal(embedded.turns[0].items[0].item.content[0].type, 'image')
  assert.equal(assets.size, 2)
})

test('旧版 rollout 保留图片，缺失文件降级且不读取普通文本路径', async () => {
  const records = [{ type: 'event_msg', payload: { type: 'task_started', turn_id: 't' } }, { type: 'event_msg', payload: { type: 'user_message', message: '/tmp/not-an-attachment.png', local_images: ['/missing/photo.png'] } }, { type: 'event_msg', payload: { type: 'task_complete', turn_id: 't' } }]
  const snapshot = mapCodexRolloutSnapshot({ id: 'thread' }, records.map(row => JSON.stringify(row)).join('\n'))
  await materializeHistoryImages(snapshot, { taskId: 'task', repository: { getAsset: () => null } })
  assert.deepEqual(snapshot.turns[0].items[0].item.content, [{ type: 'text', text: '/tmp/not-an-attachment.png' }, { type: 'text', text: '[原图片已不可用：photo.png]' }])
})
