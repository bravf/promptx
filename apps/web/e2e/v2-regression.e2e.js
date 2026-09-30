import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createApp } from '../../daemon/src/app.js'
import { RelayService } from '../../daemon/src/relay/relayService.js'
import { startRelayServer } from '../../../packages/relay/src/server.js'
import { createLayout, openTab, splitGroup } from '../src/lib/workbenchTabs.js'
import { THEME_PRESETS } from '../src/lib/themes.js'

const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

function runGit(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
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

function providerRegistry(runtimeRecords) {
  const definitions = [
    { id: 'codex', label: 'Codex' },
    { id: 'claude', label: 'Claude Code' },
    { id: 'kimi', label: 'Kimi Code' },
    { id: 'grok', label: 'Grok' },
  ]
  const providers = new Map(definitions.map((definition) => {
    const provider = {
      ...definition,
      capabilities: { models: true, reasoningEffort: true, contextUsage: true },
      createRuntime(options = {}) {
        const runtime = new EventEmitter()
        runtime.threadId = options.nativeHandle?.threadId
        runtime.sessionId = options.nativeHandle?.sessionId
        let currentModelId = 'regression-model'
        let currentReasoningEffort = 'medium'
        const control = () => ({
          models: [
            { id: 'regression-model', label: 'Regression Model', reasoningEfforts: [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }], defaultReasoningEffort: 'medium' },
            { id: 'compact-model', label: 'Compact Model', reasoningEfforts: [{ id: 'low', label: '低' }], defaultReasoningEffort: 'low' },
          ],
          currentModelId,
          reasoningEfforts: currentModelId === 'compact-model'
            ? [{ id: 'low', label: '低' }]
            : [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }],
          currentReasoningEffort,
          contextUsage: { percentage: 75, usedTokens: 7500, maxTokens: 10000, updatedAt: new Date().toISOString() },
        })
        runtime.getControlState = async () => control()
        runtime.updateSettings = async (input) => {
          currentModelId = input.modelId || currentModelId
          currentReasoningEffort = input.reasoningEffort || currentReasoningEffort
          runtimeRecords.settings.push({ ...input })
          return control()
        }
        runtime.readHistorySnapshot = async () => {
          const sourceId = runtime.threadId || runtime.sessionId
          if (!sourceId) return { status: 'unsupported' }
          return {
            sourceId,
            revision: 'regression-history-1',
            turns: [{
              sourceTurnId: `${sourceId}:turn-1`,
              status: 'completed',
              startedAt: '2026-09-06T08:00:00.000Z',
              finishedAt: '2026-09-06T08:00:01.000Z',
              items: [
                { providerMessageId: `${sourceId}:user-1`, item: { type: 'user_message', clientMessageId: `${sourceId}:client-1`, content: [{ type: 'text', text: '导入回归首条消息' }] } },
                { providerMessageId: `${sourceId}:answer-1`, item: { type: 'assistant_message', messageId: `${sourceId}:answer-1`, phase: 'final_answer', text: '导入完成。' } },
              ],
            }],
          }
        }
        runtime.startTurn = async (content) => {
          const text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
          runtimeRecords.turns.push(content)
          await runtimeRecords.onTurn?.(text, runtime)
          runtime.emit('timeline', { type: 'reasoning', text: '正在执行回归测试请求' })
          if (!text.includes('保持运行')) {
            setTimeout(() => {
              runtime.emit('timeline', { type: 'assistant_message', phase: 'final_answer', text: `已处理：${text || '附件'}` })
              runtime.emit('turnCompleted', { usage: { inputTokens: 10, outputTokens: 5 } })
            }, 40)
          }
          return { nativeTurnId: `native-${runtimeRecords.turns.length}` }
        }
        runtime.cancel = async () => {
          runtimeRecords.canceled += 1
          runtime.emit('turnCanceled')
        }
        runtime.close = () => {}
        return runtime
      },
    }
    return [provider.id, provider]
  }))
  return {
    list: () => definitions.map(({ id, label }) => ({ id, label, capabilities: providers.get(id).capabilities })),
    get: (id) => {
      const provider = providers.get(id)
      if (!provider) throw new Error(`未知 Provider：${id}`)
      return provider
    },
  }
}

function seedWorkspace(root, repository) {
  const workspace = path.join(root, 'workspace')
  fs.mkdirSync(path.join(workspace, 'src'), { recursive: true })
  fs.writeFileSync(path.join(workspace, 'README.md'), '# PromptX\n\n初始内容\n')
  fs.writeFileSync(path.join(workspace, 'src', 'main.js'), 'export const answer = 42\n')
  fs.writeFileSync(path.join(workspace, '.hidden-note'), '隐藏文件\n')
  fs.writeFileSync(path.join(workspace, 'pixel.png'), png)
  fs.writeFileSync(path.join(workspace, 'binary.bin'), Buffer.from([0, 1, 2, 3, 255]))
  fs.writeFileSync(path.join(workspace, 'large.txt'), Buffer.alloc(2 * 1024 * 1024 + 1, 65))

  runGit(workspace, ['init', '-b', 'main'])
  runGit(workspace, ['config', 'user.name', 'PromptX Regression'])
  runGit(workspace, ['config', 'user.email', 'regression@promptx.local'])
  runGit(workspace, ['add', '.'])
  runGit(workspace, ['commit', '-m', 'initial'])
  fs.appendFileSync(path.join(workspace, 'README.md'), '工作区修改\n')
  fs.writeFileSync(path.join(workspace, 'staged.txt'), 'staged content\n')
  runGit(workspace, ['add', 'staged.txt'])
  fs.writeFileSync(path.join(workspace, 'untracked.txt'), 'untracked content\n')

  const project = repository.createProject({ repositoryRoot: workspace, displayName: '全面回归工作区', defaultBranch: 'main' })
  const environment = repository.createEnvironment({ cwd: workspace, repositoryRoot: workspace, kind: 'local' })
  const task = repository.createTask({ projectId: project.id, environmentId: environment.id, title: '主回归会话' })
  repository.createAgent(task.id, { providerId: 'codex', modelId: 'regression-model', config: { reasoningEffort: 'medium' } })

  const secondaryEnvironment = repository.createEnvironment({ cwd: workspace, repositoryRoot: workspace, kind: 'local' })
  const secondaryTask = repository.createTask({ projectId: project.id, environmentId: secondaryEnvironment.id, title: '草稿切换会话' })
  repository.createAgent(secondaryTask.id, { providerId: 'claude' })

  const turn = repository.createTurn(task.id, 'seed-turn')
  const startedAt = new Date(Date.now() - 2500).toISOString()
  const finishedAt = new Date().toISOString()
  repository.updateTurn(turn.id, { status: 'completed', startedAt, finishedAt })
  repository.appendTimeline(task.id, turn.id, {
    type: 'user_message',
    clientMessageId: 'seed-turn',
    content: [{ type: 'text', text: '请检查现有实现' }],
  })
  repository.appendTimeline(task.id, turn.id, { type: 'reasoning', text: '先分析代码结构' })
  repository.appendTimeline(task.id, turn.id, {
    type: 'tool_call',
    callId: 'tool-1',
    name: '读取文件',
    status: 'completed',
    detail: { type: 'read', path: path.join(workspace, 'src', 'main.js'), line: 1 },
  })
  repository.appendTimeline(task.id, turn.id, {
    type: 'tool_call',
    callId: 'tool-2',
    name: '文件修改',
    status: 'completed',
    detail: { type: 'fileChange', changes: [
      { path: path.join(workspace, 'README.md') },
      { path: path.join(workspace, 'src', 'main.js') },
    ] },
  })
  repository.appendTimeline(task.id, turn.id, {
    type: 'todo',
    items: [{ text: '检查功能', status: 'completed' }, { text: '执行测试', status: 'in_progress' }],
  })
  repository.appendTimeline(task.id, turn.id, {
    type: 'assistant_message',
    messageId: 'seed-answer',
    phase: 'final_answer',
    text: '回归基线已经准备完成。',
  })
  return { workspace, project, task, secondaryTask }
}

async function createFixture(t, { allowedOrigins, onRequest } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-full-regression-')))
  const runtimeRecords = { settings: [], turns: [], canceled: 0 }
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const app = await createApp({
    allowedOrigins,
    databasePath: ':memory:',
    assetsDir: path.join(root, 'uploads'),
    logger: false,
    relay: false,
    webRoot,
    providerRegistry: providerRegistry(runtimeRecords),
    sessionImportOptions: {
      cacheTtlMs: 0,
      historyLoaders: {
        codex: async () => [{
          providerId: 'codex',
          providerHandleId: 'codex-import-regression',
          cwd: path.join(root, 'workspace'),
          title: '可导入 Codex 会话',
          firstPromptPreview: '导入回归首条消息',
          lastPromptPreview: '导入回归最新消息',
          lastActivityAt: '2026-09-06T08:00:00.000Z',
        }],
        claude: async () => [{
          providerId: 'claude',
          providerHandleId: 'claude-import-regression',
          cwd: '',
          title: '无目录 Claude 会话',
          firstPromptPreview: '缺少目录',
          lastActivityAt: '2026-09-05T08:00:00.000Z',
        }],
        kimi: async () => { throw new Error('Kimi CLI 未安装') },
        grok: async () => [{
          providerId: 'grok',
          providerHandleId: 'grok-import-regression',
          cwd: path.join(root, 'workspace'),
          title: '可导入 Grok 会话',
          firstPromptPreview: 'Grok 导入预览',
          lastActivityAt: '2026-09-06T07:00:00.000Z',
        }],
      },
    },
    relayOptions: {
      configPath: path.join(root, 'relay-config.json'),
      identityPath: path.join(root, 'relay-identity.json'),
    },
  })
  const seeded = seedWorkspace(root, app.sqliteRepository)
  if (onRequest) app.addHook('onRequest', onRequest)
  await app.listen({ host: '127.0.0.1', port })
  const browser = await chromium.launch({ headless: true })
  t.after(async () => {
    await browser.close()
    await app.close()
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, baseUrl, app, browser, runtimeRecords, ...seeded }
}

function collectPageFailures(page) {
  const failures = []
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`))
  page.on('console', (message) => {
    if (message.type() === 'error') failures.push(`console: ${message.text()}`)
  })
  return failures
}

function consumeExpectedResourceError(failures) {
  const index = failures.findIndex((message) => message.includes('Failed to load resource: the server responded with a status of'))
  assert.notEqual(index, -1, '预期浏览器记录一次失败的 HTTP 请求')
  failures.splice(index, 1)
}

async function assertNoHorizontalOverflow(page) {
  const dimensions = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
  assert.equal(dimensions.scrollWidth, dimensions.clientWidth)
}

async function saveScreenshot(page, name) {
  const outputDir = process.env.PROMPTX_REGRESSION_SCREENSHOT_DIR
  if (!outputDir) return
  fs.mkdirSync(outputDir, { recursive: true })
  await page.evaluate(async () => {
    const animations = document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity)
    let timer
    try {
      // 暂停的有限动画可能永不结束，最多等待 2 秒后继续截图。
      await Promise.race([
        Promise.allSettled(animations.map(animation => animation.finished)),
        new Promise(resolve => { timer = setTimeout(resolve, 2000) }),
      ])
    } finally { clearTimeout(timer) }
  })
  await page.screenshot({ path: path.join(outputDir, name), fullPage: true })
}

test('新增配色在桌面和手机可切换、刷新恢复，旧主题不残留新主题 token', { timeout: 120000 }, async t => {
  const fixture = await createFixture(t)
  const themes = THEME_PRESETS.filter(theme => theme.id.startsWith('tweakcn-'))
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl)
  for (const theme of themes) {
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.locator('.theme-option').filter({ hasText: theme.shortName }).click()
    await saveScreenshot(page, `${theme.id}-settings.png`)
    await page.reload()
    await page.locator('.theme-option-active').filter({ hasText: theme.shortName }).waitFor()
    assert.equal(await page.locator('html').getAttribute('data-theme'), theme.id)
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), theme.mode === 'dark')
    await page.getByRole('button', { name: '关闭标签 设置', exact: true }).click()
    await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    await saveScreenshot(page, `${theme.id}-timeline.png`)
    await page.getByRole('button', { name: '查看 Diff', exact: true }).click()
    await page.locator('.workspace-inspector:visible button[title="README.md"]').click()
    await page.getByText('+工作区修改', { exact: true }).waitFor()
    await saveScreenshot(page, `${theme.id}-diff.png`)
    await page.getByRole('button', { name: '关闭标签 Diff · 主回归会话', exact: true }).click()
    await assertNoHorizontalOverflow(page)
  }
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: 'Stone Light' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-shellGradient')), '')
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-primaryIcon')), '')
  await page.getByRole('button', { name: 'Glass Light' }).click()
  await page.locator('.theme-option').filter({ hasText: themes[0].shortName }).click()
  assert.equal(await page.evaluate(() => document.documentElement.style.getPropertyValue('--theme-backdropBlur')), '0px')
  assert.deepEqual(failures, [])
  await page.close()

  const mobile = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await mobile.goto(fixture.baseUrl)
  for (const theme of themes) {
    await mobile.getByRole('button', { name: '设置', exact: true }).click()
    await mobile.locator('.theme-option').filter({ hasText: theme.shortName }).click()
    await mobile.reload()
    await mobile.locator('.theme-option-active').filter({ hasText: theme.shortName }).waitFor()
    assert.equal(await mobile.locator('html').getAttribute('data-theme'), theme.id)
    await mobile.getByRole('button', { name: '关闭设置', exact: true }).click()
    await mobile.getByRole('link', { name: '主回归会话', exact: true }).click()
    await mobile.getByText('回归基线已经准备完成。').waitFor()
    await saveScreenshot(mobile, `${theme.id}-mobile.png`)
    await assertNoHorizontalOverflow(mobile)
    await mobile.getByRole('button', { name: '返回项目列表', exact: true }).click()
  }
})

test('短 Timeline 上滚不显示回到底部，增高仍跟随，内容收起后隐藏箭头', async t => {
  const fixture = await createFixture(t)
  for (const mobile of [false, true]) {
    const page = await fixture.browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 1000 }, isMobile: mobile })
    await page.goto(fixture.baseUrl)
    if (mobile) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    const timeline = page.locator('.timeline:visible')
    assert.equal(await timeline.evaluate(el => el.scrollHeight <= el.clientHeight), true)
    await timeline.dispatchEvent('wheel', { deltaY: -100, deltaX: 0 })
    await timeline.dispatchEvent('touchstart', { touches: [{ identifier: 1, clientY: 100 }] })
    await timeline.dispatchEvent('touchmove', { touches: [{ identifier: 1, clientY: 180 }] })
    await timeline.focus()
    await page.keyboard.press('PageUp')
    assert.equal(await page.locator('.timeline-jump-button').count(), 0)
    // 未发生真实滚动的手势不能暂停后续异步排版的跟随。
    await timeline.locator(':scope > .mx-auto').evaluate(el => {
      const spacer = document.createElement('div')
      spacer.className = 'test-overflow'
      spacer.style.height = '1600px'
      el.append(spacer)
    })
    await page.waitForFunction(() => [...document.querySelectorAll('.timeline')].some(el => el.clientHeight > 0 && el.scrollTop > 500 && el.scrollHeight - el.clientHeight - el.scrollTop <= 2))
    await timeline.press('PageUp')
    await page.locator('.timeline-jump-button').waitFor()
    await timeline.locator('.test-overflow').evaluate(el => el.remove())
    await page.locator('.timeline-jump-button').waitFor({ state: 'detached' })
    await page.close()
  }
})

test('工作区侧栏支持拖动、键盘和重置，刷新记住宽度且窄屏不挤占会话', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  const divider = page.getByRole('separator', { name: '调整工作区侧栏宽度' })
  const sidebar = page.locator('.workspace-sidebar')
  assert.equal(Math.round((await sidebar.boundingBox()).width), 240)
  const handle = await divider.boundingBox()
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
  await page.mouse.down()
  await page.mouse.move(handle.x + handle.width / 2 + 180, handle.y + 100, { steps: 8 })
  await page.mouse.up()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 420)
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 420)
  await page.reload()
  await divider.waitFor()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 420)
  await divider.press('End')
  assert.equal(Math.round((await sidebar.boundingBox()).width), 520)
  await page.setViewportSize({ width: 800, height: 900 })
  await page.waitForFunction(() => document.querySelector('.workspace-sidebar').getBoundingClientRect().width < 520)
  assert.ok((await page.locator('.timeline-workspace').boundingBox()).width >= 360)
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await divider.waitFor({ state: 'hidden' })
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByText('回归基线已经准备完成。').filter({ visible: true }).waitFor()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 390)
  await assertNoHorizontalOverflow(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await divider.waitFor()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 520)
  await divider.press('Home')
  assert.equal(Math.round((await sidebar.boundingBox()).width), 180)
  await divider.press('ArrowRight')
  assert.equal(Math.round((await sidebar.boundingBox()).width), 190)
  await divider.dblclick()
  assert.equal(Math.round((await sidebar.boundingBox()).width), 240)
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:v2:sidebar-width')), null)
  await page.setViewportSize({ width: 860, height: 900 })
  await page.waitForFunction(() => document.querySelector('.workspace-sidebar').getBoundingClientRect().width === 200)
})

test('V2 全面桌面交互回归', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByText('回归基线已经准备完成。').waitFor()
  await assertNoHorizontalOverflow(page)

  const processToggle = page.getByRole('button', { name: /耗时/ })
  await processToggle.click()
  await page.getByText('先分析代码结构').waitFor()
  await page.getByText('读取文件', { exact: true }).waitFor()
  await page.locator('.workspace-path-link[title="查看当前 Diff：src/main.js"]').last().click()
  await page.getByText('没有可显示的文本 Diff', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('正在加载 Diff').filter({ visible: true }).count(), 0)
  await page.getByRole('button', { name: '关闭标签 Diff · 主回归会话', exact: true }).click()
  await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
  await page.locator('.workspace-path-link[title="查看当前 Diff：README.md"]').click()
  await page.getByText('+工作区修改', { exact: true }).waitFor()
  assert.equal(await page.getByText('只能访问工作区内的相对路径。', { exact: true }).count(), 0)
  await page.getByRole('button', { name: '关闭标签 Diff · 主回归会话', exact: true }).click()
  await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
  await page.getByText('执行测试', { exact: true }).waitFor()

  await page.getByRole('button', { name: '浏览文件' }).click()
  const filesDrawer = page.locator('.workspace-inspector:visible')
  await filesDrawer.waitFor()
  for (const [file, content] of [['README.md', '工作区修改'], ['pixel.png', ''], ['binary.bin', '二进制文件暂不支持预览'], ['large.txt', '文件过大，暂不支持预览']]) {
    await filesDrawer.locator(`button[title="${file}"]`).click()
    if (content) await page.getByText(content, { exact: true }).filter({ visible: true }).waitFor()
    else await page.getByAltText('pixel.png').waitFor()
    assert.equal(await page.getByRole('tab', { name: file, exact: true }).count(), 0)
    assert.equal(await filesDrawer.locator('.file-tree').isVisible(), true)
  }
  assert.equal(await filesDrawer.locator('button[title=".hidden-note"]').count(), 0)
  await filesDrawer.getByTitle('显示点文件').click()
  await filesDrawer.locator('button[title=".hidden-note"]').waitFor()
  await page.locator('.workbench-group.is-focused .workbench-tab.is-active').getByRole('button', { name: /^关闭标签 / }).click()
  await page.getByRole('button', { name: '查看 Diff', exact: true }).click()
  const diffDrawer = page.locator('.workspace-inspector:visible')
  await diffDrawer.getByText('main', { exact: true }).waitFor()
  for (const [file, content] of [['README.md', '+工作区修改'], ['staged.txt', '+staged content'], ['untracked.txt', '+untracked content']]) {
    await diffDrawer.locator(`button[title="${file}"]`).click()
    await page.getByText(content, { exact: true }).waitFor()
    await saveScreenshot(page, 'desktop-diff.png')
    assert.equal(await page.getByRole('tab', { name: `${file} · Diff`, exact: true }).count(), 0)
    assert.equal(await diffDrawer.locator('.changes-list').isVisible(), true)
  }
  await page.locator('.workbench-group.is-focused .workbench-tab.is-active').getByRole('button', { name: /^关闭标签 / }).click()
  await page.getByRole('button', { name: '任务详情', exact: true }).click()
  await page.locator('.task-details-drawer').getByRole('heading', { name: '主回归会话' }).waitFor()
  await page.getByText('3 个未提交文件', { exact: true }).waitFor()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  await page.locator('.task-details-drawer').waitFor({ state: 'hidden' })

  const textarea = page.getByPlaceholder('向 Agent 发送消息').filter({ visible: true })
  await textarea.fill('第二会话草稿')
  await page.locator('.task-navigation[title^="主回归会话 ·"]').click()
  await textarea.fill('主会话草稿')
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  assert.equal(await textarea.inputValue(), '第二会话草稿')
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  assert.equal(await textarea.inputValue(), '主会话草稿')
  await textarea.fill('')

  assert.equal((await page.getByLabel('模型').filter({ visible: true }).textContent()).trim(), 'Regression Model')
  assert.equal((await page.getByLabel('思考强度').filter({ visible: true }).textContent()).trim(), '中')
  await page.getByLabel('模型').filter({ visible: true }).press('ArrowDown')
  await page.getByLabel('模型').filter({ visible: true }).press('ArrowDown')
  await page.getByLabel('模型').filter({ visible: true }).press('Enter')
  assert.equal((await page.getByLabel('模型').filter({ visible: true }).textContent()).trim(), 'Compact Model')
  await page.getByLabel('思考强度').filter({ visible: true }).click()
  await page.getByRole('option', { name: '低', exact: true }).click()
  assert.equal(fixture.runtimeRecords.settings.at(-1).reasoningEffort, 'low')
  await page.getByLabel('上下文窗口已使用 75%').filter({ visible: true }).waitFor()

  const fileInput = page.locator('.workbench-content:visible input[type="file"]')
  await fileInput.setInputFiles({ name: 'upload.png', mimeType: 'image/png', buffer: png })
  await page.getByText('upload.png', { exact: true }).waitFor()
  await page.getByTitle('预览图片').filter({ visible: true }).click()
  await page.getByTitle('关闭预览').filter({ visible: true }).click()
  await page.getByTitle('移除附件').filter({ visible: true }).click()

  await page.route('**/api/v2/tasks/*/assets', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'upload_failed', message: '模拟上传失败' }) })
  })
  await fileInput.setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') })
  await page.getByText('模拟上传失败', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await page.unroute('**/api/v2/tasks/*/assets')
  await page.getByTitle('重试').filter({ visible: true }).click()
  await page.getByText('5 B', { exact: true }).waitFor()
  await page.getByTitle('移除附件').filter({ visible: true }).click()

  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"]')
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'oversize.bin', { type: 'application/octet-stream' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.getByText('附件不能超过 50 MB。', { exact: true }).waitFor()
  assert.equal(await page.getByTitle('重试').filter({ visible: true }).count(), 0)
  await page.getByTitle('移除附件').filter({ visible: true }).click()

  const timeline = page.locator('.timeline:visible')
  await timeline.evaluate((element) => {
    const spacer = document.createElement('div')
    spacer.style.height = '1000px'
    spacer.setAttribute('aria-hidden', 'true')
    element.append(spacer)
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
    element.scrollTop = 0
    element.dispatchEvent(new Event('scroll'))
  })
  const jumpButton = page.getByRole('button', { name: '回到底部', exact: true })
  await jumpButton.waitFor()
  const jumpButtonStyle = await jumpButton.evaluate((element) => {
    const style = getComputedStyle(element)
    const timelineStyle = getComputedStyle(document.querySelector('.timeline'))
    return {
      backgroundColor: style.backgroundColor,
      timelineBackgroundColor: timelineStyle.backgroundColor,
      borderStyle: style.borderTopStyle,
      borderWidth: style.borderTopWidth,
      boxShadow: style.boxShadow,
    }
  })
  assert.notEqual(jumpButtonStyle.backgroundColor, jumpButtonStyle.timelineBackgroundColor)
  assert.deepEqual([jumpButtonStyle.borderStyle, jumpButtonStyle.borderWidth], ['solid', '1px'])
  assert.notEqual(jumpButtonStyle.boxShadow, 'none')

  await textarea.fill('正常发送回归')
  await page.getByTitle('发送').filter({ visible: true }).click()
  await page.getByText('已处理：正常发送回归', { exact: true }).waitFor()
  assert.equal(await textarea.inputValue(), '')
  await textarea.fill('保持运行')
  await page.getByTitle('发送').filter({ visible: true }).click()
  await page.getByTitle('停止').filter({ visible: true }).waitFor()
  const runningJumpButton = page.getByRole('button', { name: '正在生成，回到底部', exact: true })
  await runningJumpButton.waitFor()
  assert.equal(await runningJumpButton.locator('.timeline-jump-loading-dot').count(), 3)
  assert.notEqual(await runningJumpButton.locator('.timeline-jump-loading-dot').first().evaluate((element) => getComputedStyle(element).animationName), 'none')
  assert.equal(await page.getByLabel('模型').filter({ visible: true }).isDisabled(), true)
  await page.getByTitle('停止').filter({ visible: true }).click()
  await page.getByTitle('发送').filter({ visible: true }).waitFor()
  assert.equal(fixture.runtimeRecords.canceled, 1)

  await page.getByRole('button', { name: '全面回归工作区 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click()
  assert.equal(await page.getByRole('combobox', { name: '目录 选择目录' }).inputValue(), fixture.workspace)
  assert.equal(await page.getByRole('radio', { name: '当前目录', exact: true }).isChecked(), true)
  await page.getByText('新建 Worktree', { exact: true }).click()
  await page.getByLabel('基线').filter({ visible: true }).waitFor()
  await page.getByPlaceholder('Worktree 名称', { exact: true }).waitFor()
  await page.getByText('当前目录', { exact: true }).click()
  await page.getByRole('combobox', { name: '目录 选择目录' }).fill(path.join(fixture.root, 'missing-directory'))
  await page.getByRole('button', { name: '创建会话', exact: true }).click()
  await page.getByText('工作区路径不存在或无法访问。', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await page.getByRole('button', { name: '关闭', exact: true }).click()

  await page.getByRole('button', { name: '全面回归工作区 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click()
  await page.getByLabel('任务标题').filter({ visible: true }).fill('界面新增会话')
  await page.getByRole('button', { name: '创建会话', exact: true }).click()
  await page.getByRole('link', { name: '界面新增会话', exact: true }).waitFor()
  await page.getByRole('button', { name: '界面新增会话 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('link', { name: '界面新增会话', exact: true }).waitFor()
  await page.getByRole('button', { name: '界面新增会话 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
  await page.getByRole('button', { name: '归档', exact: true }).click()
  await page.getByRole('link', { name: '界面新增会话', exact: true }).waitFor({ state: 'detached' })

  await page.getByRole('button', { name: '导入会话' }).click()
  await page.getByText('可导入 Codex 会话', { exact: true }).waitFor()
  await page.getByText('Kimi Code：Kimi CLI 未安装', { exact: true }).waitFor()
  await page.getByPlaceholder('搜索标题、目录、Session ID 或首条消息').fill('不存在的会话')
  await page.getByText('没有可导入的会话', { exact: true }).waitFor()
  await page.getByLabel('清空搜索').filter({ visible: true }).click()
  await page.getByText('可导入 Codex 会话', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.getByText('可导入 Codex 会话', { exact: true }).click()
  await page.getByRole('link', { name: '可导入 Codex 会话', exact: true }).waitFor()

  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'Tokyo Night' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'tokyo-night')
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:theme-id')), 'tokyo-night')
  await page.getByRole('button', { name: '远程访问', exact: true }).click()
  const relayAddress = page.getByLabel('Relay 地址').filter({ visible: true })
  await relayAddress.fill('invalid-relay-url')
  await relayAddress.blur()
  await page.getByText('Relay 地址格式无效。', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await relayAddress.fill('ws://127.0.0.1:9999/relay')
  await relayAddress.blur()
  const relayToggle = page.locator('.relay-toggle input')
  if (!(await relayToggle.isChecked())) await relayToggle.check()
  await page.getByRole('button', { name: '显示配对链接', exact: true }).click()
  await page.getByText('配对链接', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置远程身份' }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '关于', exact: true }).click()
  await page.getByText('本地 AI 编程工作台', { exact: true }).waitFor()
  await page.waitForTimeout(250)
  await saveScreenshot(page, 'desktop-settings.png')
  await page.getByRole('button', { name: '关闭标签 设置', exact: true }).click()
  await assertNoHorizontalOverflow(page)
  assert.deepEqual(failures, [])
})

test('归档确认长网址不遮挡关闭按钮，窄屏与横屏保持操作可见', async (t) => {
  const fixture = await createFixture(t)
  const title = 'https://docs.volcengine.com/docs/ark/seedance-model-activation?reference=' + 'a'.repeat(160)
  fixture.app.sqliteRepository.updateTask(fixture.task.id, { title })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 844, height: 390 }, { width: 498, height: 229 }]) {
    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    await page.addInitScript(() => localStorage.setItem('promptx:theme-id', 'promptx-paper-orange'))
    await page.goto(fixture.baseUrl)
    const more = page.getByRole('button', { name: `${title} 的更多操作`, exact: true })
    await more.click()
    await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
    const dialog = page.locator('.confirm-dialog-panel')
    await dialog.waitFor()
    // 点击校验同时等待过渡结束，并确认所有操作按钮都可命中。
    for (const name of ['关闭', '取消', '归档']) await dialog.getByRole('button', { name, exact: true }).click({ trial: true })
    const layout = await dialog.evaluate(element => {
      const box = element.getBoundingClientRect()
      const titleBox = element.querySelector('h2').getBoundingClientRect()
      const closeBox = element.querySelector('[aria-label="关闭"]').getBoundingClientRect()
      return {
        fits: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1,
        overflow: [...element.querySelectorAll('h2, p')].some(node => node.scrollWidth > node.clientWidth + 1),
        overlap: titleBox.right > closeBox.left,
        topAligned: Math.abs(titleBox.top - closeBox.top) < 2,
      }
    })
    assert.deepEqual(layout, { fits: true, overflow: false, overlap: false, topAligned: true })
    await saveScreenshot(page, `confirm-long-title-${viewport.width}.png`)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(fixture.app.sqliteRepository.getTask(fixture.task.id).lifecycle, 'active')
    await more.click()
    await page.getByRole('menuitem', { name: '归档会话', exact: true }).click()
    await dialog.getByRole('button', { name: '关闭', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('导入长会话列表在手机竖横屏均可触摸滚到底并导入末项', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const failures = collectPageFailures(page)
  await page.route('**/api/v2/import/sessions?*', async route => {
    const response = await route.fetch()
    const result = await response.json()
    const target = result.sessions.find(session => session.providerHandleId === 'codex-import-regression')
    await route.fulfill({ response, json: { ...result, sessions: [
      ...Array.from({ length: 40 }, (_, index) => ({ ...target, providerHandleId: `scroll-fixture-${index}`, title: `滚动测试会话 ${index + 1}` })),
      target,
    ] } })
  })
  await page.goto(fixture.baseUrl)
  await page.getByRole('button', { name: '导入会话', exact: true }).click()
  const list = page.locator('.import-dialog-panel .overflow-y-auto')
  await page.getByText('可导入 Codex 会话', { exact: true }).waitFor()
  const cdp = await page.context().newCDPSession(page)
  for (const viewport of [{ width: 390, height: 844 }, { width: 844, height: 390 }, { width: 390, height: 600 }]) {
    await page.setViewportSize(viewport)
    await page.waitForFunction(() => !document.querySelector('.import-dialog-panel').getAnimations().some(animation => animation.playState === 'running'))
    const geometry = await list.evaluate(element => {
      const box = element.getBoundingClientRect()
      return { top: box.top, bottom: box.bottom, height: element.clientHeight, total: element.scrollHeight }
    })
    assert.ok(geometry.height > 0 && geometry.total > geometry.height, '列表必须具有独立滚动空间')
    assert.ok(geometry.top >= 0 && geometry.bottom <= viewport.height, `列表底部必须位于屏幕内：${JSON.stringify({ viewport, geometry })}`)
    const search = page.getByPlaceholder('搜索标题、目录、Session ID 或首条消息')
    const searchTop = (await search.boundingBox()).y
    const bounds = await list.boundingBox()
    await cdp.send('Input.synthesizeScrollGesture', {
      x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height * 0.8),
      yDistance: -5000, speed: 10000, gestureSourceType: 'touch',
    })
    await page.waitForFunction(() => {
      const element = document.querySelector('.import-dialog-panel .overflow-y-auto')
      return element.scrollTop + element.clientHeight >= element.scrollHeight - 2
    })
    assert.equal((await search.boundingBox()).y, searchTop, '搜索栏应保持固定')
    const last = await page.getByText('可导入 Codex 会话', { exact: true }).boundingBox()
    assert.ok(last.y >= 0 && last.y + last.height <= viewport.height)
    await assertNoHorizontalOverflow(page)
  }
  await saveScreenshot(page, 'mobile-import-scroll-bottom.png')
  await page.getByText('可导入 Codex 会话', { exact: true }).tap()
  await page.locator('.import-dialog-panel').waitFor({ state: 'detached' })
  await page.getByText('导入完成。', { exact: true }).waitFor()
  assert.deepEqual(failures, [])
})

test('V2 移动端布局、弹层和 History 回归', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.waitForTimeout(300)
  await assertNoHorizontalOverflow(page)
  await saveScreenshot(page, 'mobile-timeline.png')
  await page.getByTitle('浏览文件').click()
  await page.locator('.workspace-inspector').waitFor()
  await page.waitForTimeout(300)
  await assertNoHorizontalOverflow(page)
  await saveScreenshot(page, 'mobile-files.png')
  await page.getByTitle(/^关闭(抽屉|标签页)$/).click()

  await page.getByTitle('返回项目列表').click()
  await page.getByRole('button', { name: '设置' }).click()
  const settingsBox = await page.locator('.v2-settings-panel').boundingBox()
  assert.equal(Math.round(settingsBox.width), 390)
  assert.equal(Math.round(settingsBox.height), 844)
  await page.goBack()
  await page.getByRole('button', { name: '新会话' }).waitFor()

  await page.getByRole('button', { name: '新会话' }).click()
  const conversationBox = await page.locator('.new-conversation-panel').boundingBox()
  assert.equal(Math.round(conversationBox.width), 390)
  assert.ok(conversationBox.height > 0 && conversationBox.height <= 844)
  const createButtonStyle = await page.getByRole('button', { name: '创建会话', exact: true }).evaluate((element) => {
    const style = window.getComputedStyle(element)
    return { backgroundColor: style.backgroundColor, borderWidth: style.borderWidth }
  })
  assert.notEqual(createButtonStyle.backgroundColor, 'rgba(0, 0, 0, 0)')
  assert.equal(createButtonStyle.borderWidth, '1px')
  await page.goBack()
  await page.getByRole('button', { name: '导入会话' }).click()
  const importBox = await page.locator('.import-dialog-panel').boundingBox()
  assert.equal(Math.round(importBox.width), 390)
  assert.equal(Math.round(importBox.height), 844)
  await page.waitForTimeout(250)
  await saveScreenshot(page, 'mobile-import.png')
  await page.goBack()
  await page.getByRole('button', { name: '新会话' }).waitFor()
  await assertNoHorizontalOverflow(page)
  assert.deepEqual(failures, [])
})

test('新建会话失败时关闭目录建议，桌面和移动端错误提示均无遮挡', async (t) => {
  const fixture = await createFixture(t)
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    await page.route('**/api/v2/projects/*/tasks', async (route) => {
      if (route.request().method() !== 'POST') return route.continue()
      return route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'invalid_request', message: '模拟创建失败，请检查会话配置。' }) })
    })
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    await page.getByRole('combobox', { name: '目录 选择目录' }).fill(fixture.workspace)
    await page.getByRole('listbox').waitFor()
    await page.getByRole('option').first().waitFor()
    await page.getByRole('button', { name: '创建会话', exact: true }).click()
    const alert = page.getByRole('alert')
    await alert.getByText('模拟创建失败，请检查会话配置。', { exact: true }).waitFor()
    await page.getByRole('listbox').waitFor({ state: 'detached' })
    assert.equal(await alert.evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2))
    }), true)
    await saveScreenshot(page, `create-error-visible-${viewport.width}.png`)
    consumeExpectedResourceError(failures)
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('Timeline 报告链接打开文件抽屉且不跳转或新开页面', async (t) => {
  const fixture = await createFixture(t)
  const documents = [
    { label: '测试计划', name: 'test-plan-2026-09-06.md', content: '测试计划回归内容' },
    { label: '完整报告', name: 'qa-report-2026-09-06.md', content: '完整报告回归内容' },
  ]
  fs.mkdirSync(path.join(fixture.workspace, 'docs'))
  const links = documents.map((document) => {
    const absolutePath = path.join(fixture.workspace, 'docs', document.name).replaceAll('\\', '/')
    fs.writeFileSync(absolutePath, document.content)
    const href = absolutePath.startsWith('/') ? absolutePath : `/${absolutePath}`
    return `[${document.label}](${href})`
  })
  const turn = fixture.app.sqliteRepository.createTurn(fixture.task.id, 'report-link-regression')
  fixture.app.sqliteRepository.updateTurn(turn.id, { status: 'completed' })
  fixture.app.sqliteRepository.appendTimeline(fixture.task.id, turn.id, {
    type: 'assistant_message', phase: 'final_answer', text: `已完成本轮测试，${links.join('和')}已生成。`,
  })
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    let popups = 0
    page.on('popup', () => { popups += 1 })
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
    if (viewport.width < 1024) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByRole('link', { name: '测试计划', exact: true }).waitFor()
    const originalUrl = page.url()
    for (const document of documents) {
      await page.getByRole('link', { name: document.label, exact: true }).click()
      const drawer = page.locator('.workspace-inspector:not(.workspace-drawer-leave-active)')
      await drawer.getByText(document.content, { exact: true }).waitFor({ timeout: 5000 })
      assert.equal(page.url(), originalUrl)
      assert.equal(popups, 0)
      await page.waitForTimeout(300)
      await saveScreenshot(page, `report-link-${document.name}-${viewport.width}.png`)
      if (viewport.width < 1024) await drawer.getByTitle('关闭抽屉', { exact: true }).click()
      else await page.getByRole('button', { name: '关闭标签 文件 · 主回归会话', exact: true }).click()
      await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
    }
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('标签工作台支持组合分屏、移动、独立草稿、资源标签与布局恢复', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByText('回归基线已经准备完成。').waitFor()
  const visibleComposer = page.locator('.workbench-content:visible').getByPlaceholder('向 Agent 发送消息')
  await visibleComposer.fill('主会话未发送草稿')
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  await visibleComposer.fill('第二会话未发送草稿')
  assert.equal(await page.getByRole('tab', { name: '主回归会话', exact: true }).count(), 1)
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  assert.equal(await page.locator('.workbench-group').count(), 2)
  assert.equal(await page.locator('.task-timeline-pane:visible').count(), 2)
  assert.equal(await page.locator('.task-timeline-pane:visible').nth(0).getByPlaceholder('向 Agent 发送消息').inputValue(), '主会话未发送草稿')
  assert.equal(await page.locator('.task-timeline-pane:visible').nth(1).getByPlaceholder('向 Agent 发送消息').inputValue(), '第二会话未发送草稿')
  const firstGroup = page.locator('.workbench-group').first()
  await firstGroup.getByRole('button', { name: '向下拆分', exact: true }).click()
  assert.equal(await page.locator('.workbench-group').count(), 3)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('tabpanel', { name: '设置', exact: true }).getByRole('heading', { name: '外观', exact: true }).waitFor()
  assert.equal(await page.getByRole('dialog').count(), 0)
  await page.getByRole('button', { name: 'Tokyo Night' }).click()
  const separator = page.getByRole('separator', { name: '调整分区大小' }).first()
  await separator.press('ArrowRight')
  assert.equal(await separator.getAttribute('aria-valuenow'), '55')
  const saved = await page.evaluate(() => localStorage.getItem('promptx:v2:workbench-tabs'))
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.getByRole('tabpanel', { name: '设置', exact: true }).getByRole('heading', { name: '外观', exact: true }).waitFor()
  assert.equal(await page.locator('.workbench-group').count(), 3)
  assert.equal(await page.getByRole('separator', { name: '调整分区大小' }).first().getAttribute('aria-valuenow'), '55')
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'tokyo-night')
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:v2:workbench-tabs')), saved)
  await saveScreenshot(page, 'desktop-tabs-split.png')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByRole('button', { name: '浏览文件', exact: true }).click()
  await page.locator('.workspace-inspector:visible').waitFor()
  assert.equal(await page.getByRole('tablist', { name: '工作区标签' }).count(), 0)
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:v2:workbench-tabs')), saved)
  await page.getByRole('button', { name: /^关闭(抽屉|标签页)$/ }).click()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.getByRole('tabpanel', { name: '设置', exact: true }).getByRole('heading', { name: '外观', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭标签 设置', exact: true }).click()
  assert.equal(await page.locator('.workbench-group').count(), 2)
  // 跨组移动同一个会话，已有组件与草稿都要保留。
  const composer = page.locator('.task-timeline-pane:visible').first().getByPlaceholder('向 Agent 发送消息')
  await composer.fill('移动标签仍保留')
  await page.getByRole('button', { name: '主回归会话 的标签操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '移至分区 2', exact: true }).click()
  assert.equal(await page.locator('.workbench-group').count(), 1)
  assert.equal(await visibleComposer.inputValue(), '移动标签仍保留')
  await page.getByRole('button', { name: '浏览文件', exact: true }).click()
  await page.locator('.workspace-inspector:visible').getByTitle('README.md', { exact: true }).click()
  await page.getByText('工作区修改', { exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: 'README.md', exact: true }).count(), 0)
  const inspector = page.locator('.workspace-inspector:visible')
  const treeBox = await inspector.locator('.file-tree').boundingBox()
  const previewBox = await inspector.locator('.preview-pane').boundingBox()
  assert.ok(treeBox.x + treeBox.width <= previewBox.x + 1)
  assert.equal(Math.round(treeBox.y), Math.round(previewBox.y))
  await inspector.getByTitle('pixel.png', { exact: true }).click()
  await inspector.getByAltText('pixel.png').waitFor()
  await inspector.getByTitle('README.md', { exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: 'README.md', exact: true }).count(), 0)
  await page.getByRole('tab', { name: '主回归会话', exact: true }).click()
  assert.equal(await visibleComposer.inputValue(), '移动标签仍保留')
  await page.getByRole('tab', { name: '文件 · 主回归会话', exact: true }).click()
  await page.reload()
  await page.locator('.workspace-inspector:visible .preview-pane').getByText('工作区修改', { exact: true }).waitFor()
  assert.equal(await page.locator('.workspace-inspector:visible .file-tree').isVisible(), true)
  await saveScreenshot(page, 'files-inline-preview.png')
  await assertNoHorizontalOverflow(page)
  assert.deepEqual(failures, [])
})

test('标签拖拽保留视图、跨工作区同时打开且关闭运行会话不取消任务', async (t) => {
  const fixture = await createFixture(t)
  const otherRoot = path.join(fixture.root, 'other-workspace')
  fs.mkdirSync(otherRoot)
  const project = fixture.app.sqliteRepository.createProject({ repositoryRoot: otherRoot, displayName: '另一个工作区' })
  const environment = fixture.app.sqliteRepository.createEnvironment({ cwd: otherRoot, repositoryRoot: otherRoot, kind: 'local' })
  const task = fixture.app.sqliteRepository.createTask({ projectId: project.id, environmentId: environment.id, title: '另一个工作区会话' })
  fixture.app.sqliteRepository.createAgent(task.id, { providerId: 'codex' })
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  await page.addInitScript(taskId => localStorage.setItem('promptx:v2:active-task-id', taskId), fixture.task.id)
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByPlaceholder('向 Agent 发送消息').filter({ visible: true }).fill('拖动时的草稿')
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  const source = page.getByRole('tab', { name: '主回归会话', exact: true })
  const group = page.locator('.workbench-group')
  const bounds = await group.boundingBox()
  await source.hover()
  await page.mouse.down()
  await page.mouse.move(bounds.x + bounds.width - 20, bounds.y + bounds.height / 2, { steps: 12 })
  await page.mouse.move(bounds.x + bounds.width - 18, bounds.y + bounds.height / 2)
  await page.mouse.up()
  await page.waitForFunction(() => document.querySelectorAll('.workbench-group').length === 2)
  const mainPanel = page.getByRole('tabpanel', { name: '主回归会话', exact: true })
  assert.equal(await mainPanel.getByPlaceholder('向 Agent 发送消息').inputValue(), '拖动时的草稿')
  await source.dragTo(page.locator('.workbench-group').first().getByRole('tablist'))
  await page.waitForFunction(() => document.querySelectorAll('.workbench-group').length === 1)
  assert.equal(await mainPanel.getByPlaceholder('向 Agent 发送消息').inputValue(), '拖动时的草稿')
  // 使用真实滚动容器确认隐藏再显示不会跳回底部。
  await mainPanel.locator('.timeline').evaluate(element => {
    const spacer = document.createElement('div')
    spacer.style.height = '1500px'
    element.append(spacer)
    element.scrollTop = element.scrollHeight
    element.dispatchEvent(new Event('scroll'))
    element.scrollTop = 150
    element.dispatchEvent(new Event('scroll'))
  })
  await page.getByRole('tab', { name: '草稿切换会话', exact: true }).click()
  await source.click()
  assert.equal(await mainPanel.locator('.timeline').evaluate(element => element.scrollTop), 150)
  await page.getByRole('button', { name: '向下拆分', exact: true }).click()
  await page.getByRole('link', { name: '另一个工作区会话', exact: true }).click()
  assert.equal(await page.locator('.workbench-group').count(), 2)
  assert.equal(await page.getByRole('tab', { name: '主回归会话', exact: true }).count(), 1)
  assert.equal(await page.getByRole('tab', { name: '草稿切换会话', exact: true }).count(), 1)
  assert.equal(await page.getByRole('tab', { name: '另一个工作区会话', exact: true }).count(), 1)
  const otherPanel = page.getByRole('tabpanel', { name: '另一个工作区会话', exact: true })
  await otherPanel.getByPlaceholder('向 Agent 发送消息').fill('跨工作区草稿')
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  assert.equal(await mainPanel.getByPlaceholder('向 Agent 发送消息').inputValue(), '拖动时的草稿')
  assert.equal(await mainPanel.locator('.timeline').evaluate(element => element.scrollTop), 150)
  await page.getByRole('button', { name: '另一个工作区会话 的标签操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '移至分区 1', exact: true }).click()
  assert.equal(await mainPanel.isVisible(), true)
  assert.equal(await otherPanel.isVisible(), true)
  assert.equal(await otherPanel.getByPlaceholder('向 Agent 发送消息').inputValue(), '跨工作区草稿')
  await page.reload()
  await mainPanel.getByPlaceholder('向 Agent 发送消息').waitFor()
  await otherPanel.getByPlaceholder('向 Agent 发送消息').waitFor()
  assert.equal(await page.locator('.workbench-group').count(), 2)
  await saveScreenshot(page, 'cross-workspace-tabs.png')
  await mainPanel.getByPlaceholder('向 Agent 发送消息').fill('保持运行')
  await mainPanel.getByRole('button', { name: '发送', exact: true }).click()
  await mainPanel.getByRole('button', { name: '停止', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭标签 主回归会话', exact: true }).click()
  assert.equal(fixture.runtimeRecords.canceled, 0)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await mainPanel.getByRole('button', { name: '停止', exact: true }).click()
  await mainPanel.getByRole('button', { name: '发送', exact: true }).waitFor()
  assert.equal(fixture.runtimeRecords.canceled, 1)
  assert.deepEqual(failures, [])
})

test('资源新标签在发起操作的分栏打开，不替换其他分栏会话', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  const firstGroup = page.locator('.workbench-group').first()
  const sourceGroup = page.locator('.workbench-group').nth(1)
  const mainSession = page.getByRole('tabpanel', { name: '主回归会话', exact: true })
  const draftSession = page.getByRole('tabpanel', { name: '草稿切换会话', exact: true })
  const selectedStyle = group => group.getByRole('tab', { selected: true }).evaluate(tab => {
    const style = getComputedStyle(tab)
    return { color: style.color, weight: style.fontWeight, background: style.backgroundColor }
  })
  const focusedStyle = await selectedStyle(sourceGroup)
  const unfocusedStyle = await selectedStyle(firstGroup)
  assert.notEqual(focusedStyle.color, unfocusedStyle.color)
  assert.ok(Number(focusedStyle.weight) > Number(unfocusedStyle.weight))
  assert.equal(focusedStyle.background, unfocusedStyle.background)
  for (const [panel, focused, unfocused] of [[mainSession, firstGroup, sourceGroup], [draftSession, sourceGroup, firstGroup]]) {
    await panel.getByPlaceholder('向 Agent 发送消息').click()
    assert.equal(await focused.evaluate(group => group.classList.contains('is-focused')), true)
    assert.equal(await page.locator('.workbench-group.is-focused .workbench-tab.is-active').count(), 1)
    assert.equal(await page.getByRole('tab', { selected: true }).count(), 2)
    assert.deepEqual(await selectedStyle(focused), focusedStyle)
    assert.deepEqual(await selectedStyle(unfocused), unfocusedStyle)
    assert.equal(await mainSession.isVisible(), true)
    assert.equal(await draftSession.isVisible(), true)
  }
  await sourceGroup.getByRole('button', { name: '向下拆分', exact: true }).click()
  const session = page.getByRole('tabpanel', { name: '草稿切换会话', exact: true })
  for (const [button, title] of [['浏览文件', '文件'], ['查看 Diff', 'Diff'], ['任务详情', '会话详情']]) {
    await session.getByRole('button', { name: button, exact: true }).click()
    const resourceTab = sourceGroup.getByRole('tab', { name: `${title} · 草稿切换会话`, exact: true })
    await resourceTab.waitFor()
    assert.equal(await resourceTab.getAttribute('aria-selected'), 'true')
    assert.equal(await firstGroup.getByRole('tab', { name: '主回归会话', exact: true }).getAttribute('aria-selected'), 'true')
    assert.equal(await page.getByRole('tabpanel', { name: '主回归会话', exact: true }).isVisible(), true)
    await sourceGroup.getByRole('tab', { name: '草稿切换会话', exact: true }).click()
  }
  await saveScreenshot(page, 'resource-tabs-current-group.png')
  await sourceGroup.getByRole('button', { name: '文件 · 草稿切换会话 的标签操作', exact: true }).click()
  await page.getByRole('menuitem', { name: '关闭其他标签', exact: true }).click()
  assert.equal(await sourceGroup.getByRole('tab').count(), 1)
  assert.equal(await sourceGroup.getByRole('tab', { name: '文件 · 草稿切换会话', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await firstGroup.getByRole('tab', { name: '主回归会话', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(await mainSession.isVisible(), true)
  await sourceGroup.getByRole('button', { name: '文件 · 草稿切换会话 的标签操作', exact: true }).click()
  assert.equal(await page.getByRole('menuitem', { name: '关闭其他标签', exact: true }).isDisabled(), true)
  await page.keyboard.press('Escape')
  assert.deepEqual(failures, [])
})

test('多终端标签支持隔离、重命名、恢复且只拉取当前标签输出', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' })
  const terminals = new Map()
  const reads = new Map()
  let sequence = 0
  await page.route('**/api/v2/tasks/*/terminals**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    const parts = url.pathname.split('/')
    const taskId = parts[4], id = parts[6]
    if (request.method() === 'GET' && !id) {
      await route.fulfill({ json: { terminals: [...terminals.values()].filter(item => item.taskId === taskId) } })
    } else if (request.method() === 'POST' && !id) {
      const body = request.postDataJSON()
      let terminal = body.ensure && [...terminals.values()].find(item => item.taskId === taskId)
      if (!terminal) {
        sequence++
        terminal = { id: `terminal-${sequence}`, taskId, name: `终端 ${sequence}`, cwd: '/tmp', data: 'ready\r\n', running: true }
        terminals.set(terminal.id, terminal)
      }
      await route.fulfill({ json: { terminal } })
    } else if (request.method() === 'GET') {
      const terminal = terminals.get(id)
      reads.set(id, (reads.get(id) || 0) + 1)
      await route.fulfill({ json: { ...terminal, data: terminal.data.slice(Number(url.searchParams.get('cursor'))), cursor: terminal.data.length, reset: false } })
    } else {
      if (request.method() === 'PATCH') Object.assign(terminals.get(id), request.postDataJSON())
      if (parts[7] === 'input') terminals.get(id).data += request.postDataJSON().data
      if (request.method() === 'DELETE') terminals.delete(id)
      await route.fulfill({ json: { ok: true, terminal: terminals.get(id) } })
    }
  })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await page.getByRole('tab', { name: '终端 1', exact: true }).waitFor()
  await page.getByRole('button', { name: '新建终端', exact: true }).click()
  const second = page.getByRole('tab', { name: '终端 2', exact: true })
  await second.waitFor()
  assert.equal(await second.getAttribute('aria-selected'), 'true')
  assert.equal(await page.locator('.xterm').count(), 1)
  await page.waitForTimeout(300)
  const inactiveReads = reads.get('terminal-1')
  await page.waitForTimeout(1200)
  assert.equal(reads.get('terminal-1'), inactiveReads, '后台标签不能拉取输出')
  await page.getByRole('button', { name: '重命名终端', exact: true }).click()
  await page.getByRole('textbox', { name: '终端名称', exact: true }).fill('前端服务')
  await page.getByRole('textbox', { name: '终端名称', exact: true }).press('Enter')
  await page.getByRole('tab', { name: '前端服务', exact: true }).waitFor()
  await page.getByRole('button', { name: '关闭标签 终端 · 主回归会话', exact: true }).click()
  await page.waitForTimeout(200)
  const stoppedReads = [...reads.entries()]
  await page.waitForTimeout(1200)
  assert.deepEqual([...reads.entries()], stoppedReads, '收起区域后不能拉取输出')
  await page.reload()
  await page.getByRole('button', { name: '终端', exact: true }).click()
  await page.getByRole('tab', { name: '前端服务', exact: true }).waitFor()
  assert.equal(await page.getByRole('tab', { name: '前端服务', exact: true }).getAttribute('aria-selected'), 'true')
  assert.equal(terminals.size, 2)
  await page.getByRole('button', { name: '关闭 终端 1（结束进程）', exact: true }).click()
  await page.getByRole('tab', { name: '终端 1', exact: true }).waitFor({ state: 'detached' })
  assert.equal(terminals.size, 1)
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  const terminalGroupId = await page.getByRole('tab', { name: '草稿切换会话', exact: true }).evaluate(tab => tab.closest('.workbench-group').dataset.groupId)
  await page.getByRole('tabpanel', { name: '草稿切换会话', exact: true }).getByRole('button', { name: '终端', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: '终端 · 草稿切换会话', exact: true }).evaluate(tab => tab.closest('.workbench-group').dataset.groupId), terminalGroupId)
  await page.getByRole('tab', { name: '终端 3', exact: true }).waitFor()
  assert.equal(await page.locator('.xterm').count(), 2)
  assert.equal(terminals.size, 2)
})

test('手机终端快捷键发送控制字符并保留输入焦点', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' })
  const inputs = []
  const terminal = { id: 'mobile-terminal', name: '终端 1', cwd: '/tmp', running: true }
  await page.route('**/api/v2/tasks/*/terminals**', async route => {
    const request = route.request()
    const url = new URL(request.url())
    if (url.pathname.endsWith('/input')) inputs.push(request.postDataJSON().data)
    if (request.method() === 'GET' && url.pathname.endsWith('/terminals')) return route.fulfill({ json: { terminals: [terminal] } })
    if (request.method() === 'GET') return route.fulfill({ json: { ...terminal, data: '', cursor: 0, reset: false } })
    return route.fulfill({ json: { terminal, ok: true } })
  })
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByRole('button', { name: '终端', exact: true }).click()
  const shortcuts = page.getByRole('group', { name: '终端快捷键' })
  await shortcuts.waitFor()
  const cases = [['中断当前命令', '\x03'], ['补全命令', '\t'], ['退出当前模式', '\x1b'], ['光标左移', '\x1b[D'], ['下一条历史或向下', '\x1b[B'], ['上一条历史或向上', '\x1b[A'], ['光标右移', '\x1b[C']]
  for (const [name, data] of cases) {
    const sent = page.waitForResponse(response => response.url().endsWith('/input') && response.request().postDataJSON().data === data)
    await shortcuts.getByRole('button', { name, exact: true }).tap()
    await sent
    assert.equal(await page.locator('.xterm-helper-textarea').evaluate(el => el === document.activeElement), true)
  }
  assert.deepEqual(inputs, cases.map(([, data]) => data))
  const box = await shortcuts.boundingBox()
  assert.ok(box.x >= 0 && box.x + box.width <= 390)
})

test('同一条消息的图片预览支持方向键、边界和 Esc 关闭', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'first.png', mimeType: 'image/png', buffer: png },
    { name: 'second.png', mimeType: 'image/png', buffer: png },
  ])
  await page.getByText('second.png', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const first = page.locator('.message-image[title="first.png"]')
  await first.click()
  const preview = page.getByRole('dialog', { name: '图片预览' })
  await preview.getByAltText('first.png').waitFor()
  await preview.dispatchEvent('wheel', { deltaY: -100, clientX: 720, clientY: 450 })
  assert.ok(await preview.getByAltText('first.png').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a > 1))
  await page.keyboard.press('ArrowRight')
  await preview.getByAltText('second.png').waitFor()
  assert.equal(await preview.getByAltText('second.png').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a), 1)
  assert.equal(await preview.getByRole('button', { name: '下一张图片' }).isDisabled(), true)
  await page.keyboard.press('ArrowRight')
  await preview.getByAltText('second.png').waitFor()
  await page.keyboard.press('ArrowLeft')
  await preview.getByAltText('first.png').waitFor()
  await page.keyboard.press('Escape')
  await preview.waitFor({ state: 'detached' })
  assert.equal(await first.evaluate(el => el === document.activeElement), true)
})


test('手机图片预览支持双指缩放，返回列表后关闭且重新打开复位', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByText('回归基线已经准备完成。').waitFor()
  const buffer = await page.screenshot({ clip: { x: 0, y: 0, width: 300, height: 300 } })
  await page.locator('input[type="file"]').setInputFiles({ name: 'pinch.png', mimeType: 'image/png', buffer })
  await page.getByText('pinch.png', { exact: true }).waitFor()
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const thumbnail = page.locator('.message-image[title="pinch.png"]')
  await thumbnail.click()
  const preview = page.getByRole('dialog', { name: '图片预览' })
  const image = preview.getByAltText('pinch.png')
  await image.waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="图片预览"] img')?.classList.contains('opacity-100'))
  const client = await page.context().newCDPSession(page)
  const box = await image.boundingBox()
  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  const touches = distance => [{ x: x - distance, y, id: 1 }, { x: x + distance, y, id: 2 }]
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: touches(30) })
  await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: touches(60) })
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  assert.ok(await image.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a > 1.5))
  await page.goBack()
  await preview.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await thumbnail.click()
  await image.waitFor()
  assert.equal(await image.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a), 1)
  await preview.getByRole('button', { name: '关闭预览' }).click()
  await preview.waitFor({ state: 'detached' })
})


test('Timeline 加载工作区外绝对路径图片，支持重试且拒绝非图片', async (t) => {
  const fixture = await createFixture(t)
  const filePath = path.join(fixture.root, '预览 图片.png')
  const page = await fixture.browser.newPage()
  await page.screenshot({ path: filePath, clip: { x: 0, y: 0, width: 120, height: 120 } })
  const missingPath = path.join(fixture.root, 'later.png')
  const repository = fixture.app.sqliteRepository
  const turn = repository.createTurn(fixture.task.id, 'local-image')
  repository.updateTurn(turn.id, { status: 'completed' })
  repository.appendTimeline(fixture.task.id, turn.id, {
    type: 'assistant_message', messageId: 'local-image', phase: 'final_answer',
    text: `![本机图片](<${filePath}>)\n\n![稍后生成](<${missingPath}>)`,
  })
  await page.goto(fixture.baseUrl)
  const preview = page.locator('[data-local-image="1"]').filter({ has: page.getByAltText('本机图片') })
  await preview.locator('img').waitFor()
  await page.waitForFunction(() => document.querySelector('[data-local-image="1"]')?.dataset.workspaceImageState === 'ready')
  assert.equal(await preview.locator('img').evaluate(el => el.naturalWidth), 120)
  await preview.locator('img').click()
  const viewer = page.getByRole('dialog', { name: '图片预览' })
  await viewer.waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="图片预览"] img')?.classList.contains('opacity-100'))
  await viewer.dispatchEvent('wheel', { deltaY: -100, clientX: 640, clientY: 360 })
  assert.ok(await viewer.locator('img').evaluate(el => new DOMMatrix(getComputedStyle(el).transform).a > 1))
  await page.keyboard.press('Escape')
  await viewer.waitFor({ state: 'detached' })
  assert.equal(await preview.locator('img').evaluate(el => el === document.activeElement), true)
  await preview.locator('img').press('Enter')
  await viewer.waitFor()
  await viewer.getByRole('button', { name: '关闭预览' }).click()
  await viewer.waitFor({ state: 'detached' })

  const failed = page.locator('[data-local-image="1"]').filter({ has: page.getByAltText('稍后生成') })
  await failed.getByText('图片加载失败，点击重试').waitFor()
  fs.writeFileSync(missingPath, png)
  await failed.click()
  await page.waitForFunction(() => [...document.querySelectorAll('[data-local-image="1"]')].every(el => el.dataset.workspaceImageState === 'ready'))
  const endpoint = `/api/v2/tasks/${fixture.task.id}/local-image/content`
  const textPath = path.join(fixture.root, 'private.txt')
  fs.writeFileSync(textPath, 'not an image')
  assert.equal((await fixture.app.inject({ headers: { host: new URL(fixture.baseUrl).host }, url: `${endpoint}?${new URLSearchParams({ path: textPath })}` })).statusCode, 415)
  assert.equal((await fixture.app.inject({ headers: { host: new URL(fixture.baseUrl).host }, url: `${endpoint}?path=relative.png` })).statusCode, 400)
  const restricted = await fixture.app.inject({ headers: { host: new URL(fixture.baseUrl).host }, url: `/api/v2/tasks/${fixture.task.id}/file/content?${new URLSearchParams({ path: filePath })}` })
  assert.equal(restricted.statusCode, 400)
  const mobile = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await mobile.goto(fixture.baseUrl)
  await mobile.getByRole('link', { name: '主回归会话', exact: true }).click()
  await mobile.waitForFunction(() => document.querySelector('[data-local-image="1"]')?.dataset.workspaceImageState === 'ready')
  await mobile.locator('.codex-markdown img[alt="本机图片"]').click()
  const mobileViewer = mobile.getByRole('dialog', { name: '图片预览' })
  await mobileViewer.waitFor()
  await mobile.goBack()
  await mobileViewer.waitFor({ state: 'detached' })

})


test('手机视频全屏后横竖屏切换保留播放器、进度，退出后仍可关闭与返回', async (t) => {
  const fixture = await createFixture(t)
  fs.copyFileSync(new URL('./fixtures/preview.mp4', import.meta.url), path.join(fixture.workspace, 'preview.mp4'))
  const repository = fixture.app.sqliteRepository
  const turn = repository.createTurn(fixture.task.id, 'rotation-video')
  repository.updateTurn(turn.id, { status: 'completed' })
  repository.appendTimeline(fixture.task.id, turn.id, {
    type: 'assistant_message', messageId: 'rotation-video', phase: 'final_answer',
    text: '[播放测试视频](preview.mp4)',
  })
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const failures = collectPageFailures(page)
  let videoRequests = 0
  page.on('request', request => { if (request.url().includes('/file/content?path=preview.mp4')) videoRequests += 1 })
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByRole('link', { name: '播放测试视频', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '视频预览' })
  await viewer.waitFor()
  await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.readyState >= 2)
  const video = viewer.locator('video')
  await video.evaluate(element => {
    element.pause()
    element.currentTime = 1
    window.rotationVideo = element
    window.rotationVideoUrl = element.src
    element.addEventListener('click', () => { void element.requestFullscreen() }, { once: true })
  })
  await video.click({ position: { x: 15, y: 15 } })
  await page.waitForFunction(() => document.fullscreenElement === window.rotationVideo)
  await video.evaluate(element => element.pause())
  const currentTime = await video.evaluate(element => element.currentTime)
  const device = await page.context().newCDPSession(page)
  for (const viewport of [{ width: 844, height: 390 }, { width: 390, height: 844 }]) {
    // 全屏窗口不能直接改大小，使用设备旋转指标模拟手机横竖屏。
    await device.send('Emulation.setDeviceMetricsOverride', {
      ...viewport, screenWidth: viewport.width, screenHeight: viewport.height,
      mobile: true, deviceScaleFactor: 1,
      screenOrientation: viewport.width > viewport.height
        ? { type: 'landscapePrimary', angle: 90 } : { type: 'portraitPrimary', angle: 0 },
    })
    await page.waitForFunction(mobile => Boolean(document.querySelector('.timeline-workspace > .task-timeline-pane')) === mobile, viewport.width <= 720)
    assert.equal(await video.evaluate(element => element === window.rotationVideo && element.src === window.rotationVideoUrl), true)
    assert.equal(await video.evaluate(element => element.currentTime), currentTime)
    assert.equal(await page.evaluate(() => document.fullscreenElement === window.rotationVideo), true)
  }
  assert.equal(videoRequests, 1)
  await page.evaluate(() => document.exitFullscreen())
  await viewer.getByRole('button', { name: '关闭预览' }).click()
  await viewer.waitFor({ state: 'detached' })
  await page.getByRole('link', { name: '播放测试视频', exact: true }).click()
  await viewer.waitFor()
  await page.goBack()
  await viewer.waitFor({ state: 'detached' })
  assert.deepEqual(failures, [])
})

test('移动端长 JSON 错误在提示框内换行，不产生 Timeline 横向溢出', async (t) => {
  const fixture = await createFixture(t)
  const repository = fixture.app.sqliteRepository
  const turn = repository.createTurn(fixture.task.id, 'long-error')
  repository.updateTurn(turn.id, { status: 'failed' })
  const message = JSON.stringify({ error: { message: "Missing namespace for function_call 'js'.", param: 'input[18].namespace', type: 'invalid_request_error', detail: 'unbroken'.repeat(80) } })
  repository.appendTimeline(fixture.task.id, turn.id, { type: 'error', message })
  for (const width of [320, 390]) {
    const page = await fixture.browser.newPage({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true })
    await page.goto(fixture.baseUrl)
    await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    const error = page.locator('.error-row').filter({ hasText: message })
    await error.waitFor()
    assert.equal(await error.textContent(), message)
    assert.ok(await error.evaluate(el => el.scrollWidth <= el.clientWidth))
    assert.ok(await error.evaluate(el => {
      for (let node = el.parentElement; node && !node.classList.contains('timeline-workspace'); node = node.parentElement) {
        if (node.scrollWidth > node.clientWidth + 1) return false
      }
      return true
    }))
    await assertNoHorizontalOverflow(page)
    await page.close()
  }
})


test('手机 Enter 换行并通过按钮发送，桌面保留 Enter 发送和 Shift+Enter 换行', async (t) => {
  const fixture = await createFixture(t)
  for (const mobile of [true, false]) {
    const page = await fixture.browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 900 }, isMobile: mobile, hasTouch: mobile })
    await page.goto(fixture.baseUrl)
    if (mobile) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    const input = page.getByPlaceholder('向 Agent 发送消息')
    const before = fixture.runtimeRecords.turns.length
    await input.fill('第一行')
    await input.press(mobile ? 'Enter' : 'Shift+Enter')
    await input.pressSequentially('第二行')
    assert.equal(await input.inputValue(), '第一行\n第二行')
    assert.equal(fixture.runtimeRecords.turns.length, before)
    if (mobile) await page.getByRole('button', { name: '发送', exact: true }).click()
    else await input.press('Enter')
    await page.waitForFunction(() => document.querySelector('textarea[placeholder="向 Agent 发送消息"]').value === '')
    assert.equal(fixture.runtimeRecords.turns.length, before + 1)
    await page.getByText('已处理：第一行\n第二行', { exact: true }).last().waitFor()
    await page.close()
  }
})

test('子任务在发起轮次内展示结果，主回复结束仍等待子任务，手机布局不溢出', async (t) => {
  const fixture = await createFixture(t)
  const repository = fixture.app.sqliteRepository
  const agent = repository.getTaskAgent(fixture.task.id)
  const turn = repository.listTurns(fixture.task.id)[0]
  repository.upsertProviderTask(agent.id, { id: 'review', originTurnId: turn.id, kind: 'local_agent', title: '检查接口边界', status: 'completed', summary: '### 子 Agent 最终结果\n\n发现 **两处边界问题**，建议增加参数校验。' })
  repository.upsertProviderTask(agent.id, { id: 'database', originTurnId: turn.id, kind: 'local_agent', title: '检查数据库访问', status: 'running', summary: '正在检查事务与连接释放。' })
  repository.upsertProviderTask(agent.id, { id: 'child-command', parentTaskId: 'review', originTurnId: null, kind: 'local_bash', title: '子 Agent 内部验证命令', status: 'completed', summary: '内部命令验证完成' })
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
    if (viewport.width < 600) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    const group = page.locator('.timeline-turn .timeline-subagents')
    await group.getByText('检查数据库访问', { exact: true }).waitFor()
    assert.equal(await page.locator('.composer-wrap .timeline-subagents').count(), 0)
    await page.getByLabel('等待子任务 · 1', { exact: true }).waitFor()
    await group.getByText('检查接口边界', { exact: true }).click()
    await group.getByText('子 Agent 最终结果', { exact: true }).waitFor()
    const childCommand = group.locator('[data-task-id="review"] [data-task-id="child-command"]')
    await childCommand.getByText('子 Agent 内部验证命令', { exact: true }).click()
    await childCommand.getByText('内部命令验证完成', { exact: true }).waitFor()
    assert.equal(await group.locator(':scope > div > .background-task').count(), 2)
    assert.equal(await page.locator('.timeline-subagents').count(), 1)
    await assertNoHorizontalOverflow(page)
    await saveScreenshot(page, `subagents-${viewport.width}.png`)
    assert.deepEqual(failures, [])
    await page.close()
  }
})


test('后台自动续跑与原请求合并显示，子任务保留归属，新用户请求独立显示', async t => {
  for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
    const fixture = await createFixture(t)
    const repository = fixture.app.sqliteRepository
    const agent = repository.getTaskAgent(fixture.task.id)
    const auto = repository.createTurn(fixture.task.id, 'autonomous:notification-test')
    repository.updateTurn(auto.id, { status: 'completed', startedAt: new Date().toISOString(), finishedAt: new Date().toISOString() })
    repository.appendTimeline(fixture.task.id, auto.id, { type: 'system_notice', code: 'autonomous_turn', text: '后台任务触发自动续跑' })
    repository.appendTimeline(fixture.task.id, auto.id, { type: 'assistant_message', messageId: 'auto-answer', phase: 'final_answer', text: '后台续跑结果已完成。' })
    repository.upsertProviderTask(agent.id, { id: 'auto-child', originTurnId: auto.id, kind: 'local_agent', title: '续跑中的子任务', status: 'completed', summary: '检查完成。' })

    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
    if (viewport.width < 600) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('后台续跑结果已完成。', { exact: true }).waitFor()
    const turns = page.locator('.timeline-turn')
    assert.equal(await turns.count(), 1)
    assert.equal(await turns.locator('.timeline-message').count(), 2)
    assert.equal(await page.getByText('后台续跑结果已完成。', { exact: true }).count(), 1)
    await turns.locator('.timeline-subagents > button').click()
    await turns.locator('.timeline-subagents').getByText('续跑中的子任务', { exact: true }).waitFor()
    await turns.locator('.process-toggle').click()
    await turns.locator('.process-content').getByText('后台任务触发自动续跑', { exact: true }).waitFor()
    await assertNoHorizontalOverflow(page)
    // 用实际发送路径确认后续输入不会被并入上一个请求。
    await page.getByPlaceholder('向 Agent 发送消息').fill('新的独立请求')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.getByText('已处理：新的独立请求', { exact: true }).waitFor()
    assert.equal(await turns.count(), 2)
    assert.equal(await turns.first().getByText('新的独立请求', { exact: true }).count(), 0)
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('多个会话分栏共享事件连接，五栏可发送取消且不阻塞 API', async t => {
  const fixture = await createFixture(t)
  const ids = [fixture.task.id, fixture.secondaryTask.id]
  for (let index = 3; index <= 5; index++) {
    const repository = fixture.app.sqliteRepository
    const environment = repository.createEnvironment({ cwd: fixture.workspace, repositoryRoot: fixture.workspace, kind: 'local' })
    const task = repository.createTask({ projectId: fixture.project.id, environmentId: environment.id, title: `连接测试 ${index}` })
    repository.createAgent(task.id, { providerId: 'codex' })
    ids.push(task.id)
  }
  const layout = createLayout()
  for (const [index, taskId] of ids.entries()) {
    if (index) splitGroup(layout, layout.focusedId, 'bottom')
    openTab(layout, { type: 'session', taskId })
  }
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 1400 } })
  const failures = collectPageFailures(page)
  await page.addInitScript(layout => localStorage.setItem('promptx:v2:workbench-tabs', JSON.stringify({ version: 2, layout })), layout)
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.waitForFunction(() => document.querySelectorAll('.workbench-content .timeline-sync-status').length === 0)
  assert.equal(await page.getByRole('tabpanel').count(), 5)
  const apiStatus = await page.evaluate(async () => (await fetch('/api/v2/providers', { signal: AbortSignal.timeout(2000) })).status)
  assert.equal(apiStatus, 200)
  const main = page.getByRole('tabpanel', { name: '主回归会话', exact: true })
  // 切到较大分栏，操作实际输入框并验证事件能正确分发。
  const divider = page.getByRole('separator', { name: '调整分区大小' }).first()
  await divider.press('ArrowDown')
  await main.getByPlaceholder('向 Agent 发送消息').fill('保持运行，验证多分栏连接')
  await main.getByRole('button', { name: '发送', exact: true }).click()
  await main.getByRole('button', { name: '停止', exact: true }).click()
  await main.getByRole('button', { name: '发送', exact: true }).waitFor()
  assert.equal(fixture.runtimeRecords.canceled, 1)
  assert.deepEqual(failures, [])
})

test('Provider 探测延迟不阻塞会话列表，工作台只发一次聚合请求', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  let releaseProviders
  const providersReady = new Promise(resolve => { releaseProviders = resolve })
  t.after(() => releaseProviders())
  await page.route('**/api/v2/providers', async route => {
    await providersReady
    await route.continue()
  })
  const requests = []
  page.on('request', request => { requests.push(new URL(request.url()).pathname) })
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).waitFor()
  assert.equal(requests.filter(path => path === '/api/v2/workbench').length, 1)
  assert.equal(requests.some(path => /^\/api\/v2\/projects(?:\/[^/]+\/tasks)?$/.test(path)), false)
  releaseProviders()
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByText('回归基线已经准备完成。').waitFor()
})

test('首次加载失败保留原标签布局，恢复接口后可重新恢复', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  const saved = await page.evaluate(() => localStorage.getItem('promptx:v2:workbench-tabs'))
  await page.route('**/api/v2/workbench', route => route.fulfill({ status: 503, json: { message: '测试临时不可用' } }))
  await page.reload()
  await page.getByText('测试临时不可用', { exact: true }).waitFor()
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:v2:workbench-tabs')), saved)
  await page.unroute('**/api/v2/workbench')
  await page.reload()
  await page.getByRole('tabpanel', { name: '草稿切换会话', exact: true }).waitFor()
  assert.equal(await page.getByRole('tabpanel', { name: '主回归会话', exact: true }).isVisible(), true)
  assert.equal(await page.locator('.workbench-group').count(), 2)
})

test('键盘进入分栏同步全局焦点，后续标签在该分栏打开', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  await page.getByRole('tabpanel', { name: '主回归会话', exact: true }).getByPlaceholder('向 Agent 发送消息').click()
  const target = page.getByRole('tabpanel', { name: '草稿切换会话', exact: true }).getByPlaceholder('向 Agent 发送消息')
  let reached = false
  for (let index = 0; index < 40; index++) {
    await page.keyboard.press('Tab')
    reached = await target.evaluate(element => element === document.activeElement)
    if (reached) break
  }
  assert.equal(reached, true)
  const focused = page.locator('.workbench-group.is-focused')
  assert.equal(await focused.getByRole('tab', { name: '草稿切换会话', exact: true }).count(), 1)
  const groupId = await focused.getAttribute('data-group-id')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  assert.equal(await page.getByRole('tab', { name: '设置', exact: true }).evaluate(tab => tab.closest('.workbench-group').dataset.groupId), groupId)
})

test('独立 Diff 标签在会话可见或隐藏时自动刷新文件列表和当前预览', async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 900 } })
  const failures = collectPageFailures(page)
  let changed = 0
  fixture.runtimeRecords.onTurn = () => {
    changed++
    fs.appendFileSync(path.join(fixture.workspace, 'README.md'), `\n自动刷新 ${changed}\n`)
    fs.writeFileSync(path.join(fixture.workspace, `added-${changed}.txt`), '新文件')
  }
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.getByRole('button', { name: '查看 Diff', exact: true }).click()
  await page.getByRole('button', { name: '向右拆分', exact: true }).click()
  const diff = page.getByRole('tabpanel', { name: 'Diff · 主回归会话', exact: true })
  await diff.locator('button[title="README.md"]').click()
  await diff.getByText('+工作区修改', { exact: true }).waitFor()
  const main = page.getByRole('tabpanel', { name: '主回归会话', exact: true })
  await main.getByPlaceholder('向 Agent 发送消息').fill('修改文件')
  await main.getByRole('button', { name: '发送', exact: true }).click()
  await diff.locator('button[title="added-1.txt"]').waitFor()
  await diff.getByText('+自动刷新 1', { exact: true }).waitFor()
  // 关闭 Timeline 后通过 API 发起任务，Diff 仍独立接收事件。
  await page.getByRole('button', { name: '关闭标签 主回归会话', exact: true }).click()
  const response = await page.request.post(`${fixture.baseUrl}/api/v2/tasks/${fixture.task.id}/turns`, {
    data: { clientMessageId: 'diff-without-timeline', input: { content: [{ type: 'text', text: '继续修改' }] } },
  })
  assert.equal(response.ok(), true)
  await diff.locator('button[title="added-2.txt"]').waitFor()
  await diff.getByText('+自动刷新 2', { exact: true }).waitFor()
  assert.deepEqual(failures, [])
})

test('用户提示词渲染 Markdown，发送和复制保留原文，桌面与手机无横向溢出', async t => {
  const fixture = await createFixture(t)
  const prompt = [
    '# 用户 Markdown 回归', '', '**重点内容** 与 `inlineCode`', '',
    '- 第一项', '- 第二项', '', '> 引用说明', '',
    '| 检查项 | 结果 |', '| --- | --- |', '| 表格内容 | 支持渲染 |', '',
    '```js', 'const example = "这是一行用于验证代码块横向滚动的长文本，不应撑开整个页面或用户消息气泡";', '```', '',
    '[项目说明](README.md)', '', '<img src=x onerror="window.__markdownInjected = true">',
  ].join('\n')
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const page = await fixture.browser.newPage({ viewport })
    const failures = collectPageFailures(page)
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.__copiedMarkdown = text } } })
    })
    await page.goto(fixture.baseUrl)
    if (viewport.width < 720) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByPlaceholder('向 Agent 发送消息').fill(prompt)
    await page.getByRole('button', { name: '发送', exact: true }).click()
    const bubble = page.locator('.user-message').filter({ has: page.getByRole('heading', { name: '用户 Markdown 回归', exact: true }) }).last()
    await bubble.getByRole('heading', { name: '用户 Markdown 回归', exact: true }).waitFor()
    await bubble.getByRole('button', { name: '复制代码', exact: true }).waitFor()
    assert.equal(await bubble.locator('strong').innerText(), '重点内容')
    assert.equal(await bubble.locator('li').count(), 2)
    assert.equal(await bubble.locator('blockquote').innerText(), '引用说明')
    assert.equal(await bubble.getByRole('cell', { name: '支持渲染', exact: true }).count(), 1)
    assert.equal(await bubble.locator('img').count(), 0)
    assert.equal(await page.evaluate(() => window.__markdownInjected), undefined)
    assert.equal(fixture.runtimeRecords.turns.at(-1).filter(item => item.type === 'text').map(item => item.text).join('\n'), prompt)
    const message = bubble.locator('..')
    await message.hover()
    await message.getByRole('button', { name: '复制消息', exact: true }).click()
    assert.equal(await page.evaluate(() => window.__copiedMarkdown), prompt)
    await assertNoHorizontalOverflow(page)
    assert.equal(await bubble.evaluate(el => el.scrollWidth <= el.clientWidth + 1), true)
    await saveScreenshot(page, `user-markdown-${viewport.width}.png`)
    await bubble.getByRole('link', { name: '项目说明', exact: true }).click()
    await page.locator('.workspace-inspector:visible').getByText('工作区修改', { exact: true }).waitFor()
    assert.deepEqual(failures, [])
    await page.close()
  }
})


test('本地开发页面与 Daemon 不同端口时视频和音频携带允许的 Origin 并正常播放', async t => {
  const port = await availablePort()
  const origin = `http://127.0.0.1:${port}`
  const requests = []
  const fixture = await createFixture(t, { allowedOrigins: [origin], onRequest: async request => {
    if (request.url.includes('/file/content?')) requests.push({ origin: request.headers.origin, range: request.headers.range })
  } })
  const dev = await createViteServer({
    root: path.resolve(webRoot, '..'),
    configFile: path.resolve(webRoot, '../vite.config.js'),
    cacheDir: path.join(fixture.root, 'vite-cache'),
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(fixture.baseUrl) },
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false },
    logLevel: 'error',
  })
  t.after(() => dev.close())
  await dev.listen()
  const turn = fixture.app.sqliteRepository.createTurn(fixture.task.id, 'cross-origin-media')
  fixture.app.sqliteRepository.updateTurn(turn.id, { status: 'completed' })
  for (const ext of ['mp4', 'm4a']) fs.copyFileSync(process.env.PROMPTX_TEST_VIDEO || new URL('./fixtures/preview.mp4', import.meta.url), path.join(fixture.workspace, `cross-origin.${ext}`))
  fixture.app.sqliteRepository.appendTimeline(fixture.task.id, turn.id, {
    type: 'assistant_message', messageId: 'cross-origin-media', phase: 'final_answer', text: '[跨端口视频](cross-origin.mp4)',
  })
  const page = await fixture.browser.newPage()
  const failures = collectPageFailures(page)
  await page.goto(origin)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByRole('link', { name: '跨端口视频', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.currentTime > 0, null, { timeout: 10000 })
  await saveScreenshot(page, 'local-cross-origin-video.png')
  await page.getByRole('button', { name: '关闭预览', exact: true }).click()
  await page.getByRole('button', { name: '浏览文件', exact: true }).click()
  const inspector = page.locator('.workspace-inspector:visible')
  await inspector.getByTitle('cross-origin.m4a', { exact: true }).click()
  await inspector.getByRole('button', { name: '播放音频', exact: true }).click()
  await page.waitForFunction(() => document.querySelector('[aria-label="音频预览"] audio')?.currentTime > 0, null, { timeout: 10000 })
  assert.ok(requests.length >= 2)
  assert.ok(requests.every(request => request.origin === origin && request.range?.startsWith('bytes=')))
  assert.deepEqual(failures, [])
})

test('手机禁止自动播放时，元数据就绪后仍显示播放控件，可手动播放', async t => {
  const fixture = await createFixture(t)
  fs.copyFileSync(new URL('./fixtures/preview.mp4', import.meta.url), path.join(fixture.workspace, 'manual-play.mp4'))
  const turn = fixture.app.sqliteRepository.createTurn(fixture.task.id, 'manual-play')
  fixture.app.sqliteRepository.updateTurn(turn.id, { status: 'completed' })
  fixture.app.sqliteRepository.appendTimeline(fixture.task.id, turn.id, { type: 'assistant_message', messageId: 'manual-play', phase: 'final_answer', text: '[手动播放测试](manual-play.mp4)' })
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play
    window.restoreMediaPlay = () => { HTMLMediaElement.prototype.play = play }
    HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException('自动播放已禁止', 'NotAllowedError'))
    // 模拟手机仅预加载元数据，不向组件发布首帧就绪事件。
    window.addEventListener('loadeddata', event => event.stopImmediatePropagation(), true)
  })
  await page.goto(fixture.baseUrl)
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await page.getByRole('link', { name: '手动播放测试', exact: true }).click()
  const viewer = page.getByRole('dialog', { name: '视频预览' })
  await viewer.waitFor()
  await page.waitForFunction(() => { const video = document.querySelector('[aria-label="视频预览"] video'); return video?.readyState >= 1 && !video.classList.contains('opacity-0') })
  assert.equal(await viewer.locator('.media-preview-placeholder').count(), 0)
  assert.equal(await viewer.locator('video').evaluate(element => element.controls && element.paused), true)
  await page.evaluate(() => window.restoreMediaPlay())
  await viewer.locator('video').evaluate(element => element.play())
  await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.currentTime > 0)
  await viewer.getByRole('button', { name: '关闭预览' }).click()
  await viewer.waitFor({ state: 'detached' })
})

test('大视频在本地与加密 Relay 分段播放、跳转进度和关闭，远程不整段下载', async t => {
  const fixture = await createFixture(t)
  const videoPath = path.join(fixture.workspace, 'large-video.mp4')
  fs.copyFileSync(process.env.PROMPTX_TEST_VIDEO || new URL('./fixtures/preview.mp4', import.meta.url), videoPath)
  if (!process.env.PROMPTX_TEST_VIDEO) {
    const padding = Buffer.alloc(8)
    padding.writeUInt32BE(294 * 1024 * 1024)
    padding.write('free', 4)
    fs.appendFileSync(videoPath, padding)
    fs.truncateSync(videoPath, fs.statSync(videoPath).size + 294 * 1024 * 1024 - 8)
  }
  const repository = fixture.app.sqliteRepository
  const turn = repository.createTurn(fixture.task.id, 'large-video')
  repository.updateTurn(turn.id, { status: 'completed' })
  repository.appendTimeline(fixture.task.id, turn.id, { type: 'assistant_message', messageId: 'large-video', phase: 'final_answer', text: '[播放大视频](large-video.mp4)' })
  const relay = await startRelayServer({ logger: false, webDistDir: webRoot, config: { host: '127.0.0.1', port: 0 } })
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-video-relay-'))
  const service = new RelayService({ localBaseUrl: fixture.baseUrl, logger: false, configPath: path.join(temp, 'config.json'), identityPath: path.join(temp, 'identity.json') })
  t.after(async () => { service.stop(); await relay.close(); fs.rmSync(temp, { recursive: true, force: true }) })
  service.updateConfig({ enabled: true, relayUrl: `ws://127.0.0.1:${relay.port}/relay/ws`, appUrl: `http://127.0.0.1:${relay.port}` })
  const ranges = []
  const forward = service.forward.bind(service)
  let releaseTail, tailWaiting = false, slowCanceled = false, slowProbe = false
  let tailGate = new Promise(resolve => { releaseTail = resolve })
  t.after(() => releaseTail())
  service.forward = async (channel, request) => {
    if (slowProbe && request.path.includes('/file/content?path=large-video.mp4') && request.headers.range === 'bytes=0-262143') {
      request.controller = new AbortController()
      request.controller.signal.addEventListener('abort', () => { slowCanceled = true; releaseTail() }, { once: true })
      const requestId = request.requestId
      service.sendEncrypted(channel, { type: 'response.start', requestId, status: 206, headers: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-262143/262144' } })
      request.credit -= 64 * 1024
      service.sendEncrypted(channel, { type: 'response.body', requestId, bytes: new Uint8Array(64 * 1024).fill(73) })
      tailWaiting = true
      await tailGate
      if (!request.controller.signal.aborted) {
        request.credit -= 192 * 1024
        service.sendEncrypted(channel, { type: 'response.body', requestId, bytes: new Uint8Array(192 * 1024).fill(74) })
        service.sendEncrypted(channel, { type: 'response.end', requestId })
      }
      service.finishRequest(channel, request)
      return
    }
    if (request.path.includes('/file/content?path=large-video.mp4')) ranges.push(request.headers.range)
    return forward(channel, request)
  }
  for (const remote of [false, true]) {
    const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
    const failures = collectPageFailures(page)
    let socketCount = 0
    page.on('websocket', () => { socketCount += 1 })
    if (remote) {
      // 等待独立测试 Relay 完成注册，不使用用户的配对或会话。
      for (let attempts = 0; !service.getStatus().connected && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(service.getStatus().connected, true)
    }
    await page.goto(remote ? service.getOffer().url : fixture.baseUrl)
    if (remote) await page.waitForFunction(() => navigator.serviceWorker.controller?.state === 'activated')
    await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByRole('link', { name: '播放大视频', exact: true }).click()
    const viewer = page.getByRole('dialog', { name: '视频预览' })
    await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.readyState >= 2, null, { timeout: 20000 })
    const video = viewer.locator('video')
    await video.evaluate(element => { element.pause(); element.currentTime = element.duration * 0.8 })
    await page.waitForFunction(() => { const video = document.querySelector('[aria-label="视频预览"] video'); return video && !video.seeking && video.readyState >= 2 }, null, { timeout: 20000 })
    if (remote) {
      assert.match(await video.getAttribute('src'), /__promptx_video/)
      const size = fs.statSync(videoPath).size
      const probe = await video.evaluate(async (element, size) => {
        const response = await fetch(element.src, { headers: { Range: `bytes=${size - 8}-${size - 1}` } })
        return { status: response.status, range: response.headers.get('content-range'), size: (await response.arrayBuffer()).byteLength }
      }, size)
      assert.equal(probe.status, 206)
      assert.equal(probe.size, 8)
      assert.equal(probe.range, `bytes ${size - 8}-${size - 1}/${size}`)
      const metadata = await video.evaluate(async element => {
        const response = await fetch(element.src, { method: 'HEAD' })
        return { status: response.status, size: Number(response.headers.get('content-length')) }
      })
      assert.deepEqual(metadata, { status: 200, size })
      assert.equal(socketCount, 2, '会话与媒体分别复用一条加密连接')
      const sourceUrl = await video.getAttribute('src')
      slowProbe = true
      const streamingProbe = await page.evaluate(async sourceUrl => {
        const response = await fetch(sourceUrl, { headers: { Range: 'bytes=0-262143' } })
        window.streamProbeReader = response.body.getReader()
        const { value } = await window.streamProbeReader.read()
        return { status: response.status, bytes: value.length, firstByte: value[0] }
      }, sourceUrl)
      assert.deepEqual(streamingProbe, { status: 206, bytes: 64 * 1024, firstByte: 73 })
      assert.equal(tailWaiting, true, '尾段尚未释放就能读到首段')
      releaseTail()
      assert.equal(await page.evaluate(async () => {
        let bytes = 0
        while (true) { const { value, done } = await window.streamProbeReader.read(); if (done) return bytes; bytes += value.length }
      }), 192 * 1024)
      tailGate = new Promise(resolve => { releaseTail = resolve })
      tailWaiting = false
      await page.evaluate(async sourceUrl => {
        const response = await fetch(sourceUrl, { headers: { Range: 'bytes=0-262143' } })
        const reader = response.body.getReader()
        await reader.read()
        await reader.cancel()
      }, sourceUrl)
      for (let attempt = 0; !slowCanceled && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(slowCanceled, true, '取消浏览器读取会取消 Daemon 流式请求')
      slowProbe = false
      assert.ok(ranges.length > 0 && ranges.every(range => {
        const match = /^bytes=(\d+)-(\d+)$/.exec(range || '')
        return match && Number(match[2]) - Number(match[1]) < 1024 * 1024
      }))
    }
    await viewer.getByRole('button', { name: '关闭预览' }).click()
    await viewer.waitFor({ state: 'detached' })
    if (remote) {
      await page.addInitScript(() => {
        ServiceWorkerRegistration.prototype.update = () => new Promise(() => {})
        ServiceWorkerContainer.prototype.register = () => Promise.reject(new Error('已有 Worker 不应重复注册'))
      })
      await page.reload()
      await page.locator('.timeline:visible').waitFor()
      await page.getByRole('link', { name: '播放大视频', exact: true }).click()
      await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.readyState >= 2, null, { timeout: 20000 })
      await page.getByRole('dialog', { name: '视频预览' }).getByRole('button', { name: '关闭预览' }).click()
    }
    assert.deepEqual(failures, [])
    await page.close()
    ranges.length = 0
  }
})


test('结束轮次的遗留工具不转圈，当前工具运行时转圈，取消后停止', async t => {
  const fixture = await createFixture(t)
  const repository = fixture.app.sqliteRepository
  const oldTurn = repository.listTurns(fixture.task.id)[0]
  repository.appendTimeline(fixture.task.id, oldTurn.id, { type: 'tool_call', callId: 'old-image', name: '旧图片工具', status: 'running', detail: { type: 'imageView' } })
  fixture.runtimeRecords.onTurn = (_, runtime) => {
    runtime.emit('timeline', { type: 'tool_call', callId: 'current-image', name: '当前图片工具', status: 'running', detail: { type: 'imageView' } })
  }
  const page = await fixture.browser.newPage({ viewport: { width: 1280, height: 900 } })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  const turns = page.locator('.timeline-turn')
  await turns.first().locator('.process-toggle').click()
  const oldTool = page.locator('.process-entry').filter({ has: page.getByRole('button', { name: /读取文件/ }).and(page.locator('[title="旧图片工具"]')) })
  await oldTool.waitFor()
  assert.equal(await oldTool.locator('.animate-spin').count(), 0)
  await oldTool.getByLabel('本轮已结束，未收到工具完成状态').waitFor()
  await page.getByPlaceholder('向 Agent 发送消息').fill('保持运行，检查工具状态')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const currentTool = page.locator('.process-entry').filter({ has: page.getByRole('button', { name: /读取文件/ }).and(page.locator('[title="当前图片工具"]')) })
  await currentTool.locator('.animate-spin').waitFor()
  assert.equal(await oldTool.locator('.animate-spin').count(), 0)
  await page.getByRole('button', { name: '停止', exact: true }).click()
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()
  await turns.last().locator('.process-toggle').click()
  await currentTool.waitFor()
  assert.equal(await currentTool.locator('.animate-spin').count(), 0)
  assert.deepEqual(failures, [])
})

test('文件与 Diff 支持拖动分割线，选择大视频后点击按钮播放且关闭后保留左右栏', async t => {
  const fixture = await createFixture(t)
  const file = path.join(fixture.workspace, 'preview.mp4')
  fs.copyFileSync(new URL('./fixtures/preview.mp4', import.meta.url), file)
  const padding = Buffer.alloc(8)
  padding.writeUInt32BE(110 * 1024 * 1024)
  padding.write('free', 4)
  fs.appendFileSync(file, padding)
  fs.truncateSync(file, fs.statSync(file).size + 110 * 1024 * 1024 - 8)
  for (const mobile of [false, true]) {
    const page = await fixture.browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 }, reducedMotion: 'reduce' })
    const failures = collectPageFailures(page)
    await page.goto(fixture.baseUrl)
    if (mobile) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    for (const mode of ['files', 'diff']) {
      await page.getByRole('button', { name: mode === 'files' ? '浏览文件' : '查看 Diff', exact: true }).click()
      const inspector = page.locator('.workspace-inspector:visible')
      const separator = inspector.getByRole('separator')
      await separator.click()
      const list = inspector.locator(mode === 'files' ? '.file-tree' : '.changes-list')
      const before = await list.boundingBox()
      const handle = await separator.boundingBox()
      await page.mouse.move(handle.x + handle.width / 2, handle.y + 100)
      await page.mouse.down()
      await page.mouse.move(handle.x + (mobile ? 40 : 120), handle.y + 100, { steps: 5 })
      await page.mouse.up()
      assert.ok((await list.boundingBox()).width > before.width + 20, JSON.stringify({ mobile, mode, before, after: await list.boundingBox(), ratio: await separator.getAttribute('aria-valuenow') }))
      const ratio = Number(await separator.getAttribute('aria-valuenow'))
      await separator.press('ArrowLeft')
      assert.ok(Number(await separator.getAttribute('aria-valuenow')) < ratio)
      await list.getByTitle('preview.mp4', { exact: true }).click()
      await inspector.getByRole('button', { name: '播放视频', exact: true }).waitFor()
      assert.equal(await page.getByRole('dialog', { name: '视频预览' }).count(), 0)
      await inspector.getByRole('button', { name: '播放视频', exact: true }).click()
      const viewer = page.getByRole('dialog', { name: '视频预览' })
      await viewer.waitFor()
      await page.waitForFunction(() => document.querySelector('[aria-label="视频预览"] video')?.readyState >= 2)
      await viewer.getByRole('button', { name: '关闭预览' }).click()
      await viewer.waitFor({ state: 'detached' })
      assert.equal(await list.isVisible(), true)
      assert.equal(await inspector.getByText('文件过大，暂不支持预览', { exact: true }).count(), 0)
      await inspector.getByRole('button', { name: '播放视频', exact: true }).waitFor()
      await separator.dblclick()
      assert.ok(Math.abs((await list.boundingBox()).width - before.width) < 2)
      await assertNoHorizontalOverflow(page)
      if (mobile) await inspector.getByRole('button', { name: '关闭抽屉' }).click()
      else await page.getByRole('tab', { name: '主回归会话', exact: true }).click()
    }
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('文件标签播放 WAV、M4A、MP4，并兼容旧文件类型返回', async t => {
  const fixture = await createFixture(t)
  fs.copyFileSync(new URL('./fixtures/preview.mp4', import.meta.url), path.join(fixture.workspace, 'sample.mp4'))
  fs.copyFileSync(new URL('./fixtures/preview.m4a', import.meta.url), path.join(fixture.workspace, 'sample.m4a'))
  const wav = Buffer.alloc(44 + 16000)
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
  wav.write('data', 36); wav.writeUInt32LE(16000, 40)
  fs.writeFileSync(path.join(fixture.workspace, 'sample.wav'), wav)
  for (const mobile of [false, true]) {
    const page = await fixture.browser.newPage({ viewport: { width: mobile ? 390 : 1280, height: 844 } })
    const failures = collectPageFailures(page)
    await page.route('**/file?*', async route => {
      const response = await route.fetch()
      const body = await response.json()
      if (body.file && body.file.path.endsWith('.mp4')) body.file.kind = 'too_large'
      await route.fulfill({ response, json: body })
    })
    await page.goto(fixture.baseUrl)
    if (mobile) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    await page.getByRole('button', { name: '浏览文件', exact: true }).click()
    const inspector = page.locator('.workspace-inspector:visible')
    for (const ext of ['wav', 'm4a', 'mp4']) {
      await inspector.getByTitle(`sample.${ext}`, { exact: true }).click()
      const play = inspector.getByRole('button', { name: ext === 'mp4' ? '播放视频' : '播放音频', exact: true })
      await play.waitFor()
      assert.equal(await page.getByRole('dialog', { name: /^(音频|视频)预览$/ }).count(), 0)
      await play.click()
      const viewer = page.getByRole('dialog', { name: ext === 'mp4' ? '视频预览' : '音频预览', exact: true })
      await viewer.waitFor()
      const media = viewer.locator(ext === 'mp4' ? 'video' : 'audio')
      await media.evaluate(element => element.play())
      await page.waitForFunction(() => { const el = document.querySelector('[role="dialog"] audio, [role="dialog"] video'); return el?.currentTime > 0 && !el.error })
      await viewer.getByRole('button', { name: '关闭预览' }).click()
      await viewer.waitFor({ state: 'detached' })
      assert.equal(await inspector.getByText('文件过大，暂不支持预览', { exact: true }).count(), 0)
      await assertNoHorizontalOverflow(page)
    }
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('本地默认展开历史与实时工具，保留手动收起和任务结束时的查看状态', { timeout: 60000 }, async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const failures = collectPageFailures(page)
  const requests = []
  page.on('request', request => { if (request.url().includes('/tool-calls/detail')) requests.push(request.url()) })
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.locator('.timeline-turn').first().locator('.process-toggle').click()
  assert.equal(await page.locator('.tool-details').count(), 0)
  assert.equal(requests.length, 0)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '执行过程', exact: true }).click()
  const preference = page.getByRole('checkbox', { name: '自动展开工具详情', exact: true })
  assert.equal(await preference.isChecked(), false)
  await preference.check()
  await page.getByRole('tab', { name: '主回归会话', exact: true }).click()
  const history = page.locator('.timeline-turn').first()
  await history.locator('.tool-details').first().waitFor()
  assert.deepEqual(await history.locator('.tool-toggle').evaluateAll(elements => elements.map(el => el.getAttribute('aria-expanded'))), ['true', 'true'])
  await history.locator('.tool-details').first().getByText('读取文件', { exact: true }).waitFor()
  let liveRuntime
  const toolEvent = (id, status = 'running', output = '自动展开输出') => ({ type: 'tool_call', callId: id, name: id, status, detail: { type: 'commandExecution', command: `echo ${id}`, aggregatedOutput: output } })
  fixture.runtimeRecords.onTurn = (_, runtime) => {
    liveRuntime = runtime
    runtime.emit('timeline', toolEvent('auto-first'))
    runtime.emit('timeline', toolEvent('auto-second'))
  }
  await page.getByPlaceholder('向 Agent 发送消息').fill('保持运行，验证自动展开')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const process = page.locator('.timeline-turn').last()
  const first = process.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="auto-first"]') })
  const second = process.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="auto-second"]') })
  await first.getByText('自动展开输出', { exact: true }).waitFor()
  await second.getByText('自动展开输出', { exact: true }).waitFor()
  await first.locator('.tool-toggle').click()
  liveRuntime.emit('timeline', toolEvent('auto-first', 'completed', '手动收起后更新'))
  liveRuntime.emit('timeline', toolEvent('auto-second', 'completed', '自动展开输出\n完成后继续查看'))
  liveRuntime.emit('turnCompleted', { usage: { inputTokens: 10, outputTokens: 5 } })
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()
  await second.locator('.tool-output').filter({ hasText: '完成后继续查看' }).waitFor()
  assert.equal(await first.locator('.tool-toggle').getAttribute('aria-expanded'), 'false')
  assert.equal(await process.locator('.process-toggle').getAttribute('aria-expanded'), 'true')
  await process.locator('.process-toggle').click()
  await process.locator('.process-toggle').click()
  assert.equal(await first.locator('.tool-toggle').getAttribute('aria-expanded'), 'false')
  await second.locator('.tool-output').filter({ hasText: '完成后继续查看' }).waitFor()
  const beforeReload = requests.length
  await page.reload()
  await page.getByText('回归基线已经准备完成。').waitFor()
  assert.equal(await page.locator('.tool-details').count(), 0)
  assert.equal(requests.length, beforeReload)
  await page.locator('.timeline-turn').last().locator('.process-toggle').click()
  await first.locator('.tool-output').filter({ hasText: '手动收起后更新' }).waitFor()
  await second.locator('.tool-output').filter({ hasText: '完成后继续查看' }).waitFor()
  assert.equal(await first.locator('.tool-toggle').getAttribute('aria-expanded'), 'true')
  assert.ok(requests.length > beforeReload)
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '执行过程', exact: true }).click()
  assert.equal(await preference.isChecked(), true)
  await assertNoHorizontalOverflow(page)
  assert.deepEqual(failures, [])
})

test('自动展开异步增高持续跟随，桌面上滚与手机触摸暂停，手动展开保留位置', { timeout: 90000 }, async t => {
  for (const mobile of [false, true]) {
    const fixture = await createFixture(t)
    const page = await fixture.browser.newPage({ viewport: { width: mobile ? 390 : 1440, height: 844 }, isMobile: mobile, hasTouch: mobile })
    const failures = collectPageFailures(page)
    await page.addInitScript(() => localStorage.setItem('promptx:tools:auto-expand', 'true'))
    let runtime, releaseDetail, detailStarted
    const heldDetail = new Promise(resolve => { releaseDetail = resolve })
    const detailRequest = new Promise(resolve => { detailStarted = resolve })
    t.after(() => releaseDetail())
    await page.route('**/tool-calls/detail?*', async route => {
      const response = await route.fetch()
      detailStarted()
      await heldDetail
      await route.fulfill({ response })
    })
    fixture.runtimeRecords.onTurn = (_, current) => {
      runtime = current
      current.emit('timeline', { type: 'tool_call', callId: 'scroll-tool', name: '滚动测试命令', status: 'running', detail: { type: 'commandExecution', command: 'echo scroll-test', aggregatedOutput: '逐步加载的日志内容\n'.repeat(90) } })
    }
    await page.goto(fixture.baseUrl)
    if (mobile) await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    await page.getByText('回归基线已经准备完成。').waitFor()
    await page.getByPlaceholder('向 Agent 发送消息').fill('保持运行，测试自动展开滚动')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await detailRequest
    const timeline = page.locator('.timeline:visible')
    const waitAtBottom = () => page.waitForFunction(() => {
      const el = [...document.querySelectorAll('.timeline')].find(el => el.clientHeight > 0)
      return el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2
    }, null, { timeout: 5000 }).catch(async error => {
      error.message += JSON.stringify(await page.evaluate(() => ({ top: document.querySelector('.timeline')?.scrollTop, height: document.querySelector('.timeline')?.scrollHeight, jump: document.querySelector('.timeline-jump-button')?.textContent })))
      throw error
    })
    await waitAtBottom()
    releaseDetail()
    const tool = page.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="滚动测试命令"]') })
    await tool.getByRole('button', { name: '展开更多已加载内容', exact: true }).waitFor()
    await waitAtBottom()
    // 模拟图片、字体等未发送 rendered 事件的延迟排版，验证 ResizeObserver 兜底。
    await tool.locator('.tool-details').evaluate(el => {
      const late = document.createElement('div')
      late.className = 'late-layout'
      late.style.height = '480px'
      el.append(late)
    })
    await waitAtBottom()
    assert.equal(await page.locator('.timeline-jump-button').count(), 0)
    await tool.locator('.late-layout').evaluate(el => el.remove())
    await waitAtBottom()
    const beforeUp = await timeline.evaluate(el => el.scrollTop)
    const bounds = await timeline.boundingBox()
    if (mobile) {
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Input.synthesizeScrollGesture', { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 3), yDistance: 250, speed: 600, gestureSourceType: 'touch' })
      await cdp.detach()
    } else {
      await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
      await page.mouse.wheel(0, -250)
    }
    await page.getByRole('button', { name: '正在生成，回到底部', exact: true }).waitFor()
    await page.waitForFunction(top => document.querySelector('.timeline').scrollTop < top - 50, beforeUp)
    // 固定阅读点，后续更新不可把阅读点拖回底部。
    await timeline.evaluate(el => { el.scrollTop = 180; el.dispatchEvent(new Event('scroll')) })
    const readingTop = await timeline.evaluate(el => el.scrollTop)
    runtime.emit('timeline', { type: 'assistant_message', phase: 'commentary', text: '阅读期间的新进度\n'.repeat(40) })
    await page.getByText('阅读期间的新进度', { exact: false }).first().waitFor()
    assert.ok(Math.abs(await timeline.evaluate(el => el.scrollTop) - readingTop) < 3)
    await page.getByRole('button', { name: '正在生成，回到底部', exact: true }).click()
    await waitAtBottom()
    runtime.emit('timeline', { type: 'assistant_message', phase: 'commentary', text: '恢复跟随后追加内容\n'.repeat(20) })
    await page.getByText('恢复跟随后追加内容', { exact: false }).first().waitFor()
    await waitAtBottom()
    // 浏览器键盘及滚动条方向判断：上滚暂停，手动滚到底恢复。
    await timeline.focus()
    const beforePageUp = await timeline.evaluate(el => el.scrollTop)
    await page.keyboard.press('PageUp')
    await page.getByRole('button', { name: '正在生成，回到底部', exact: true }).waitFor()
    await page.waitForFunction(top => document.querySelector('.timeline').scrollTop < top - 50, beforePageUp)
    await page.keyboard.press('ControlOrMeta+End')
    await waitAtBottom()
    await page.locator('.timeline-jump-button').waitFor({ state: 'detached' })
    // 模拟滚动条拖动，未通过滚轮或触摸事件也能恢复跟随。
    await timeline.evaluate(el => { el.scrollTop -= 200; el.dispatchEvent(new Event('scroll')) })
    await page.getByRole('button', { name: '正在生成，回到底部', exact: true }).waitFor()
    await timeline.evaluate(el => { el.scrollTop = el.scrollHeight; el.dispatchEvent(new Event('scroll')) })
    await waitAtBottom()
    await page.locator('.timeline-jump-button').waitFor({ state: 'detached' })
    runtime.emit('turnCompleted', { usage: { inputTokens: 1, outputTokens: 1 } })
    await page.getByRole('button', { name: '发送', exact: true }).waitFor()
    await waitAtBottom()
    // 返回工具按钮所在位置，点击只扩大本地正文，不强制跳到最新消息。
    const more = tool.getByRole('button', { name: '展开更多已加载内容', exact: true })
    await more.scrollIntoViewIfNeeded()
    const beforeMore = await timeline.evaluate(el => el.scrollTop)
    const beforeText = await tool.locator('.tool-output').last().textContent()
    await more.click()
    await page.waitForFunction(length => [...document.querySelectorAll('.tool-output')].at(-1)?.textContent.length > length, beforeText.length)
    assert.ok(Math.abs(await timeline.evaluate(el => el.scrollTop) - beforeMore) < 3)
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('工具详情在桌面和手机原地展开，Relay 按需分页并缓存完成结果', { timeout: 90000 }, async t => {
  const fixture = await createFixture(t)
  const repository = fixture.app.sqliteRepository
  const turn = repository.createTurn(fixture.task.id, 'tool-details')
  repository.updateTurn(turn.id, { status: 'completed' })
  repository.appendTimeline(fixture.task.id, turn.id, { type: 'user_message', clientMessageId: 'tool-details', content: [{ type: 'text', text: '测试工具详情' }] })
  repository.appendTimeline(fixture.task.id, turn.id, { type: 'tool_call', callId: 'large-bash', name: 'Bash', status: 'completed', detail: { type: 'claude_tool', input: { command: 'echo detail-demo', description: '详情演示' }, output: '日志内容😀\n'.repeat(50000) } })
  const examples = [
    { callId: 'native-diff', name: 'Codex 修改', detail: { type: 'fileChange', changes: [{ path: 'demo.js', diff: '@@ -1,1 +1,1 @@\n-const value = 1\n+const value = 2' }] } },
    { callId: 'edit-diff', name: 'Edit', detail: { type: 'claude_tool', input: { file_path: '/tmp/demo.js', old_string: 'const value = 1', new_string: 'const value = 3' } } },
    { callId: 'read-code', name: 'Read', detail: { type: 'claude_tool', input: { file_path: '/tmp/demo.js' }, output: 'const value = "hello"' } },
    { callId: 'ansi-shell', name: '终端命令', detail: { type: 'commandExecution', command: 'echo status', cwd: '/tmp', aggregatedOutput: '\u001b[32m完成\u001b[0m', exitCode: 0, durationMs: 1234 } },
  ]
  for (const example of examples) repository.appendTimeline(fixture.task.id, turn.id, { type: 'tool_call', status: 'completed', ...example })
  repository.appendTimeline(fixture.task.id, turn.id, { type: 'assistant_message', phase: 'final_answer', text: '详情测试就绪' })
  const relay = await startRelayServer({ logger: false, webDistDir: webRoot, config: { host: '127.0.0.1', port: 0 } })
  const service = new RelayService({ localBaseUrl: fixture.baseUrl, logger: false, configPath: path.join(fixture.root, 'detail-relay.json'), identityPath: path.join(fixture.root, 'detail-identity.json') })
  t.after(async () => { service.stop(); await relay.close() })
  service.updateConfig({ enabled: true, relayUrl: `ws://127.0.0.1:${relay.port}/relay/ws`, appUrl: `http://127.0.0.1:${relay.port}` })
  const requests = []
  const forward = service.forward.bind(service)
  service.forward = (channel, request) => {
    if (request.path.includes('/tool-calls/detail')) requests.push(request.path)
    return forward(channel, request)
  }
  for (const remote of [false, true]) {
    const page = await fixture.browser.newPage({ viewport: remote ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: remote })
    const failures = collectPageFailures(page)
    const localRequests = []
    // 即使浏览器曾开启本地自动展开，Relay 仍保持按需读取。
    if (remote) await page.addInitScript(() => localStorage.setItem('promptx:tools:auto-expand', 'true'))
    page.on('request', request => { if (request.url().includes('/tool-calls/detail')) localRequests.push(request.url()) })
    if (remote) {
      for (let attempts = 0; !service.getStatus().connected && attempts < 100; attempts++) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(service.getStatus().connected, true)
    }
    await page.goto(remote ? service.getOffer().url : fixture.baseUrl)
    await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    const process = page.locator('.timeline-turn').filter({ hasText: '测试工具详情' })
    await process.locator('.process-toggle').click()
    const tool = process.locator('.timeline-tool').filter({ hasText: '详情演示' })
    await tool.waitFor()
    assert.equal(remote ? requests.length : localRequests.length, 0)
    await tool.locator('.tool-toggle').click()
    await tool.getByText('echo detail-demo', { exact: true }).waitFor()
    await tool.getByRole('button', { name: '加载更多', exact: true }).waitFor()
    assert.equal(await page.getByRole('dialog').count(), 0)
    const initialLength = await tool.locator('.tool-output').last().textContent().then(text => text.length)
    const beforeExpand = remote ? requests.length : localRequests.length
    await tool.getByRole('button', { name: '展开更多已加载内容', exact: true }).click()
    await page.waitForFunction(length => [...document.querySelectorAll('.tool-output')].at(-1)?.textContent.length > length, initialLength)
    assert.equal(remote ? requests.length : localRequests.length, beforeExpand)
    assert.equal(await tool.locator('.tool-output').last().evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap')
    assert.equal(await tool.locator('.tool-output').last().evaluate(el => el.scrollHeight <= el.clientHeight + 1), true)
    await tool.getByRole('button', { name: '加载更多', exact: true }).click()
    await page.waitForFunction(() => ![...document.querySelectorAll('.tool-details')].some(element => element.textContent.includes('加载中')))
    assert.ok((remote ? requests.length : localRequests.length) > beforeExpand)
    const before = remote ? requests.length : localRequests.length
    await tool.locator('.tool-toggle').click()
    await tool.locator('.tool-toggle').click()
    await tool.getByText('echo detail-demo', { exact: true }).waitFor()
    assert.equal(remote ? requests.length : localRequests.length, before)
    await process.locator('.process-toggle').click()
    await process.locator('.process-toggle').click()
    await tool.getByText('echo detail-demo', { exact: true }).waitFor()
    assert.equal(remote ? requests.length : localRequests.length, before)
    assert.equal(await tool.getByRole('button', { name: '重新加载', exact: true }).count(), 0)
    await tool.locator('pre span[style]').first().waitFor()
    for (const title of ['Codex 修改', 'Edit']) {
      const row = process.locator('.timeline-tool').filter({ has: page.locator(`.tool-toggle[title="${title}"]`) })
      await row.locator('.tool-toggle').click()
      await row.locator('.tool-diff-add').waitFor()
      await row.locator('.tool-diff-delete').waitFor()
      assert.equal(await row.getByText('记录未提供执行结果', { exact: true }).count(), 0)
      assert.equal(await row.getByText('输入参数', { exact: true }).count(), 0)
      assert.notEqual(await row.locator('.tool-diff-add').evaluate(el => getComputedStyle(el).backgroundColor), await row.locator('.tool-diff-delete').evaluate(el => getComputedStyle(el).backgroundColor))
      await row.locator('mark').first().waitFor()
      assert.equal(await row.locator('.tool-output').evaluate(el => getComputedStyle(el).whiteSpace), 'pre')
      await row.getByRole('button', { name: '自动换行', exact: true }).click()
      assert.equal(await row.locator('.tool-output').evaluate(el => getComputedStyle(el).whiteSpace), 'pre-wrap')
    }
    const read = process.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="Read"]') })
    await read.locator('.tool-toggle').click()
    await read.locator('pre span[style]').first().waitFor()
    const shell = process.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="终端命令"]') })
    await shell.locator('.tool-toggle').click()
    await shell.locator('pre span[style*="successText"]').waitFor()
    await shell.locator('.tool-result-meta').getByText('耗时 1.2 秒', { exact: true }).waitFor()
    await shell.locator('.tool-directory').getByText('/tmp', { exact: true }).waitFor()
    if (!remote) {
      await page.evaluate(() => localStorage.setItem('promptx:theme-id', 'promptx-stone-dark'))
      await page.reload()
      await process.locator('.process-toggle').click()
      const diff = process.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="Codex 修改"]') })
      await diff.locator('.tool-toggle').click()
      await diff.locator('.tool-diff-add').waitFor()
      assert.equal(await page.locator('html').getAttribute('data-theme'), 'promptx-stone-dark')
    } else {
      fixture.runtimeRecords.onTurn = (_, runtime) => {
        runtime.emit('timeline', { type: 'tool_call', callId: 'relay-live', name: 'Relay 实时命令', status: 'completed', detail: { type: 'commandExecution', command: 'echo relay', aggregatedOutput: 'relay' } })
      }
      const beforeLive = requests.length
      await page.getByPlaceholder('向 Agent 发送消息').fill('保持运行，验证 Relay 不自动展开')
      await page.getByRole('button', { name: '发送', exact: true }).click()
      const live = page.locator('.tool-toggle[title="Relay 实时命令"]')
      await live.waitFor()
      assert.equal(await live.getAttribute('aria-expanded'), 'false')
      assert.equal(requests.length, beforeLive)
      await page.getByRole('button', { name: '停止', exact: true }).click()
    }
    await assertNoHorizontalOverflow(page)
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('旋转延续当前会话，保留历史标签和分栏，并同步主动切换后的返回记录', { timeout: 60000 }, async t => {
  const fixture = await createFixture(t)
  for (const existing of [false, true]) {
    const layout = createLayout()
    if (existing) {
      openTab(layout, { type: 'session', taskId: fixture.task.id })
      splitGroup(layout, layout.focusedId, 'right')
    }
    openTab(layout, { type: 'session', taskId: fixture.secondaryTask.id })
    openTab(layout, { type: 'settings' })
    const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
    await page.addInitScript(layout => localStorage.setItem('promptx:v2:workbench-tabs', JSON.stringify({ version: 2, layout })), layout)
    await page.goto(fixture.baseUrl)
    await page.getByRole('link', { name: '主回归会话', exact: true }).click()
    const mobilePane = page.locator('.timeline-workspace > .task-timeline-pane')
    await mobilePane.getByPlaceholder('向 Agent 发送消息').fill('会话 1 的草稿')
    await page.setViewportSize({ width: 844, height: 390 })
    await page.locator('.workbench-group.is-focused [role="tab"][aria-selected="true"][aria-label="主回归会话"]').waitFor()
    assert.equal(await page.getByRole('tab', { name: '主回归会话', exact: true }).count(), 1)
    assert.equal(await page.locator('.workbench-group').count(), existing ? 2 : 1)
    assert.equal(await page.getByRole('tab', { name: '设置', exact: true }).count(), 1)
    await page.setViewportSize({ width: 390, height: 844 })
    await mobilePane.locator('.pane-heading[title="主回归会话"]').waitFor()
    assert.equal(await mobilePane.getByPlaceholder('向 Agent 发送消息').inputValue(), '会话 1 的草稿')
    await page.setViewportSize({ width: 844, height: 390 })
    await page.getByRole('tab', { name: '草稿切换会话', exact: true }).click()
    await page.getByRole('tab', { name: '设置', exact: true }).click()
    await page.setViewportSize({ width: 390, height: 844 })
    await mobilePane.locator('.pane-heading[title="草稿切换会话"]').waitFor()
    assert.equal(await page.evaluate(() => history.state.promptxV2MobileTaskId), fixture.secondaryTask.id)
    await mobilePane.getByTitle('返回项目列表').click()
    await page.waitForFunction(() => document.querySelector('.workspace-sidebar')?.classList.contains('mobile-panel-active'))
    await page.goForward()
    await mobilePane.locator('.pane-heading[title="草稿切换会话"]').waitFor()
    await page.close()
  }
})

test('手机草稿在跨断点横竖屏切换后保留，返回时没有重复输入框', { timeout: 30000 }, async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true })
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  const composer = page.getByPlaceholder('向 Agent 发送消息').filter({ visible: true })
  await composer.fill('旋转后保留的草稿')
  await page.setViewportSize({ width: 844, height: 390 })
  await page.locator('.desktop-workbench').waitFor()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('.timeline-workspace > .task-timeline-pane').waitFor()
  await composer.waitFor()
  assert.equal(await composer.inputValue(), '旋转后保留的草稿')
  assert.equal(await composer.count(), 1)
})

test('工具持续输出不饿死详情刷新，分页期间结束仍刷新最终元数据', { timeout: 45000 }, async t => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 1440, height: 1000 } })
  await page.addInitScript(() => localStorage.setItem('promptx:tools:auto-expand', 'true'))
  await page.goto(fixture.baseUrl)
  await page.getByText('回归基线已经准备完成。').waitFor()
  let runtime, tick = 0, output = '初始输出\n'
  const emitTool = (status = 'running', extra = {}) => runtime.emit('timeline', {
    type: 'tool_call', callId: 'refresh-test', name: '刷新回归', status,
    detail: { type: 'commandExecution', command: 'echo refresh-test', aggregatedOutput: output, ...extra },
  })
  fixture.runtimeRecords.onTurn = (_, value) => { runtime = value; emitTool() }
  await page.getByPlaceholder('向 Agent 发送消息').fill('保持运行，刷新回归')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  const tool = page.locator('.timeline-tool').filter({ has: page.locator('.tool-toggle[title="刷新回归"]') })
  await tool.locator('.tool-output').filter({ hasText: '初始输出' }).waitFor()
  const interval = setInterval(() => { output += `增量 ${++tick}\n`; emitTool() }, 80)
  try {
    // 数据持续到达期间必须出现新输出，不能等流停止后才请求详情。
    await tool.locator('.tool-output').filter({ hasText: '增量 2' }).waitFor({ timeout: 5000 })
  } finally { clearInterval(interval) }
  output += '长输出\n'.repeat(20000)
  emitTool()
  const more = tool.getByRole('button', { name: '加载更多', exact: true })
  await more.waitFor()
  let finishDuringPage = false
  await page.route('**/tool-calls/detail?**', async route => {
    const url = new URL(route.request().url())
    if (url.searchParams.get('section') === 'output' && !finishDuringPage) {
      finishDuringPage = true
      const response = await route.fetch()
      emitTool('completed', { exitCode: 0, durationMs: 9000 })
      runtime.emit('turnCompleted', {})
      await page.waitForTimeout(250)
      await route.fulfill({ response })
    } else await route.continue()
  })
  await more.click()
  await tool.locator('.tool-result-meta').getByText('耗时 9.0 秒', { exact: true }).waitFor()
  assert.equal(finishDuringPage, true)
  assert.equal(await tool.getByRole('button', { name: '重新加载', exact: true }).count(), 0)
})
