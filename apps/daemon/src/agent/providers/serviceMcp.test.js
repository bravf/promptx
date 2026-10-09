import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { CodexRuntime } from './codex.js'
import { ClaudeRuntime } from './claude.js'
import { kimiProvider } from './kimi.js'
import { grokProvider } from './grok.js'
import { SERVICE_INSTRUCTIONS } from '../../terminal/serviceTools.js'

const serviceMcp = { command: process.execPath, args: ['/tmp/promptx-test-mcp.mjs'], env: { PROMPTX_SERVICE_TOOL_URL: 'http://127.0.0.1:12345/tools', PROMPTX_SERVICE_TOOL_TOKEN: 'test-only-token' } }

test('Codex 新建和恢复会话均注入独立 MCP 与服务指导，保留访问模式', async () => {
  for (const threadId of ['', 'existing']) {
    const calls = []
    const rpc = new EventEmitter()
    rpc.notify = () => {}
    rpc.close = () => {}
    rpc.request = async (method, params) => {
      calls.push({ method, params })
      if (method === 'model/list') return { data: [] }
      if (method.startsWith('thread/')) return { thread: { id: 'existing' } }
      return {}
    }
    const runtime = new CodexRuntime({ cwd: process.cwd(), nativeHandle: { threadId }, rpcFactory: () => rpc, serviceMcp })
    try {
      await runtime.prepareTurn()
      const params = calls.find(call => call.method === (threadId ? 'thread/resume' : 'thread/start')).params
      assert.deepEqual(params.config.mcp_servers.promptx_services, serviceMcp)
      assert.equal(params.developerInstructions, SERVICE_INSTRUCTIONS)
      assert.equal(params.approvalPolicy, 'never')
      assert.equal(params.sandbox, 'danger-full-access')
    } finally { runtime.close() }
  }
})

test('Claude MCP 配置追加系统指导，恢复和原生交互选项保持可用', async () => {
  let options, release
  const done = new Promise(resolve => { release = resolve })
  const runtime = new ClaudeRuntime({ cwd: process.cwd(), nativeHandle: { sessionId: 'existing' }, serviceMcp, queryFactory: input => {
    options = input.options
    return { async *[Symbol.asyncIterator]() { await done }, supportedModels: async () => [], getContextUsage: async () => null, close: release }
  } })
  try {
    await runtime.connect()
    assert.deepEqual(options.mcpServers.promptx_services, { type: 'stdio', ...serviceMcp })
    assert.deepEqual(options.systemPrompt, { type: 'preset', preset: 'claude_code', append: SERVICE_INSTRUCTIONS })
    assert.equal(options.resume, 'existing')
    assert.equal(options.permissionMode, 'bypassPermissions')
    assert.equal(typeof options.canUseTool, 'function')
  } finally { runtime.close() }
})

test('Grok 和 Kimi 在 ACP 新建与恢复时传入相同 MCP 工具配置', async () => {
  const expected = [{ name: 'promptx_services', ...serviceMcp, env: Object.entries(serviceMcp.env).map(([name, value]) => ({ name, value })) }]
  for (const provider of [grokProvider, kimiProvider]) for (const sessionId of ['', 'existing']) {
    const code = `require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
      const q=JSON.parse(line);if(q.id===undefined)return;
      let result={};
      if(q.method==='initialize')result={protocolVersion:1,agentCapabilities:{loadSession:true}};
      if(q.method==='session/new'||q.method==='session/load'){
        if(JSON.stringify(q.params.mcpServers)!==${JSON.stringify(JSON.stringify(expected))}){
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'MCP 配置不匹配'}})+'\\n');return;
        }result={sessionId:'existing'};
      }
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\\n');
    })`
    const runtime = provider.createRuntime({ cwd: process.cwd(), nativeHandle: { sessionId }, serviceMcp })
    runtime.command = process.execPath
    runtime.args = ['-e', code]
    try {
      await runtime.connect()
      assert.equal(runtime.connected, true)
      assert.deepEqual(runtime.mcpServers(), expected)
    } finally { runtime.close() }
  }
})
