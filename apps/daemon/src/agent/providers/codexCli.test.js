import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseCodexCliVersion } from './codexCli.js'

test('解析 Codex CLI 版本输出', () => {
  assert.equal(parseCodexCliVersion('codex-cli 0.153.2\n'), '0.153.2')
  assert.equal(parseCodexCliVersion('codex 1.2.3-beta.1'), '1.2.3-beta.1')
  assert.equal(parseCodexCliVersion('unknown'), '')
})
