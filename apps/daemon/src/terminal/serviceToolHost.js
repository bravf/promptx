import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { callServiceTool } from './serviceTools.js'

// 仅连接本机 MCP 子进程。令牌按会话和 Runtime 隔离，不写数据库、不通过 Relay 下发。
export class ServiceToolHost {
  constructor(service) {
    this.service = service
    this.scopes = new Map()
    this.server = createServer((request, response) => { void this.handle(request, response) })
  }
  async listen() {
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve) })
    this.server.unref()
  }
  connect(taskId) {
    const token = randomBytes(32).toString('hex')
    this.scopes.set(token, taskId)
    return { command: process.execPath, args: [fileURLToPath(new URL('./serviceMcpServer.js', import.meta.url))],
      env: { PROMPTX_SERVICE_TOOL_URL: `http://127.0.0.1:${this.server.address().port}/tools`, PROMPTX_SERVICE_TOOL_TOKEN: token },
      release: () => this.scopes.delete(token) }
  }
  async handle(request, response) {
    const send = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(value)) }
    const taskId = this.scopes.get(String(request.headers.authorization || '').replace(/^Bearer /, ''))
    if (request.headers.origin || request.headers['sec-fetch-site'] || request.headers.host !== `127.0.0.1:${this.server.address()?.port}` || !taskId) return send(403, { error: '服务工具连接不可用。' })
    if (request.method !== 'POST' || request.url !== '/tools') return send(404, { error: '接口不存在。' })
    try {
      let body = ''
      for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 65536) return send(413, { error: '请求过大。' }) }
      const { name, arguments: args = {} } = JSON.parse(body)
      const result = await callServiceTool(this.service, taskId, name, args)
      send(200, result)
    } catch (error) { send(error.name === 'ZodError' ? 400 : error.statusCode || 400, { error: error.message }) }
  }
  async close() {
    this.scopes.clear()
    this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
  }
}
