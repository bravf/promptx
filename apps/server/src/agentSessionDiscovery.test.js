import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  decodeClaudeProjectPath,
  listKnownClaudeCodeSessions,
  listKnownKimiCodeSessions,
  listKnownOpenCodeSessions,
} from './agentSessionDiscovery.js'

test('decodeClaudeProjectPath decodes unix-style project keys', () => {
  assert.equal(
    decodeClaudeProjectPath('-Users-bravf-code-promptx'),
    '/Users/bravf/code/promptx'
  )
})

test('listKnownClaudeCodeSessions merges transcripts and project files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const transcriptDir = path.join(claudeHome, 'transcripts')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf-code-promptx')

  fs.mkdirSync(transcriptDir, { recursive: true })
  fs.mkdirSync(projectsDir, { recursive: true })

  const transcriptPath = path.join(transcriptDir, 'ses_transcript_only.jsonl')
  const projectPath = path.join(projectsDir, 'ses_project.jsonl')

  fs.writeFileSync(transcriptPath, `${JSON.stringify({ type: 'user', message: { text: '请继续修复 PromptX' } })}\n`)
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: '帮我看下项目源码' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(transcriptPath, now, now)
  fs.utimesSync(projectPath, new Date(now.getTime() + 1000), new Date(now.getTime() + 1000))

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/code/promptx',
    })

    assert.equal(items.length, 2)
    assert.deepEqual(
      items.map((item) => ({
        id: item.id,
        cwd: item.cwd,
        matchedCwd: item.matchedCwd,
      })),
      [
        {
          id: 'ses_project',
          cwd: '/Users/bravf/code/promptx',
          matchedCwd: true,
        },
        {
          id: 'ses_transcript_only',
          cwd: '',
          matchedCwd: false,
        },
      ]
    )
    assert.match(items[0].label, /项目源码|promptx/i)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownOpenCodeSessions discovers sessions from desktop dat files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-opencode-discovery-'))
  const dataDir = path.join(tempRoot, 'ai.opencode.desktop')
  fs.mkdirSync(dataDir, { recursive: true })

  const globalPath = path.join(dataDir, 'opencode.global.dat')
  const workspacePath = path.join(
    dataDir,
    `opencode.workspace.${Buffer.from('/Users/bravf/code/promptx').toString('base64')}.test.dat`
  )

  fs.writeFileSync(globalPath, JSON.stringify({
    'layout.page': JSON.stringify({
      lastProjectSession: {
        '/Users/bravf/code/promptx': {
          directory: '/Users/bravf/code/promptx',
          id: 'ses_global',
          at: '2026-04-13T08:00:00.000Z',
        },
      },
      lastSession: {
        '/Users/bravf/code/promptx': 'ses_last',
      },
    }),
  }))

  fs.writeFileSync(workspacePath, JSON.stringify({
    'session:ses_global:comments': '[]',
    'session:ses_workspace:prompt': '请继续处理前端主题',
  }))

  try {
    const items = listKnownOpenCodeSessions({
      openCodeDataDir: dataDir,
      openCodeDbPath: path.join(tempRoot, 'missing-opencode.db'),
      cwd: '/Users/bravf/code/promptx',
      limit: 10,
    })

    assert.deepEqual(
      items.map((item) => ({
        id: item.id,
        cwd: item.cwd,
        matchedCwd: item.matchedCwd,
      })),
      [
        { id: 'ses_global', cwd: '/Users/bravf/code/promptx', matchedCwd: true },
        { id: 'ses_workspace', cwd: '/Users/bravf/code/promptx', matchedCwd: true },
        { id: 'ses_last', cwd: '/Users/bravf/code/promptx', matchedCwd: true },
      ]
    )
    assert.match(items[1].label, /前端主题/)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownKimiCodeSessions merges kimi.json work dirs with session state', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-kimi-discovery-'))
  const kimiHome = path.join(tempRoot, '.kimi')
  const sessionDir = path.join(kimiHome, 'sessions', 'hash-1', 'kimi-session-1')
  fs.mkdirSync(sessionDir, { recursive: true })

  const kimiJsonPath = path.join(kimiHome, 'kimi.json')
  const statePath = path.join(sessionDir, 'state.json')
  const contextPath = path.join(sessionDir, 'context.jsonl')
  const kimiJsonTime = new Date('2026-04-13T08:00:00.000Z')
  const stateTime = new Date('2026-04-13T09:00:00.000Z')

  fs.writeFileSync(kimiJsonPath, JSON.stringify({
    work_dirs: [
      {
        path: '/Users/bravf/code/promptx',
        last_session_id: 'kimi-session-1',
      },
    ],
  }))
  fs.writeFileSync(statePath, JSON.stringify({
    custom_title: '继续 Kimi 项目',
  }))
  fs.writeFileSync(contextPath, `${JSON.stringify({ role: 'user', content: '帮我修复 Kimi 接入' })}\n`)
  fs.utimesSync(kimiJsonPath, kimiJsonTime, kimiJsonTime)
  fs.utimesSync(statePath, stateTime, stateTime)

  try {
    const items = listKnownKimiCodeSessions({
      kimiHome,
      limit: 10,
      cwd: '/Users/bravf/code/promptx',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        label: items[0].label,
        cwd: items[0].cwd,
        updatedAt: items[0].updatedAt,
        updatedAtSource: items[0].updatedAtSource,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'kimi-session-1',
        label: '继续 Kimi 项目',
        cwd: '/Users/bravf/code/promptx',
        updatedAt: stateTime.toISOString(),
        updatedAtSource: 'explicit',
        matchedCwd: true,
      }
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})
