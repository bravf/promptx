# PromptX V2 架构基线

状态：当前实现基线
技术栈：JavaScript、Node.js、Fastify、Vue 3、SQLite

## 1. 产品与边界

V2 是独立版本，不读取或迁移 V1 的任务、文档、Run 和数据库，也不保留旧 Server/Runner 双进程架构。

```text
Workspace
  -> Agent Session
    -> Turn
      -> Timeline Row
```

- Workspace 对应一个经过 `realpath` 规范化的真实目录。
- 同一 Workspace 可包含多条 Codex、Claude 或 Kimi Agent Session。
- Turn 表示一次用户提交。
- Timeline 是跨 Provider 的规范化历史与实时事件视图。

V2 当前不包含账号、团队权限、任务自动化、公开分享、Raw 导出、fork/rewind/worktree 管理或交互式 Provider 权限确认。

## 2. 进程结构

```text
本机 Web / 远程 H5
        |
        | REST + SSE
        v
PromptX Daemon
  |- AgentManager
  |- ProviderRegistry
  |- TimelineStore / SyncCoordinator
  |- Workspace inspection
  |- SQLite
  `- RelayService
        |
        | WSS + E2EE
        v
公共 Relay Server
```

Daemon 是 Workspace 文件、Provider Runtime、Turn 并发和 SQLite 的唯一所有者。Relay Server 位于 `packages/relay/src/server.js`，只负责静态 Web 和密文 WebSocket 转发，不保存 Provider 状态，不解析业务请求。

## 3. 代码所有权

- `apps/daemon/src/agent`：Provider、Runtime、会话导入和历史对账。
- `apps/daemon/src/db`：SQLite Schema 与 Repository。
- `apps/daemon/src/timeline`：Timeline 写入和窗口分页。
- `apps/daemon/src/workspaces`：目录搜索、文件读取和 Git 检查。
- `apps/daemon/src/api`：REST 与 SSE。
- `apps/daemon/src/relay`：Daemon 端 E2EE 隧道。
- `apps/web`：Vue 工作台、移动端 History 和本地内存缓存。
- `packages/protocol`：Zod Schema 与 Timeline 投影。
- `packages/relay`：配对、加密、重放保护和公网 Relay Server。
- `packages/shared`：跨进程日志工具。

## 4. 数据模型

SQLite 默认位于 `~/.promptx/data/promptx-v2.sqlite`，启用 foreign keys、WAL 和 5 秒 busy timeout。

核心表：

- `workspaces`：规范路径、标题、排序与最近打开时间。
- `workspace_assets`：附件元数据与受控存储路径。
- `agent_sessions`：Provider、原生句柄、生命周期、模型配置和 Timeline epoch。
- `agent_turns`：客户端幂等 ID、原生 Turn ID、状态、用量和时间。
- `agent_timeline_rows`：Session 内递增 seq、标准 item 和可选 Provider message ID。
- `agent_timeline_sync_state`：Provider source、revision manifest 和最近同步时间。

同一 Agent Session 通过 SQLite 唯一索引最多保留一个 `queued` 或 `running` Turn。删除 Workspace/Agent 时由外键级联清理其数据。

## 5. Provider

当前 Provider：

- Codex：Codex app-server。
- Claude：Claude Agent SDK 与本地历史 JSONL。
- Kimi：ACP Runtime 与本地 wire JSONL。

`native_handle_json` 只保存恢复原生会话所需的最小句柄。SDK 对象、子进程、AbortController、密钥和认证信息不得持久化。

会话导入先扫描 Provider 本地历史，使用 5 秒快照缓存并合并并发扫描。列表按最近活动时间排序，标题、目录、Session ID 和消息预览均参与搜索。首次导入若历史同步失败，会回滚新 Agent，并清理本次新建且仍为空的 Workspace。

## 6. Turn 与 Timeline

Turn 状态：

```text
queued -> running -> completed
                  -> failed
                  -> canceled
```

客户端生成 `clientMessageId`，重复提交复用原 Turn。Agent 正在运行时输入框可继续编辑内存草稿，但不能发送第二个 Turn。

Timeline Row 使用 Session 内严格递增的 `seq`。`item.type` 由 `packages/protocol/src/timeline.js` 定义，包括用户消息、思考、助手消息、工具、Todo、系统提示和错误。

读取策略：

- `tail`：首次进入只读末尾窗口。
- `before`：向前加载历史，不触发 Provider 同步。
- `after`：SSE 重连后补齐增量。
- epoch 失效或出现序列缺口时返回 `reset=true` 和最新尾页。

前端为最近访问的 Agent 保存固定数量的内存 Timeline 快照。首次进入显示骨架；切回缓存 Agent 时立即展示旧内容并后台同步；局部操作使用局部 loading。草稿只存在当前页面内存中，不写 storage，也不同步多端。

## 7. 历史对账

`TimelineSyncCoordinator` 合并同一 Agent 的并发同步请求；同步进行中再次触发时最多补跑一次。

`HistoryReconciler` 根据 Provider revision、原生 Turn ID、客户端消息 ID 和规范化用户文本进行匹配：

- 仅尾部新增时 append。
- 中间插入、Provider rewind 或顺序变化时 rebuild 并切换 epoch。
- 保留本地已有的丰富实时工具过程，避免被稀疏历史快照覆盖。
- 事务写入使用 `expectedNextSeq` 校验；读取期间 Timeline 变化时丢弃旧计划并重试。

Provider 历史中的“未结束 Turn”可能来自客户端异常退出，不能单独用作跨客户端全局运行锁。当前运行态以本 Daemon 管理的 Runtime 和持久 Agent 生命周期为准。

## 8. 文件与 Diff

- 所有路径先按 Workspace 根目录解析，并拒绝 `..` 与越界符号链接。
- 文件预览区分文本、图片、二进制和超大文件。
- Git Diff 使用子进程流式读取，staged 与 unstaged 并行执行。
- 单个 Diff 最多保留 2 MiB 或 8000 行，超过限制立即终止 Git 子进程并返回 `truncated=true`。

## 9. API

公共前缀为 `/api/v2`。当前主要接口：

```text
GET    /health
GET    /providers
GET    /directories/search
GET    /import/sessions
POST   /import/sessions
POST   /conversations

GET    /workspaces
PATCH  /workspaces/:workspaceId
DELETE /workspaces/:workspaceId
GET    /workspaces/:workspaceId/files
GET    /workspaces/:workspaceId/file
GET    /workspaces/:workspaceId/file/content
GET    /workspaces/:workspaceId/git/status
GET    /workspaces/:workspaceId/git/diff
POST   /workspaces/:workspaceId/assets
GET    /assets/:assetId/content

GET    /workspaces/:workspaceId/agents
POST   /workspaces/:workspaceId/agents
GET    /agents/:agentId
DELETE /agents/:agentId
GET    /agents/:agentId/control
PATCH  /agents/:agentId/settings
GET    /agents/:agentId/turns
POST   /agents/:agentId/turns
POST   /agents/:agentId/cancel
POST   /agents/:agentId/archive
POST   /agents/:agentId/attention/clear
GET    /agents/:agentId/timeline
POST   /agents/:agentId/timeline/sync
GET    /agents/:agentId/events
GET    /events

GET    /relay/config
PUT    /relay/config
GET    /relay/status
POST   /relay/reconnect
POST   /relay/identity/reset
```

SSE 每 15 秒发送 heartbeat。断开 SSE 不会取消正在执行的 Turn。

## 10. 安全基线

- Daemon 默认监听 `127.0.0.1:3001`。
- API 拒绝未授权浏览器 Origin；默认允许正式本机地址和 Vite 5173/5174，可通过 `PROMPTX_ALLOWED_ORIGINS` 增加明确 Origin。
- Relay 内部转发剥离浏览器 Origin、Cookie 和 Authorization，再添加内部标识头。
- Relay 使用 Curve25519 + NaCl 建立每连接共享密钥，并使用固定容量 nonce 窗口拒绝重放。
- Relay 身份私钥保存在权限为 `0600` 的本机文件中；完整配对链接视同凭证。
- 公网 Relay 设置帧大小、连接数、等待缓冲、握手、心跳、空闲和频率限制。

## 11. 验证基线

提交前至少执行：

```bash
pnpm test
pnpm build
pnpm test:e2e
pnpm release:check
```

移动端回归至少覆盖进入 Timeline、无横向溢出、浏览器返回工作区列表，以及设置全屏弹层的打开与返回。
