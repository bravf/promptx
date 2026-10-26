import { z } from 'zod'
import { StartServiceSchema, ServiceIdSchema, ServiceLogsSchema } from '../../../../packages/protocol/src/terminal.js'

export const SERVICE_INSTRUCTIONS = '用户要求启动开发服务器、预览、桌面应用、监听或其他需要持续运行的进程时，必须使用 promptx_services 的 start_service 工具，在 PromptX 独立终端中前台运行原始命令。不要用普通命令工具、nohup、后台 & 或后台子 Agent 启动常驻服务。type 必须按用途选择 web（Web 服务）、desktop（桌面应用）、watch（监听任务）、process（通用进程）或 remote（远程连接）。桌面应用直接以前台方式执行 .app/Contents/MacOS/ 中的程序，不使用 open、后台启动或脱离终端的启动器，以便跟踪实际应用进程。桌面应用和监听任务不配置 url、不做 HTTP 就绪验证；running 仅说明进程存活，不代表窗口已显示。远程部署、上传以及通过 SSH 执行 systemctl/docker 等有限的启动或重启命令必须使用普通命令工具，结果留在 Timeline，不创建运行任务。服务器由 systemd/Docker 托管的服务不属于本机运行任务。只有持续维持的 SSH 隧道、端口转发或 SSH 前台程序使用 type=remote，不配置 url；隧道推荐使用 ExitOnForwardFailure=yes，不使用 -f。连接进程存活不等于远程服务健康，停止连接不保证远程程序停止。不要仅凭命令包含 ssh 判定用途。构建、测试等有限命令仍使用普通工具。先用 list_services 检查已有服务；只有 readiness 为 ready 才能声称访问地址可用，unverified 表示进程运行但尚未验证可访问。回复提供服务名、terminalId 和访问地址，用户可在 PromptX 查看终端；手机 Relay 的 localhost 指向手机，不能承诺可通过手机直接访问本机开发端口。停止服务前确认用户的任务意图，不要为释放端口杀掉无关进程。'

export const SERVICE_TOOLS = [
  { name: 'start_service', description: '在当前工作区的 PromptX 独立终端启动运行任务，type 区分 web、desktop、watch、process、remote；只托管需持续维持的前台进程；Agent 回复结束后仍运行。command 使用前台启动命令；cwd 为工作区内目录；url 必须是用户打开的页面主入口，healthUrl 单独指定本机 HTTP 就绪探针；不能把 /api/health、metrics 等接口作为页面地址。相同目录和命令的运行中服务复用，返回终端 ID、就绪状态和启动日志。', schema: StartServiceSchema },
  { name: 'list_services', description: '列出当前会话托管的服务、终端 ID、运行状态和访问地址。', schema: z.object({}).strict() },
  { name: 'read_service_logs', description: '读取服务终端的有界日志；cursor 用于增量读取。', schema: ServiceLogsSchema },
  { name: 'stop_service', description: '停止指定托管服务及子进程，保留终端日志。不会停止 Agent 或其他服务。', schema: ServiceIdSchema },
  { name: 'restart_service', description: '用保存的命令重启已退出的服务，返回新终端 ID。运行中的服务须先 stop_service。', schema: ServiceIdSchema },
]

export function serviceResult(result) {
  if (typeof result.data === 'string') return { ...result, data: result.data.slice(-12000), truncated: result.data.length > 12000 }
  return result
}

export async function callServiceTool(service, taskId, name, args) {
  const tool = SERVICE_TOOLS.find(tool => tool.name === name)
  if (!tool) throw new Error('未知服务工具。')
  const input = tool.schema.parse(args)
  if (name === 'start_service') return serviceResult(await service.startService(taskId, input))
  if (name === 'list_services') return { services: service.listServices(taskId) }
  const session = service.get(taskId, input.terminalId)
  if (!session.service) throw new Error('只能操作当前会话的托管服务。')
  if (name === 'read_service_logs') return serviceResult({ ...service.read(session, input.cursor), terminal: service.describe(session) })
  if (name === 'restart_service') return serviceResult(await service.restartService(taskId, session.id))
  service.stop(session)
  return { terminal: service.describe(session) }
}
