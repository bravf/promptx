import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readClaudeBackgroundTasks } from './claudeHistory.js'

test('Claude 原生日志恢复命令所属 Agent 和嵌套 Agent，不把普通工具伪造为任务', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-ownership-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const dir = path.join(root, 'session', 'subagents')
  fs.mkdirSync(dir, { recursive: true })
  const write = (id, meta, content) => {
    fs.writeFileSync(path.join(dir, `agent-${id}.meta.json`), JSON.stringify(meta))
    fs.writeFileSync(path.join(dir, `agent-${id}.jsonl`), JSON.stringify({ type: 'assistant', message: { stop_reason: 'end_turn', content } }) + '\n')
  }
  write('parent', { toolUseId: 'spawn-parent', spawnDepth: 1 }, [{ type: 'tool_use', id: 'bash-child', name: 'Bash' }, { type: 'tool_use', id: 'spawn-nested', name: 'Agent' }])
  write('nested', { toolUseId: 'spawn-nested', spawnDepth: 2 }, [{ type: 'tool_use', id: 'deep-bash', name: 'Bash' }, { type: 'text', text: '完成' }])
  const result = readClaudeBackgroundTasks(path.join(root, 'session.jsonl'))
  assert.equal(result.backgroundTasks.length, 2)
  assert.equal(result.backgroundTasks.find(task => task.id === 'nested').parentTaskId, 'parent')
  assert.equal(result.backgroundToolOwners.find(owner => owner.callId === 'bash-child').parentTaskId, 'parent')
  assert.equal(result.backgroundToolOwners.find(owner => owner.callId === 'deep-bash').parentTaskId, 'nested')
  assert.equal(result.backgroundTasks.some(task => task.callId === 'bash-child'), false)
})
