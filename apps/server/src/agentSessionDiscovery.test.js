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

test('listKnownClaudeCodeSessions reads real cwd from session file when project key contains dots', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-dot-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf--claude')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_dot.jsonl')
  fs.writeFileSync(
    projectPath,
    `${JSON.stringify({ type: 'user', message: { text: '看下配置' }, cwd: '/Users/bravf/.claude' })}
`
  )

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/.claude',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_dot',
        cwd: '/Users/bravf/.claude',
        matchedCwd: true,
      }
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions reads cwd from large Claude jsonl files', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-large-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf--config')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_large.jsonl')
  const firstLine = `${JSON.stringify({ type: 'user', message: { text: '读取大文件历史' }, cwd: '/Users/bravf/.config' })}\n`
  fs.writeFileSync(projectPath, `${firstLine}${'x'.repeat(300 * 1024)}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/.config',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_large',
        cwd: '/Users/bravf/.config',
        matchedCwd: true,
      }
    )
    assert.match(items[0].label, /读取大文件历史|config/i)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions matches encoded project key when session file has no cwd', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-encoded-cwd-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf--claude')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_encoded_cwd.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: '继续之前的任务' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/.claude',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_encoded_cwd',
        cwd: '/Users/bravf/.claude',
        matchedCwd: true,
      }
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions matches encoded project key with trailing cwd slash', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-trailing-cwd-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf--claude')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_trailing_cwd.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: '继续之前的任务' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/.claude/',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_trailing_cwd',
        cwd: '/Users/bravf/.claude',
        matchedCwd: true,
      }
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions scans target project before global file limit', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-target-first-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsRoot = path.join(claudeHome, 'projects')
  const targetDir = path.join(projectsRoot, '-zzzz--claude')

  fs.mkdirSync(targetDir, { recursive: true })

  for (let index = 0; index < 805; index += 1) {
    const fillerDir = path.join(projectsRoot, `-Users-bravf-code-filler-${String(index).padStart(3, '0')}`)
    fs.mkdirSync(fillerDir, { recursive: true })
    fs.writeFileSync(
      path.join(fillerDir, `ses_filler_${index}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { text: `无关历史 ${index}` } })}\n`
    )
  }

  const projectPath = path.join(targetDir, 'ses_target_first.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: '目标项目历史' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/zzzz/.claude',
    })

    assert.equal(items[0]?.id, 'ses_target_first')
    assert.equal(items[0]?.cwd, '/zzzz/.claude')
    assert.equal(items[0]?.matchedCwd, true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions matches realpath project key for symlink cwd', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-realpath-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const realCwd = path.join(tempRoot, 'real-workspace')
  const linkCwd = path.join(tempRoot, 'link-workspace')

  fs.mkdirSync(realCwd, { recursive: true })
  fs.symlinkSync(realCwd, linkCwd, 'dir')

  const realProjectKey = fs.realpathSync.native(realCwd).replace(/[/:.]/g, '-')
  const projectsDir = path.join(claudeHome, 'projects', realProjectKey)
  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_realpath_cwd.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: 'symlink 历史' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: linkCwd,
    })

    assert.equal(items[0]?.id, 'ses_realpath_cwd')
    assert.equal(items[0]?.cwd, linkCwd)
    assert.equal(items[0]?.matchedCwd, true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions treats jsonl realpath cwd as matching symlink cwd', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-jsonl-realpath-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const realCwd = path.join(tempRoot, 'real-workspace')
  const linkCwd = path.join(tempRoot, 'link-workspace')

  fs.mkdirSync(realCwd, { recursive: true })
  fs.symlinkSync(realCwd, linkCwd, 'dir')

  const nativeRealCwd = fs.realpathSync.native(realCwd)
  const realProjectKey = nativeRealCwd.replace(/[/:.]/g, '-')
  const projectsDir = path.join(claudeHome, 'projects', realProjectKey)
  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_jsonl_realpath_cwd.jsonl')
  fs.writeFileSync(
    projectPath,
    `${JSON.stringify({ type: 'user', message: { text: 'jsonl realpath 历史' }, cwd: nativeRealCwd })}\n`
  )

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: linkCwd,
    })

    assert.equal(items[0]?.id, 'ses_jsonl_realpath_cwd')
    assert.equal(items[0]?.cwd, linkCwd)
    assert.equal(items[0]?.matchedCwd, true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions matches Windows encoded project key case-insensitively', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-windows-cwd-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', 'C--Users-bravf--claude')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_windows_cwd.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: '继续 Windows 任务' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: 'c:\\Users\\bravf\\.claude\\',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_windows_cwd',
        cwd: 'c:/Users/bravf/.claude',
        matchedCwd: true,
      }
    )
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions scans uppercase Windows project key before global file limit', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-windows-target-first-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsRoot = path.join(claudeHome, 'projects')
  const targetDir = path.join(projectsRoot, 'C--Users-bravf--claude')

  fs.mkdirSync(targetDir, { recursive: true })

  for (let index = 0; index < 805; index += 1) {
    const fillerDir = path.join(projectsRoot, `A--Users-bravf-code-filler-${String(index).padStart(3, '0')}`)
    fs.mkdirSync(fillerDir, { recursive: true })
    fs.writeFileSync(
      path.join(fillerDir, `ses_windows_filler_${index}.jsonl`),
      `${JSON.stringify({ type: 'user', message: { text: `无关 Windows 历史 ${index}` } })}\n`
    )
  }

  const projectPath = path.join(targetDir, 'ses_windows_target_first.jsonl')
  fs.writeFileSync(projectPath, `${JSON.stringify({ type: 'user', message: { text: 'Windows 目标项目历史' } })}\n`)

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: 'c:\\Users\\bravf\\.claude\\',
    })

    assert.equal(items[0]?.id, 'ses_windows_target_first')
    assert.equal(items[0]?.cwd, 'c:/Users/bravf/.claude')
    assert.equal(items[0]?.matchedCwd, true)
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
})

test('listKnownClaudeCodeSessions reads cwd from message.cwd when top-level cwd is missing', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'promptx-claude-msgcwd-discovery-'))
  const claudeHome = path.join(tempRoot, '.claude')
  const projectsDir = path.join(claudeHome, 'projects', '-Users-bravf--config')

  fs.mkdirSync(projectsDir, { recursive: true })

  const projectPath = path.join(projectsDir, 'ses_msgcwd.jsonl')
  fs.writeFileSync(
    projectPath,
    `${JSON.stringify({ type: 'user', message: { text: '编辑配置', cwd: '/Users/bravf/.config' } })}
`
  )

  const now = new Date('2026-04-13T08:00:00.000Z')
  fs.utimesSync(projectPath, now, now)

  try {
    const items = listKnownClaudeCodeSessions({
      claudeHome,
      limit: 10,
      cwd: '/Users/bravf/.config',
    })

    assert.equal(items.length, 1)
    assert.deepEqual(
      {
        id: items[0].id,
        cwd: items[0].cwd,
        matchedCwd: items[0].matchedCwd,
      },
      {
        id: 'ses_msgcwd',
        cwd: '/Users/bravf/.config',
        matchedCwd: true,
      }
    )
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
