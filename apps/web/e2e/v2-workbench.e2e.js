import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
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

async function availablePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return port
}

test('V2 桌面首屏与移动端 History 返回链路', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-v2-web-e2e-'))
  const assetsDir = path.join(root, 'uploads')
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const app = await createApp({
    databasePath: ':memory:',
    assetsDir,
    allowedOrigins: [baseUrl],
    logger: false,
    relay: false,
    relayOptions: {
      configPath: path.join(root, 'relay-config.json'),
      identityPath: path.join(root, 'relay-identity.json'),
    },
    webRoot,
    providerRegistry: providerRegistry(),
  })
  await app.listen({ host: '127.0.0.1', port })
  const browser = await chromium.launch({ headless: true })
  t.after(async () => {
    await browser.close()
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  const project = app.sqliteRepository.createProject({ repositoryRoot: root, displayName: '移动端回归工作区' })
  const environment = app.sqliteRepository.createEnvironment({ cwd: root, repositoryRoot: root, kind: 'local' })
  const task = app.sqliteRepository.createTask({ projectId: project.id, environmentId: environment.id, title: '移动端回归项目' })
  app.sqliteRepository.createAgent(task.id, { providerId: 'codex' })
  const switchedRoot = path.join(root, 'switched')
  fs.mkdirSync(switchedRoot)
  const switchedEnvironment = app.sqliteRepository.createEnvironment({ cwd: switchedRoot, repositoryRoot: root, kind: 'local' })
  const switchedTask = app.sqliteRepository.createTask({ projectId: project.id, environmentId: switchedEnvironment.id, title: '切换后的任务' })
  app.sqliteRepository.createAgent(switchedTask.id, { providerId: 'codex' })
  const turn = app.sqliteRepository.createTurn(task.id, 'e2e-welcome')
  app.sqliteRepository.updateTurn(turn.id, {
    status: 'completed',
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  })
  app.sqliteRepository.appendTimeline(task.id, turn.id, {
    type: 'assistant_message',
    messageId: 'welcome',
    phase: 'final_answer',
    text: 'V2 Timeline 已就绪',
  })

  const desktop = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  await desktop.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await desktop.getByText('V2 Timeline 已就绪').waitFor()
  assert.equal(await desktop.getByRole('button', { name: '新会话' }).isVisible(), true)

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

  await desktop.getByRole('button', { name: '在 移动端回归工作区 中新建会话' }).click()
  await desktop.getByLabel('任务标题').fill('界面创建会话')
  assert.equal(await desktop.getByLabel('执行位置').inputValue(), 'local')
  await desktop.getByRole('button', { name: '创建会话', exact: true }).click()
  await desktop.getByRole('button', { name: '界面创建会话', exact: true }).waitFor()
  await desktop.getByRole('button', { name: '删除 界面创建会话' }).click()
  await desktop.getByRole('button', { name: '删除', exact: true }).click()

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await mobile.goto(baseUrl, { waitUntil: 'domcontentloaded' })
  await mobile.getByText('移动端回归项目', { exact: true }).click()
  await mobile.getByText('V2 Timeline 已就绪').waitFor()
  assert.deepEqual(await mobile.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })), { width: 390, clientWidth: 390 })

  await mobile.goBack()
  await mobile.getByRole('button', { name: '新会话' }).waitFor()
  await mobile.getByRole('button', { name: '设置' }).click()
  await mobile.getByRole('heading', { name: '设置' }).waitFor()
  await mobile.goBack()
  await mobile.getByRole('button', { name: '新会话' }).waitFor()

  await desktop.getByRole('button', { name: '浏览文件' }).click()
  await desktop.waitForTimeout(300)
  const inspectorBox = await desktop.locator('.workspace-inspector').boundingBox()
  await desktop.getByRole('button', { name: '关闭抽屉' }).click()
  await desktop.getByRole('button', { name: '任务详情' }).click()
  await desktop.waitForTimeout(300)
  const detailsBox = await desktop.locator('.task-details-drawer').boundingBox()
  assert.deepEqual(detailsBox, inspectorBox)
  assert.equal(await desktop.getByText('任务操作', { exact: true }).count(), 0)
  await desktop.getByRole('button', { name: '切换后的任务', exact: true }).click()
  await desktop.locator('.task-details-drawer').getByRole('heading', { name: '切换后的任务', exact: true }).waitFor()
  await desktop.getByRole('button', { name: '关闭抽屉' }).click()
  await desktop.getByRole('button', { name: '删除 切换后的任务' }).click()
  await desktop.getByRole('button', { name: '删除', exact: true }).click()
  await desktop.getByRole('button', { name: '删除 移动端回归项目' }).click()
  await desktop.getByRole('button', { name: '删除', exact: true }).click()
  await desktop.getByText('新建一条会话', { exact: true }).waitFor({ timeout: 5_000 })
  assert.equal(app.sqliteRepository.getTask(task.id), null)
})
