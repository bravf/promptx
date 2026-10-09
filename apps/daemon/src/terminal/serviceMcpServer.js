import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { SERVICE_TOOLS, SERVICE_INSTRUCTIONS } from './serviceTools.js'

const url = process.env.PROMPTX_SERVICE_TOOL_URL
const token = process.env.PROMPTX_SERVICE_TOOL_TOKEN
if (!url || !token) throw new Error('缺少 PromptX 服务工具连接。')
const server = new McpServer({ name: 'promptx_services', version: '1.0.0' }, { instructions: SERVICE_INSTRUCTIONS })
for (const tool of SERVICE_TOOLS) {
  server.registerTool(tool.name, { description: tool.description, inputSchema: tool.schema, annotations: { readOnlyHint: ['list_services', 'read_service_logs'].includes(tool.name), openWorldHint: false } }, async args => {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ name: tool.name, arguments: args }), signal: AbortSignal.timeout(25000) })
      const result = await response.json()
      return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(!response.ok ? { isError: true } : {}) }
    } catch { return { isError: true, content: [{ type: 'text', text: '无法连接 PromptX 服务工具，请确认本地服务仍在运行。' }] } }
  })
}
await server.connect(new StdioServerTransport())
