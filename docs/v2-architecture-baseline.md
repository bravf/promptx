# Promptx v2 架构基线

状态：已固定
适用范围：Promptx v2 基础版本
技术栈：JavaScript、Node.js、Fastify、Vue 3、SQLite

## 1. 目标与边界

Promptx v2 是全新版本，不兼容 v1 的任务、项目、文档、运行记录和接口。v2 不读取或迁移 v1 数据，不保留 v1 API，也不为 v1 CLI runner 提供回退路径。

v2 的产品模型固定为：

```text
Daemon
  -> Workspace
    -> Agent Session
      -> Turn
        -> Timeline Row
```

基础版本固定保留：

- Promptx Relay 远程访问能力。
- 当前主题 token、主题切换和持久化能力。
- 工作区文件浏览、文件预览和 Git diff 的基础能力。
- Codex、Claude Code 和 ACP Agent 的本地调用能力。

基础版本不包含：

- v1 任务、项目、BlockEditor、公开分享和 Raw 导出。
- 自动化任务和通知渠道。
- 交互式权限确认 UI。Provider 权限沿用自动放行策略。
- Agent steer、fork、rewind、worktree 管理和多 Agent 编排。
- 插件系统和 MCP 配置 UI。
- OpenCode 专用 Provider。后续可通过 ACP 或专用 Provider 增加。

## 2. 总体结构

v2 固定采用单体本地 Daemon，不再保留 v1 的 Server 与 Runner 双进程边界。

```text
Web / Android
      |
      | REST + SSE
      v
Promptx Daemon
  |- WorkspaceManager
  |- AgentManager
  |- ProviderRegistry
  |- TimelineStore
  |- SQLite
  |- RelayClient
  |
  |- Codex App Server
  |- Claude Agent SDK
  `- ACP Agent Process
```

Daemon 是以下资源的唯一所有者：

- Workspace 路径和文件系统访问。
- Provider 进程及其生命周期。
- Agent Session 内存实例。
- Turn 并发控制。
- Canonical Timeline 的排序与持久化。
- Relay 本地连接。

Relay 不理解 Agent 协议，不保存 Provider 状态，也不直接连接 Codex、Claude 或 ACP。Relay 只透明转发 Promptx 的 HTTP 请求和流式响应。

建议的代码结构：

```text
apps/
  daemon/
    src/
      agent/
        AgentManager.js
        ProviderRegistry.js
        providers/
          codex/
          claude/
          acp/
      workspace/
      timeline/
      api/
      relay/
      db/
  web/
  android/

packages/
  protocol/
    src/
      agent.js
      content.js
      timeline.js
      workspace.js
      api.js
  shared/
```

`packages/protocol` 使用 Zod 定义运行时 Schema，并同时导出 JSDoc 类型。Provider SDK 和协议原始类型不得进入 `packages/protocol`、API 响应或前端状态。

# 一、领域对象与数据库 Schema

## 3. 标识、时间与 JSON 规则

- Workspace、Agent Session 和 Turn 的公开 ID 使用 `crypto.randomUUID()`。
- Timeline Row 使用 Agent Session 内严格递增的整数 `seq` 作为公开顺序标识。
- 时间统一保存为 UTC ISO 8601 字符串。
- JSON 字段写入前必须通过对应 Zod Schema 校验。
- 数据库启用 `PRAGMA foreign_keys = ON` 和 WAL 模式。
- 删除 Workspace 时级联删除 Agent Session、Turn 和 Timeline。
- 归档 Agent Session 不删除 Timeline。

## 4. Workspace

Workspace 表示 Daemon 上的一个真实目录。一个规范化目录在同一 Daemon 中只能对应一个 Workspace。

路径规则固定为：

1. 创建前确认目录存在且是目录。
2. 使用 `fs.realpath()` 解析符号链接。
3. 去除多余尾部分隔符。
4. Windows 比较时不区分大小写，数据库额外保存 `path_key`。
5. Workspace 创建后允许修改标题，不允许直接修改路径。切换目录需要创建新 Workspace。
6. Workspace 首次创建时同步创建一个默认 Codex Agent；重复添加同一路径时复用已有 Workspace 和 Agent，不重复创建。

## 5. Agent Session

Agent Session 是 Workspace 内的一条持久 Agent 对话。一个 Workspace 可以拥有任意多个 Agent Session；同一 Agent Session 只能属于一个 Workspace 和一个 Provider。

Web 端不为 Agent Session 设置独立侧栏。Workspace 是左侧主导航，Workspace 内的 Agent Session 以顶部标签呈现；标签后的新增按钮创建 Agent，标签关闭操作删除 Agent 及其 Timeline。

Agent Session 的 `native_handle_json` 只保存恢复 Provider 会话所需的最小信息：

```json
{
  "protocol": "codex-app-server",
  "threadId": "019..."
}
```

```json
{
  "protocol": "claude-agent-sdk",
  "sessionId": "019..."
}
```

```json
{
  "protocol": "acp",
  "providerId": "kimi",
  "sessionId": "019..."
}
```

原始 SDK 对象、进程 ID、临时端口、AbortController 和认证信息不得进入 `native_handle_json`。

## 6. Turn

Turn 表示 Agent Session 中一次用户提交及其执行结果。

状态固定为：

```text
queued -> running -> completed
                  -> failed
                  -> canceled
```

约束：

- 同一个 Agent Session 同时最多存在一个 `queued` 或 `running` Turn。
- 不同 Agent Session 可以并行运行。
- `client_message_id` 由客户端生成，用于提交幂等。
- 同一 Agent Session 重复提交相同 `client_message_id` 时返回原 Turn，不创建第二条用户消息。
- Provider 的原生 Turn ID 保存到 `native_turn_id`，为空是合法状态。

## 7. 固定数据库 Schema

```sql
CREATE TABLE daemon_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  cwd TEXT NOT NULL,
  path_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

CREATE INDEX idx_workspaces_sort
  ON workspaces(sort_order ASC, last_opened_at DESC);

CREATE TABLE workspace_assets (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  storage_path TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_workspace_assets_workspace_created
  ON workspace_assets(workspace_id, created_at DESC);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  model_id TEXT NOT NULL DEFAULT '',
  mode_id TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  capabilities_json TEXT NOT NULL DEFAULT '{}',
  native_handle_json TEXT NOT NULL DEFAULT '{}',
  timeline_epoch TEXT NOT NULL,
  timeline_next_seq INTEGER NOT NULL DEFAULT 1,
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX idx_agent_sessions_workspace_activity
  ON agent_sessions(workspace_id, archived_at, last_active_at DESC);

CREATE TABLE agent_turns (
  id TEXT PRIMARY KEY,
  agent_session_id TEXT NOT NULL,
  client_message_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  error_message TEXT NOT NULL DEFAULT '',
  usage_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  UNIQUE(agent_session_id, client_message_id)
);

CREATE UNIQUE INDEX idx_agent_turns_one_active
  ON agent_turns(agent_session_id)
  WHERE status IN ('queued', 'running');

CREATE INDEX idx_agent_turns_session_created
  ON agent_turns(agent_session_id, created_at DESC);

CREATE TABLE agent_timeline_rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_session_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  turn_id TEXT,
  provider_message_id TEXT,
  item_type TEXT NOT NULL,
  item_json TEXT NOT NULL,
  FOREIGN KEY (agent_session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (turn_id) REFERENCES agent_turns(id) ON DELETE SET NULL,
  UNIQUE(agent_session_id, seq)
);

CREATE INDEX idx_agent_timeline_session_seq
  ON agent_timeline_rows(agent_session_id, seq);
```

Timeline Row 插入和 `timeline_next_seq` 递增必须位于同一个 SQLite 事务。

Agent Session 的持久生命周期值固定为：

```text
ready | running | failed | archived
```

以下值只存在于内存和 API 快照中：

```text
initializing | stopping | recovering | closing
```

Daemon 启动时，数据库中残留的 `running` Session 和 Turn 按以下规则恢复：

1. Session 进入内存态 `recovering`。
2. 未完成 Turn 标记为 `failed`，错误码为 `daemon_restarted`。
3. 使用 `native_handle_json` 恢复 Provider Session。
4. 恢复成功后 Session 变为 `ready`，失败则变为 `failed`。
5. 不自动重放未完成 Prompt，不静默创建新的原生会话。

# 二、Provider 与 AgentSession 接口

## 8. Provider Registry

Provider Registry 是 Provider 的唯一注册入口：

```js
export class ProviderRegistry {
  register(provider) {}
  get(providerId) {}
  list() {}
  async probeAll() {}
}
```

基础版本注册三个用户可见 Provider：

```text
codex  -> Codex App Server
claude -> Claude Agent SDK
kimi   -> 通用 ACP Client + Kimi Code 薄适配层
```

`acp` 是可复用的 Provider 基类和协议实现，不作为一个缺少启动命令的用户可见 Provider 注册。后续每个 ACP Agent 使用独立 `providerId`，例如 `kimi`、`gemini`、`qwen`。

## 9. AgentProvider 接口

```js
/**
 * @typedef {Object} AgentProvider
 * @property {string} id
 * @property {string} label
 * @property {(context?: ProviderProbeContext) => Promise<ProviderSnapshot>} probe
 * @property {(context?: ProviderProbeContext) => Promise<AgentModel[]>} listModels
 * @property {(config: AgentSessionConfig) => Promise<AgentSession>} createSession
 * @property {(handle: NativeSessionHandle, config: AgentSessionConfig) => Promise<AgentSession>} resumeSession
 */
```

固定行为：

- `probe()` 不创建持久会话，不修改用户配置。
- `createSession()` 必须返回已完成协议初始化的 Session。
- `resumeSession()` 失败时抛出结构化 ProviderError，不得自动创建新会话。
- Provider 负责校验自己的 config 和 native handle。
- Provider 不写数据库，不直接广播 SSE。
- Provider 只通过 AgentSession subscription 输出统一事件。

## 10. AgentSession 接口

```js
/**
 * @typedef {Object} AgentSession
 * @property {string} providerId
 * @property {string|null} nativeSessionId
 * @property {AgentCapabilities} capabilities
 * @property {(listener: (event: AgentStreamEvent) => void) => () => void} subscribe
 * @property {(input: AgentPromptInput, options: StartTurnOptions) => Promise<{nativeTurnId?: string}>} startTurn
 * @property {() => Promise<void>} interrupt
 * @property {(requestId: string, response: AgentPermissionResponse) => Promise<void>} respondToPermission
 * @property {() => Promise<NativeSessionHandle>} getPersistenceHandle
 * @property {() => Promise<void>} close
 */
```

固定行为：

- `startTurn()` 接受后立即返回；结果通过 subscription 发送。
- 一个 Session 不允许并发调用两次 `startTurn()`。
- `interrupt()` 幂等。无活跃 Turn 时调用也成功。
- `respondToPermission()` 只接受仍处于 pending 状态的原生请求 ID；重复或过期响应返回结构化错误。
- `close()` 幂等，并释放进程、流、定时器和 pending request。
- Session 必须在原生会话 ID 可用时发出 `thread_started`。
- Session 不使用子进程退出作为 Turn 完成条件。
- Provider 进程意外退出时发出 `runtime_error`，当前 Turn 随后发出 `turn_failed`。

## 11. AgentManager 接口

```js
export class AgentManager {
  async createAgent(input) {}
  async resumeAgent(agentId) {}
  async archiveAgent(agentId) {}
  async deleteAgent(agentId) {}
  async startTurn(agentId, input) {}
  async interruptTurn(agentId, turnId) {}
  async closeAgent(agentId) {}
  getAgentSnapshot(agentId) {}
  subscribe(listener, options) {}
}
```

AgentManager 固定负责：

- Agent Session 的内存所有权。
- Turn 并发和幂等控制。
- 把 Provider event 绑定到 Promptx `agentId` 和 `turnId`。
- Timeline coalescing、持久化和广播。
- Session handle、lifecycle、usage 和错误持久化。
- Daemon 启动恢复与关闭清理。
- 根据固定自动放行策略调用 `respondToPermission()`；基础版本不创建公共权限 API。

`closeAgent()` 只卸载内存中的 Provider Session，保留数据库记录、原生 handle 和 Timeline；下次发送消息时自动恢复。`archiveAgent()` 会先 close，再设置 `archived_at`，归档后禁止发送消息，直到调用 `resumeAgent()`。`deleteAgent()` 才会永久删除记录和 Timeline。

## 12. Provider 实现要求

### Codex

- 启动命令：`codex app-server`。
- Transport：stdin/stdout 上的 JSON-RPC。
- 会话：`thread/start`、`thread/resume`。
- Turn：`turn/start`、`turn/interrupt`。
- 默认权限：`approvalPolicy = never`、`sandbox = danger-full-access`。
- 正常数据来自 JSON-RPC notification，stderr 只作为诊断信息。

### Claude

- 使用 `@anthropic-ai/claude-agent-sdk`。
- 通过 SDK `query()` 创建和恢复会话。
- 使用 SDK 异步消息流产生统一事件。
- 默认权限：`permissionMode = bypassPermissions`，并设置 SDK 要求的危险权限确认选项。
- 正常数据不得通过解析 Claude stdout 获得。

### ACP

- Transport：stdin/stdout 上的 NDJSON JSON-RPC 2.0。
- 生命周期：`initialize`、`session/new`、`session/load`、`session/prompt`、`session/cancel`。
- 通过 `session/update` 产生统一事件。
- 权限请求自动选择 `allow_always`，其次 `allow_once`，再次选择第一个 allow 类型的原始 `optionId`；没有 allow 选项时返回 cancelled。
- Kimi Code 默认命令：`kimi acp`。
- 通用 ACP 实现不得包含 Kimi 专属事件判断；Kimi 专属模型或配置转换放在薄适配层。

# 三、Timeline 数据与事件协议

## 13. AgentPromptInput

```js
{
  content: [
    { type: 'text', text: '检查登录逻辑' },
    {
      type: 'image',
      assetId: 'asset-uuid',
      mimeType: 'image/png',
      name: 'error.png'
    }
  ]
}
```

基础版本内容块固定支持 `text` 和 `image`。不支持的块必须在进入 Provider 前返回 `unsupported_content_block`，不得静默丢弃。

## 14. AgentTimelineItem

```js
// 用户消息
{
  type: 'user_message',
  clientMessageId: 'uuid',
  content: [{ type: 'text', text: '检查登录逻辑' }]
}

// Agent 文本
{
  type: 'assistant_message',
  messageId: 'provider-message-id',
  text: '我先检查相关代码。'
}

// 推理
{
  type: 'reasoning',
  messageId: 'optional-provider-message-id',
  text: '需要确认认证中间件。'
}

// 工具调用
{
  type: 'tool_call',
  callId: 'provider-call-id',
  name: 'exec_command',
  status: 'running',
  detail: {
    type: 'shell',
    command: 'pnpm test',
    cwd: '/workspace/app',
    output: '',
    exitCode: null
  },
  error: null,
  metadata: {}
}

// Todo
{
  type: 'todo',
  items: [
    { text: '检查认证逻辑', status: 'in_progress' },
    { text: '增加测试', status: 'pending' }
  ]
}

// 错误
{
  type: 'error',
  code: 'provider_error',
  message: 'Provider request failed'
}

// 系统提示
{
  type: 'system_notice',
  code: 'provider_recovered',
  text: 'Agent 已恢复连接。'
}
```

工具状态固定为：

```text
pending | running | completed | failed | canceled
```

工具详情固定支持：

```text
shell | read | edit | search | fetch | unknown
```

`unknown` 必须保留经过大小限制和脱敏后的 input/output，确保新工具不会完全不可见。

## 15. AgentStreamEvent

Provider Adapter 只能向 AgentManager 输出以下事件：

```text
thread_started
turn_started
turn_completed
turn_failed
turn_canceled
timeline
usage_updated
permission_requested
permission_resolved
runtime_error
```

基础结构：

```js
{
  type: 'timeline',
  providerId: 'codex',
  nativeTurnId: 'optional-id',
  item: {
    type: 'assistant_message',
    text: '...'
  }
}
```

权限事件在基础版本中属于内部事件，由 AgentManager 自动处理，不写入用户 Timeline，不通过公共 SSE 暴露。

## 16. Canonical Timeline Row

数据库和同步协议使用 canonical row：

```js
{
  seq: 42,
  timestamp: '2026-09-02T08:00:00.000Z',
  turnId: 'turn-uuid',
  providerMessageId: 'optional-id',
  item: {
    type: 'assistant_message',
    messageId: 'message-id',
    text: '一段增量文本'
  }
}
```

规则：

- Canonical Row 按 `seq` 追加，不用最终展示结果覆盖历史。
- 同一个工具的多次状态更新使用相同 `callId` 写入多行。
- Assistant 和 reasoning 流使用同一 `messageId` 写入多行增量文本。
- 已提交用户消息只写入一次。
- 除补充 `provider_message_id` 外，不修改已提交的 canonical row。
- Provider 原始 frame 不进入 Timeline。

## 17. Coalescing

AgentManager 在持久化前使用 60ms 窗口合并高频事件：

- 相同 Agent、Turn、类型和 `messageId` 的连续文本增量拼接。
- 相同 `callId` 的工具更新在窗口内只保留最新快照。
- 工具进入 completed、failed 或 canceled 时立即 flush。
- Turn 结束前必须 flush 该 Agent 的全部 pending 事件。
- 非 Timeline 事件到达时，先 flush 该 Agent 已缓存的 Timeline，保持顺序。

## 18. Projection

Canonical Timeline 是事实来源，Projected Timeline 是 UI 结果。Projection 是 `packages/protocol` 中的纯函数，可在 Daemon 和 Web 复用。

Projection 固定执行：

1. `tool_lifecycle`：按同一 Turn 内的 `callId` 合并工具状态，保留最终状态和详情。
2. `assistant_merge`：合并同一 Turn、相同 `messageId` 的相邻 assistant chunks。
3. `reasoning_merge`：合并同一 Turn 的相邻 reasoning chunks。

Projected Entry 必须保留来源范围：

```js
{
  item: {},
  turnId: 'turn-uuid',
  timestamp: '...',
  seqStart: 40,
  seqEnd: 46,
  sourceSeqRanges: [{ startSeq: 40, endSeq: 46 }],
  collapsed: ['assistant_merge']
}
```

前端始终缓存 canonical rows，再计算 projected entries。不能只缓存 projected entries。

## 19. Cursor 与窗口

Timeline Cursor 固定为：

```js
{
  epoch: 'uuid',
  seq: 42
}
```

查询方向：

```text
tail   获取最新窗口
before 获取 cursor 之前的历史
after  获取 cursor 之后的增量
```

查询结果：

```js
{
  epoch: 'uuid',
  direction: 'after',
  reset: false,
  staleCursor: false,
  gap: false,
  window: {
    minSeq: 1,
    maxSeq: 120,
    nextSeq: 121
  },
  hasOlder: true,
  hasNewer: false,
  rows: []
}
```

规则：

- Cursor epoch 不同：`reset = true`、`staleCursor = true`，返回 tail 窗口。
- `after` cursor 早于当前 `minSeq - 1`：`reset = true`、`gap = true`。
- 正常 Daemon 重启不更换 epoch。
- 清空、整体替换、修复或重新导入 Timeline 时更换 epoch。
- 默认 `limit = 200`，最大 `limit = 1000`，`limit = 0` 不对公共 API 开放。
- Web 首次打开 Agent 时读取 tail 窗口；到达已加载历史顶部时使用首行 cursor 请求 before 窗口。
- before 窗口必须 prepend 到 canonical rows，并在重新 projection 后保持当前可见位置，不能让跨页的 assistant block 截断、重复或导致滚动跳跃。
- 首次打开或刷新 Agent 时，Web 必须定位到已加载 Timeline 的底部。
- 实时 row 到达前若视口位于底部，Web 继续跟随底部；若用户已离开底部，则保持当前位置并显示“有新消息”入口，直到用户主动回到底部。

# 四、Daemon、Web 与 Relay API

## 20. API 约定

- 公共 API 前缀固定为 `/api/v2`。
- 命令使用 REST，实时更新使用 SSE。
- JSON 字段使用 camelCase。
- 创建异步资源成功返回 `202 Accepted`。
- 所有写请求接受可选 `Idempotency-Key`；Turn 创建强制要求 `clientMessageId`。
- API Schema 由 `packages/protocol` 定义，Fastify 和 Web 共用。

错误格式固定为：

```js
{
  error: {
    code: 'agent_busy',
    message: '当前 Agent 正在执行。',
    details: {}
  }
}
```

## 21. Workspace API

```text
GET    /api/v2/workspaces
POST   /api/v2/workspaces
GET    /api/v2/workspaces/:workspaceId
PATCH  /api/v2/workspaces/:workspaceId
DELETE /api/v2/workspaces/:workspaceId
```

创建请求：

```js
{
  cwd: '/Users/me/code/app',
  title: 'app'
}
```

创建响应同时返回 `workspace` 和首次创建或已存在的默认 `agent`。默认 Provider 固定为 `codex`，保证客户端打开新 Workspace 时可以直接提交 Turn。

文件能力：

```text
GET /api/v2/workspaces/:workspaceId/files?path=&depth=2
GET /api/v2/workspaces/:workspaceId/file?path=src/index.js
GET /api/v2/workspaces/:workspaceId/git/status
GET /api/v2/workspaces/:workspaceId/git/diff?path=src/index.js
```

所有相对路径经过规范化后必须仍位于 Workspace 根目录内。

附件能力：

```text
POST   /api/v2/workspaces/:workspaceId/assets
GET    /api/v2/assets/:assetId
DELETE /api/v2/assets/:assetId
```

上传使用 `multipart/form-data`。文件保存在 Daemon 管理的数据目录，不写入 Workspace；Provider 需要本地文件时由 AgentManager 解析为受控绝对路径。基础版本允许 `image/png`、`image/jpeg`、`image/webp` 和 `image/gif`，默认单文件上限 20 MiB。删除仍被 Timeline 引用的 Asset 返回 `409 asset_in_use`。

## 22. Provider API

```text
GET  /api/v2/providers
POST /api/v2/providers/:providerId/probe
GET  /api/v2/providers/:providerId/models
```

Provider snapshot 至少包含：

```js
{
  id: 'codex',
  label: 'Codex',
  available: true,
  version: '...',
  capabilities: {},
  error: null
}
```

## 23. Agent Session API

```text
GET    /api/v2/workspaces/:workspaceId/agents
POST   /api/v2/workspaces/:workspaceId/agents
GET    /api/v2/agents/:agentId
PATCH  /api/v2/agents/:agentId
DELETE /api/v2/agents/:agentId
POST   /api/v2/agents/:agentId/archive
POST   /api/v2/agents/:agentId/resume
POST   /api/v2/agents/:agentId/close
```

创建请求：

```js
{
  providerId: 'codex',
  title: '修复登录问题',
  modelId: '',
  modeId: '',
  providerConfig: {}
}
```

`resume` 表示恢复归档 Agent；Provider 原生会话恢复由 AgentManager 在需要时自动执行，不向前端暴露第二套概念。

## 24. Turn API

```text
GET  /api/v2/agents/:agentId/turns
POST /api/v2/agents/:agentId/turns
GET  /api/v2/turns/:turnId
POST /api/v2/turns/:turnId/interrupt
```

创建请求：

```js
{
  clientMessageId: 'uuid',
  input: {
    content: [
      { type: 'text', text: '检查登录逻辑' }
    ]
  }
}
```

成功响应：

```js
{
  accepted: true,
  turn: {
    id: 'turn-uuid',
    agentSessionId: 'agent-uuid',
    status: 'queued'
  }
}
```

## 25. Timeline API

```text
GET /api/v2/agents/:agentId/timeline
```

参数：

```text
direction=tail|before|after
epoch=<uuid>
seq=<integer>
limit=<1..1000>
mode=canonical|projected
```

`mode` 默认是 `canonical`。Web 使用 canonical 模式；`projected` 用于诊断、导出和轻量客户端。

## 26. Agent SSE

```text
GET /api/v2/agents/:agentId/events?epoch=<uuid>&afterSeq=<seq>
```

首次连接可使用查询参数传入 cursor；浏览器自动重连时，Daemon 也必须接受标准 `Last-Event-ID: <epoch>:<seq>`，Header 优先于查询参数。

连接建立过程固定为：

1. Daemon 先注册实时订阅。
2. 读取指定 cursor 之后的 committed rows。
3. 发送补齐 rows。
4. 发送订阅期间产生且尚未发送的 rows。
5. 进入实时模式并按 seq 去重。

Timeline SSE：

```text
event: timeline.row
id: <epoch>:<seq>
data: { "agentId": "...", "epoch": "...", "row": {} }
```

状态 SSE：

```text
event: agent.updated
data: { "agent": {} }

event: turn.updated
data: { "turn": {} }

event: timeline.reset
data: { "agentId": "...", "epoch": "...", "reason": "..." }
```

心跳：

```text
: heartbeat 2026-09-02T08:00:00.000Z
```

心跳间隔固定为 15 秒。SSE 断开不影响 Provider Session 和正在运行的 Turn。

Web 重连规则：

1. 保存当前 `epoch + maxSeq`。
2. 使用该 cursor 重连 SSE。
3. 发现 seq 重复则忽略。
4. 发现 seq 跳跃则调用 Timeline `after` 查询补齐。
5. 收到 `timeline.reset` 或 stale cursor 时清空本地 canonical rows，重新获取 tail。

## 27. Daemon 全局 SSE

```text
GET /api/v2/events
```

只用于低频资源状态：

```text
workspace.created
workspace.updated
workspace.deleted
agent.created
agent.updated
agent.deleted
provider.updated
relay.updated
```

全局 SSE 不承担 Timeline 历史恢复。断线重连后，Web 重新请求 Workspace 和 Agent 列表作为事实来源。

## 28. Relay API 与边界

保留现有 Relay 配置能力，v2 路径固定为：

```text
GET  /api/v2/relay/config
PUT  /api/v2/relay/config
POST /api/v2/relay/reconnect
GET  /api/v2/relay/status
```

Relay 固定职责：

- 设备认证。
- HTTP 请求和响应分块转发。
- SSE 响应持续转发。
- 请求取消传播。
- 心跳、休眠恢复和自动重连。
- 添加可信的 Relay 来源标记。

Relay 禁止：

- 解析或修改 Promptx JSON payload。
- 保存 Timeline cursor。
- 直接响应 Provider 权限。
- 访问 Workspace 文件系统。
- 持有 Provider 认证信息。

通过 Relay 访问与本地访问使用完全相同的 `/api/v2`。业务代码只能通过可信服务器注入的 Relay 标记判断来源，不能信任浏览器自行提交的同名 Header。

## 29. 主题系统边界

主题保持客户端能力：

- 主题定义继续集中管理。
- 主题选择保存在浏览器本地存储。
- Workspace、Agent Session 和 Timeline 不保存主题 ID。
- 新 UI 只能使用主题 token 和语义类，不写入大面积固定颜色或 `dark:` 分支。
- Relay 不同步和存储主题偏好。

## 30. 固定实现顺序

1. 创建 `packages/protocol`，实现本文件中的 Schema 和纯函数。
2. 创建 v2 SQLite Schema、Repository 和 TimelineStore。
3. 实现 AgentManager、ProviderRegistry 和内存生命周期。
4. 实现 Codex App Server Provider。
5. 实现 Claude Agent SDK Provider。
6. 实现通用 ACP Provider 和 Kimi 适配。
7. 实现 `/api/v2` REST、Agent SSE 和全局 SSE。
8. 重写 Workspace Web 界面并接入 canonical Timeline projection。
9. 接回主题系统。
10. 接回 Relay 并完成断线补齐测试。

以上结构、字段、接口和行为是 Promptx v2 基础版本的实现基线。后续新增能力通过扩展 Provider capability、Timeline item 或独立 API 完成，不重新引入 v1 的任务或项目抽象。
