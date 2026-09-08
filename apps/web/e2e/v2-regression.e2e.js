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
import { createApp } from '../../daemon/src/app.js'

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
  ]
  const providers = new Map(definitions.map((definition) => {
    const provider = {
      ...definition,
      capabilities: { models: true, reasoningEffort: true, contextUsage: true },
      createRuntime() {
        const runtime = new EventEmitter()
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
          contextUsage: { percentage: 75, usedTokens: 7500, maxTokens: 10000 },
        })
        runtime.getControlState = async () => control()
        runtime.updateSettings = async (input) => {
          currentModelId = input.modelId || currentModelId
          currentReasoningEffort = input.reasoningEffort || currentReasoningEffort
          runtimeRecords.settings.push({ ...input })
          return control()
        }
        runtime.readHistorySnapshot = async () => ({ status: 'unsupported' })
        runtime.startTurn = async (content) => {
          const text = content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
          runtimeRecords.turns.push(content)
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

async function createFixture(t) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-full-regression-')))
  const runtimeRecords = { settings: [], turns: [], canceled: 0 }
  const port = await availablePort()
  const baseUrl = `http://127.0.0.1:${port}`
  const app = await createApp({
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
      },
    },
    relayOptions: {
      configPath: path.join(root, 'relay-config.json'),
      identityPath: path.join(root, 'relay-identity.json'),
    },
  })
  const seeded = seedWorkspace(root, app.sqliteRepository)
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
  await page.screenshot({ path: path.join(outputDir, name), fullPage: true })
}

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
  await page.locator('.workspace-path-link[title="src/main.js"]').last().click()
  await page.getByText('没有可显示的文本 Diff', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('正在加载 Diff').count(), 0)
  await page.locator('.workspace-inspector:not(.workspace-drawer-leave-active)').getByTitle('关闭抽屉').click()
  await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
  await page.locator('.workspace-path-link[title="README.md"]').click()
  await page.getByText('+工作区修改', { exact: true }).waitFor()
  assert.equal(await page.getByText('只能访问工作区内的相对路径。', { exact: true }).count(), 0)
  await page.locator('.workspace-inspector:not(.workspace-drawer-leave-active)').getByTitle('关闭抽屉').click()
  await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
  await page.getByText('执行测试', { exact: true }).waitFor()

  await page.getByRole('button', { name: '浏览文件' }).click()
  const filesDrawer = page.locator('.workspace-inspector:not(.workspace-drawer-leave-active)')
  await filesDrawer.waitFor()
  await page.waitForTimeout(300)
  await filesDrawer.locator('button[title="README.md"]').click()
  await page.getByText('工作区修改').waitFor()
  await filesDrawer.locator('button[title="pixel.png"]').click()
  await page.getByAltText('pixel.png').waitFor()
  await filesDrawer.locator('button[title="binary.bin"]').click()
  await page.getByText('二进制文件暂不支持预览').waitFor()
  await filesDrawer.locator('button[title="large.txt"]').click()
  await page.getByText('文件过大，暂不支持预览').waitFor()
  assert.equal(await filesDrawer.locator('button[title=".hidden-note"]').count(), 0)
  await filesDrawer.getByTitle('显示点文件').click()
  await filesDrawer.locator('button[title=".hidden-note"]').waitFor()

  await page.getByTitle('查看 Diff').click()
  const diffDrawer = page.locator('.workspace-inspector:not(.workspace-drawer-leave-active)')
  await diffDrawer.getByText('main', { exact: true }).waitFor()
  await diffDrawer.locator('button[title="README.md"]').click()
  await page.getByText('+工作区修改', { exact: true }).waitFor()
  await diffDrawer.locator('button[title="staged.txt"]').click()
  await page.getByText('+staged content', { exact: true }).waitFor()
  await diffDrawer.locator('button[title="untracked.txt"]').click()
  await page.getByText('+untracked content', { exact: true }).waitFor()
  await saveScreenshot(page, 'desktop-diff.png')

  await page.getByTitle('任务详情').click()
  await page.locator('.task-details-drawer').getByRole('heading', { name: '主回归会话' }).waitFor()
  await page.getByText('3 个未提交文件', { exact: true }).waitFor()
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  await page.locator('.task-details-drawer').getByRole('heading', { name: '草稿切换会话' }).waitFor()
  await page.locator('.task-details-drawer').getByTitle('关闭抽屉').click()

  const textarea = page.getByPlaceholder('向 Agent 发送消息')
  await textarea.fill('第二会话草稿')
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  await textarea.fill('主会话草稿')
  await page.getByRole('link', { name: '草稿切换会话', exact: true }).click()
  assert.equal(await textarea.inputValue(), '第二会话草稿')
  await page.getByRole('link', { name: '主回归会话', exact: true }).click()
  assert.equal(await textarea.inputValue(), '主会话草稿')
  await textarea.fill('')

  assert.equal((await page.getByLabel('模型').textContent()).trim(), 'Regression Model')
  assert.equal((await page.getByLabel('思考强度').textContent()).trim(), '中')
  await page.getByLabel('模型').press('ArrowDown')
  await page.getByLabel('模型').press('ArrowDown')
  await page.getByLabel('模型').press('Enter')
  assert.equal((await page.getByLabel('模型').textContent()).trim(), 'Compact Model')
  await page.getByLabel('思考强度').click()
  await page.getByRole('option', { name: '低', exact: true }).click()
  assert.equal(fixture.runtimeRecords.settings.at(-1).reasoningEffort, 'low')
  await page.getByLabel('上下文窗口已使用 75%').waitFor()

  const fileInput = page.locator('input[type="file"]')
  await fileInput.setInputFiles({ name: 'upload.png', mimeType: 'image/png', buffer: png })
  await page.getByText('upload.png', { exact: true }).waitFor()
  await page.getByTitle('预览图片').click()
  await page.getByTitle('关闭预览').click()
  await page.getByTitle('移除附件').click()

  await page.route('**/api/v2/tasks/*/assets', async (route) => {
    await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'upload_failed', message: '模拟上传失败' }) })
  })
  await fileInput.setInputFiles({ name: 'retry.txt', mimeType: 'text/plain', buffer: Buffer.from('retry') })
  await page.getByText('模拟上传失败', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await page.unroute('**/api/v2/tasks/*/assets')
  await page.getByTitle('重试').click()
  await page.getByText('5 B', { exact: true }).waitFor()
  await page.getByTitle('移除附件').click()

  await page.evaluate(() => {
    const input = document.querySelector('input[type="file"]')
    const transfer = new DataTransfer()
    transfer.items.add(new File([new Uint8Array(50 * 1024 * 1024 + 1)], 'oversize.bin', { type: 'application/octet-stream' }))
    input.files = transfer.files
    input.dispatchEvent(new Event('change', { bubbles: true }))
  })
  await page.getByText('附件不能超过 50 MB。', { exact: true }).waitFor()
  assert.equal(await page.getByTitle('重试').count(), 0)
  await page.getByTitle('移除附件').click()

  await textarea.fill('正常发送回归')
  await page.getByTitle('发送').click()
  await page.getByText('已处理：正常发送回归', { exact: true }).waitFor()
  assert.equal(await textarea.inputValue(), '')
  await textarea.fill('保持运行')
  await page.getByTitle('发送').click()
  await page.getByTitle('停止').waitFor()
  assert.equal(await page.getByLabel('模型').isDisabled(), true)
  await page.getByTitle('停止').click()
  await page.getByTitle('发送').waitFor()
  assert.equal(fixture.runtimeRecords.canceled, 1)

  await page.getByRole('button', { name: '全面回归工作区 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click()
  assert.equal(await page.getByLabel('路径').inputValue(), fixture.workspace)
  assert.equal((await page.getByLabel('执行位置').textContent()).trim(), '当前目录')
  await page.getByLabel('执行位置').click()
  await page.getByRole('option', { name: '新建 Worktree', exact: true }).click()
  await page.getByLabel('基线').waitFor()
  await page.getByPlaceholder('Worktree 名称，例如 fix-login').waitFor()
  await page.getByLabel('执行位置').click()
  await page.getByRole('option', { name: '当前目录', exact: true }).click()
  await page.getByLabel('路径').fill(path.join(fixture.root, 'missing-directory'))
  await page.getByRole('button', { name: '创建会话', exact: true }).click()
  await page.getByText('工作区路径不存在或无法访问。', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await page.getByLabel('关闭').click()

  await page.getByRole('button', { name: '全面回归工作区 的更多操作' }).click()
  await page.getByRole('menuitem', { name: '新建会话', exact: true }).click()
  await page.getByLabel('任务标题').fill('界面新增会话')
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
  await page.getByLabel('清空搜索').click()
  await page.getByText('可导入 Codex 会话', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Codex', exact: true }).click()
  await page.getByText('可导入 Codex 会话', { exact: true }).click()
  await page.getByRole('link', { name: '可导入 Codex 会话', exact: true }).waitFor()

  await page.getByRole('button', { name: '设置' }).click()
  await page.getByRole('button', { name: 'Tokyo Night' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'tokyo-night')
  assert.equal(await page.evaluate(() => localStorage.getItem('promptx:theme-id')), 'tokyo-night')
  await page.getByRole('button', { name: '远程访问', exact: true }).click()
  const relayAddress = page.getByLabel('Relay 地址')
  await relayAddress.fill('invalid-relay-url')
  await relayAddress.blur()
  await page.getByText('Relay 地址格式无效。', { exact: true }).waitFor()
  consumeExpectedResourceError(failures)
  await relayAddress.fill('ws://127.0.0.1:9999/relay')
  await relayAddress.blur()
  await page.getByText('配对链接', { exact: true }).waitFor()
  await page.getByRole('button', { name: '重置远程身份' }).click()
  await page.getByRole('button', { name: '取消', exact: true }).click()
  await page.getByRole('button', { name: '关于', exact: true }).click()
  await page.getByText('本地 AI 编程工作台', { exact: true }).waitFor()
  await page.waitForTimeout(250)
  await saveScreenshot(page, 'desktop-settings.png')
  await page.getByLabel('关闭设置').click()
  await assertNoHorizontalOverflow(page)
  assert.deepEqual(failures, [])
})

test('V2 移动端布局、弹层和 History 回归', async (t) => {
  const fixture = await createFixture(t)
  const page = await fixture.browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const failures = collectPageFailures(page)
  await page.goto(fixture.baseUrl, { waitUntil: 'domcontentloaded' })
  await page.getByText('主回归会话', { exact: true }).click()
  await page.getByText('回归基线已经准备完成。').waitFor()
  await page.waitForTimeout(300)
  await assertNoHorizontalOverflow(page)
  await saveScreenshot(page, 'mobile-timeline.png')
  await page.getByTitle('浏览文件').click()
  await page.locator('.workspace-inspector').waitFor()
  await page.waitForTimeout(300)
  await assertNoHorizontalOverflow(page)
  await saveScreenshot(page, 'mobile-files.png')
  await page.getByTitle('关闭抽屉').click()

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
  assert.equal(Math.round(conversationBox.height), 844)
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
    await page.getByLabel('路径').fill(fixture.workspace)
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
      await drawer.getByTitle('关闭抽屉').click()
      await page.locator('.workspace-inspector').waitFor({ state: 'detached' })
    }
    assert.deepEqual(failures, [])
    await page.close()
  }
})
