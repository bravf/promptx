import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createApp } from '../../daemon/src/app.js'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const themeCases = [
  ['promptx-stone-light', 'light'],
  ['promptx-glass-light', 'light'],
  ['promptx-aqua-classic', 'light'],
  ['promptx-stone-dark', 'dark'],
  ['github-light', 'light'],
  ['promptx-wechat-light', 'light'],
  ['promptx-ink-landscape', 'light'],
  ['tokyo-night', 'dark'],
]

function providerRegistry() {
  const provider = {
    id: 'codex',
    label: 'Codex',
    capabilities: { models: true, reasoningEffort: true, contextUsage: true },
    createRuntime() {
      const runtime = new EventEmitter()
      runtime.getControlState = async () => ({
        models: [{ id: 'test-model', label: 'Test Model', reasoningEfforts: [{ id: 'low', label: '低' }] }],
        currentModelId: 'test-model',
        reasoningEfforts: [{ id: 'low', label: '低' }],
        currentReasoningEffort: 'low',
        contextUsage: { percentage: 0 },
      })
      runtime.readHistorySnapshot = async () => ({ status: 'unsupported' })
      runtime.startTurn = async () => ({})
      runtime.cancel = async () => {}
      runtime.close = () => {}
      return runtime
    },
  }
  return { list: () => [{ id: provider.id, label: provider.label, capabilities: provider.capabilities }], get: () => provider }
}

test('V2 桌面首屏与移动端 History 返回链路', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-v2-web-e2e-'))
  const assetsDir = path.join(root, 'uploads')
  const app = await createApp({
    databasePath: ':memory:',
    assetsDir,
    logger: false,
    relay: false,
    webRoot,
    providerRegistry: providerRegistry(),
  })
  await app.listen({ host: '127.0.0.1', port: 0 })
  const browser = await chromium.launch({ headless: true })
  t.after(async () => {
    await browser.close()
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const address = app.server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  const conversation = await app.inject({
    method: 'POST',
    url: '/api/v2/conversations',
    payload: { cwd: root, providerId: 'codex' },
  })
  const { agent } = conversation.json()
  app.sqliteRepository.updateAgent(agent.id, { title: '移动端回归项目', lifecycle: 'ready' })
  const turn = app.sqliteRepository.createTurn(agent.id, 'e2e-welcome')
  app.sqliteRepository.updateTurn(turn.id, {
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  })
  app.sqliteRepository.appendTimeline(agent.id, turn.id, {
    type: 'assistant_message',
    messageId: 'welcome',
    phase: 'final_answer',
    text: 'V2 Timeline 已就绪',
  })

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await desktop.getByText('V2 Timeline 已就绪').waitFor()
  assert.equal(await desktop.getByRole('button', { name: '新对话' }).isVisible(), true)

  for (const [themeId, mode] of themeCases) {
    await desktop.evaluate((id) => window.localStorage.setItem('promptx:theme-id', id), themeId)
    await desktop.reload({ waitUntil: 'domcontentloaded' })
    await desktop.getByText('V2 Timeline 已就绪').waitFor()
    const themeState = await desktop.evaluate(() => {
      const root = document.documentElement
      const panel = document.querySelector('.panel')
      return {
        themeId: root.dataset.theme,
        mode: root.style.colorScheme,
        appBackground: getComputedStyle(document.body).backgroundColor,
        panelBackground: panel ? getComputedStyle(panel).backgroundColor : '',
        width: root.scrollWidth,
        clientWidth: root.clientWidth,
      }
    })
    assert.equal(themeState.themeId, themeId)
    assert.equal(themeState.mode, mode)
    assert.notEqual(themeState.appBackground, 'rgba(0, 0, 0, 0)')
    assert.notEqual(themeState.panelBackground, 'rgba(0, 0, 0, 0)')
    assert.equal(themeState.width, themeState.clientWidth)
  }

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await mobile.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await mobile.getByText('移动端回归项目', { exact: true }).click()
  await mobile.getByText('V2 Timeline 已就绪').waitFor()
  assert.deepEqual(await mobile.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })), { width: 390, clientWidth: 390 })

  await mobile.goBack()
  await mobile.getByRole('button', { name: '新对话' }).waitFor()
  await mobile.getByRole('button', { name: '设置' }).click()
  await mobile.getByRole('heading', { name: '设置' }).waitFor()
  await mobile.goBack()
  await mobile.getByRole('button', { name: '新对话' }).waitFor()
})
