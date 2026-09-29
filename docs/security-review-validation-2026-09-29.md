# 安全、稳定性与正确性修复验证记录

日期：2026-09-29。基线提交：`2a9259e`。

修复最初在独立工作树完成验证。2026-09-29 经用户授权，已同步到 `/Users/bravf/code/promptx`，更新依赖并重启当前目录开发服务（3001/5174），同时完成阿里云 Relay 部署。用户试用后反馈暂未发现问题，并确认提交代码。

## 修复范围

- Daemon 全路径检查本地 Host、实际监听端口与 Origin/Fetch Metadata，覆盖编码路径。生产静态服务使用同一错误处理器，校验失败正确返回 400。
- Relay 升级 v3：低阶 Curve25519 公钥拒绝、Ed25519 控制/数据连接挑战认证、配对秘密认证、HKDF-SHA-256 双向会话密钥、严格帧序号与跨连接重放防护。
- Relay 请求状态去重、并发/缓冲/生命周期限制、慢客户端背压、流取消及迟到响应处理、握手中关闭连接的清理。新安装默认关闭，显式操作才显示配对凭证。
- JSON-RPC stdin 异常与请求超时，Provider 初始化、设置、取消调用超时，Git 超时和输出上限；子进程移除通用 HOST/PORT。Daemon 重复启动锁和端口占用失败退出，监听成功后才恢复旧任务状态。
- Timeline 只合并相邻同类同 phase 消息，定时 flush 异常保留待写队列；SSE 订阅清理与缓冲限制，单个监听者异常隔离。
- 附件原生文本对账、Markdown 美元符号、工具持续刷新和分页完成刷新、运行中工具摘要、手机横竖屏草稿与上传组件保留。
- 更新已知漏洞依赖，约束 brace-expansion 修复版本；发布排除内部审查报告；Daemon 测试强制使用临时数据目录。

## 测试结果

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | 369/369：shared 2、relay 15、protocol 14、daemon 252、web 86 |
| `pnpm test:e2e` | 33/33，通过 Chromium 实际浏览器运行 |
| 最终连接清理修改后的浏览器定向复测 | 3/3：桌面完整流程、Relay 大视频、Relay 详情分页 |
| `pnpm build` | 通过 |
| `pnpm install --frozen-lockfile --ignore-scripts` | 通过，锁文件一致 |
| 独立 `pnpm dev` | 随机端口、临时 HOME；Daemon health 与 Vite 首页通过；测试进程已关闭 |
| `pnpm audit --prod --json` | 0 critical、0 high、0 moderate、0 low |
| `npm pack --dry-run --ignore-scripts` | 通过；使用内部报告占位文件验证排除规则，且确认新运行时模块被打包 |
| `pnpm release:check:imports`、`git diff --check` | 通过 |

负向测试覆盖：非法 Origin/Host、编码路径、Fetch Metadata、低阶公钥、错误配对秘密、签名重放、数据连接身份绑定、会话帧重放/篡改/方向反射、重复 request.end、取消后迟到数据、挂起 JSON-RPC、stdin EPIPE、Git 超时、数据目录锁冲突、端口占用时不改运行中轮次。

浏览器测试覆盖：桌面/手机布局、跨工作区标签和草稿、分栏、导入/新建会话、发送/取消、附件、文件与 Git Diff、终端、视频全屏旋转与音视频预览、本地与 Relay 工具详情分页、自动展开与滚动跟随、持续输出期间刷新、分页期间完成、主题及设置。

测试使用隔离的工作区、数据与 Provider 测试替身；Relay 测试启动真实本地 WebSocket/HTTP 服务，实际加解密及转发。没有调用付费模型执行真实任务，真机 Safari/Android WebView 尚未验证。后续部署验证已确认公网阿里云可用。现有工作区和 Provider 原生日志未清理。

日志保存在 `/tmp/promptx-security-validation/logs`。浏览器截图保存在 `/tmp/promptx-security-validation/screenshots`。

## 升级与边界

1. Relay v3 需要本机 Daemon、Web 和云端 Relay 配套发布，然后在本机重新生成配对链接。v2 链接明确拒绝，不自动降级。会话数据库不清空；首次加载旧身份文件会生成新的 v3 身份。
2. 当前目录开发服务已重启，监听 127.0.0.1:3001/5174。升级前数据库和 Relay 配置、身份备份在 `/Users/bravf/.promptx/backups/before-relay-v3-20260929-150800`，备份含私密数据，仅保存在本机。
3. 本地访问校验不阻止已经控制本机的恶意进程；匿名本地 CLI 仍可访问。没有引入账号系统，也没有修改已讨论的 Provider 权限策略。
4. E2EE 假设客户端代码可信；若提供 Web 脚本的站点失陷，脚本仍能读取配对秘密。文档明确了这一边界。本方案不提供前向保密，也不把依赖审计通过等同于完整安全证明。
5. 历史对账复杂度、Timeline 虚拟化、空闲 Provider 回收、字体体积与发布流程重构不在本轮必要修复范围。

## 本机与阿里云部署验证

- 本地 Daemon 健康检查与 Vite 首页均为 HTTP 200。
- 阿里云 `promptx-relay.service` 为 active；公网首页与本地构建 SHA-256 完全一致。
- 本机 v3 控制连接成功接入 `wss://px.mushayu.com`。
- 使用真实配对信息在内存中建立公网加密客户端，健康检查及工作区列表均返回 HTTP 200，测试客户端随后关闭；凭证没有输出到日志。
- 本地开发日志：`/tmp/promptx-current-dev.log`；部署日志：`/tmp/promptx-relay-deploy-20260929.log`。
