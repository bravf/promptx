import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { test } from 'node:test'

const requireWeb = createRequire(new URL('../../apps/web/package.json', import.meta.url))
const { chromium } = requireWeb('playwright')
const baseUrl = process.env.PROMPTX_QA_WEB_URL || 'http://127.0.0.1:5184'
const apiUrl = process.env.PROMPTX_QA_API_URL || 'http://127.0.0.1:3181'
const screenshots = path.resolve(process.env.PROMPTX_REGRESSION_SCREENSHOT_DIR || 'tmp/qa-20260906/screenshots')

test('开发模式真实前后端连接、主题持久化与三档屏幕尺寸', async (t) => {
  const browser = await chromium.launch({ headless: true })
  t.after(() => browser.close())
  fs.mkdirSync(screenshots, { recursive: true })
  for (const viewport of [{ width: 1920, height: 1080 }, { width: 768, height: 1024 }, { width: 320, height: 568 }]) {
    const page = await browser.newPage({ viewport })
    const failures = []
    page.on('pageerror', (error) => failures.push(error.message))
    page.on('console', (message) => { if (message.type() === 'error') failures.push(message.text()) })
    await page.goto(baseUrl, { waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: '新会话', exact: true }).waitFor()
    const providers = await page.evaluate(async (url) => {
      const response = await fetch(`${url}/api/v2/providers`)
      return { status: response.status, body: await response.json() }
    }, apiUrl)
    assert.equal(providers.status, 200)
    assert.deepEqual(providers.body.providers.map((provider) => provider.id).sort(), ['claude', 'codex', 'kimi'])
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await page.waitForTimeout(300)
    const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, width: document.documentElement.clientWidth }))
    assert.equal(dimensions.scroll, dimensions.width)
    if (viewport.width >= 1024) {
      await page.getByRole('button', { name: 'Tokyo Night' }).click()
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.getByRole('button', { name: '设置', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'tokyo-night')
      await page.getByRole('button', { name: '设置', exact: true }).click()
    }
    await page.screenshot({ path: path.join(screenshots, `dev-settings-${viewport.width}.png`), fullPage: true })
    await page.getByLabel('关闭设置').click()
    await page.getByRole('button', { name: '新会话', exact: true }).click()
    await page.getByLabel('路径').waitFor()
    await page.waitForTimeout(300)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false)
    await page.screenshot({ path: path.join(screenshots, `dev-new-session-${viewport.width}.png`), fullPage: true })
    assert.deepEqual(failures, [])
    await page.close()
  }
})

test('自定义端口托管的生产页面应能新建会话', async (t) => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-qa-custom-port-'))
  const browser = await chromium.launch({ headless: true })
  let createdProjectId
  t.after(async () => {
    await browser.close()
    if (createdProjectId) await fetch(`${apiUrl}/api/v2/projects/${createdProjectId}`, { method: 'DELETE' })
    assert.ok(path.resolve(workspace).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`))
    await fs.promises.rm(workspace, { recursive: true, force: true, maxRetries: 5 })
  })
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
  fs.mkdirSync(screenshots, { recursive: true })
  await page.goto(apiUrl, { waitUntil: 'domcontentloaded' })
  await page.getByRole('button', { name: '新会话', exact: true }).click()
  await page.getByLabel('路径').fill(workspace)
  await page.getByLabel('任务标题').fill('自定义端口回归会话')
  const responsePromise = page.waitForResponse((response) => response.url().endsWith('/api/v2/projects') && response.request().method() === 'POST')
  await page.getByRole('button', { name: '创建会话', exact: true }).click()
  const response = await responsePromise
  const body = await response.json()
  createdProjectId = body.project?.id
  assert.equal(response.status(), 201, JSON.stringify(body))
  await page.getByRole('button', { name: '自定义端口回归会话', exact: true }).waitFor()
  await page.locator('.new-conversation-panel').waitFor({ state: 'detached' })
  await page.screenshot({ path: path.join(screenshots, 'production-custom-port.png'), fullPage: true })
})
