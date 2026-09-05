# 任务级 Worktree 架构设计

## 1. 目标

PromptX 采用 Codex App 风格的任务级隔离模型：每条对话都是一个独立开发任务，每个任务拥有自己的执行环境；Worktree 是执行环境的一种实现。

这次升级允许直接重建数据模型，不保留旧 workspace 数据迁移兼容。界面保留当前工作台习惯：左栏继续展示工作区和对话，Timeline 继续作为任务主界面，Worktree、分支和 Git 状态集中在右侧任务详情抽屉中。

## 2. 产品模型

用户界面继续使用现有术语：

```text
工作区
  └── 对话 / 任务
        └── 当前执行目录
```

内部模型改为：

```text
Project
  ├── Task
  │     └── ExecutionEnvironment
  ├── Task
  │     └── ExecutionEnvironment
  └── Task
        └── ExecutionEnvironment
```

概念对应关系：

| 产品概念 | 内部对象 | 含义 |
| --- | --- | --- |
| 工作区 | Project | 一个真实代码仓库 |
| 对话 / 任务 | Task | 一次独立开发任务和一条 Timeline |
| 执行环境 | ExecutionEnvironment | Agent 实际运行的目录 |
| Worktree | 执行环境的一种类型 | Git 隔离目录和分支 |

核心约束：

- 一个工作区可以有多个对话。
- 一个对话只能有一个执行环境。
- 一个 Worktree 只属于一个对话。
- Timeline、Turn 和任务附件归属于 Task，而不是 Project。
- Agent、文件浏览和 Git 操作都以当前 Task 的执行环境为边界。

## 3. 界面设计

### 3.1 左栏保持现状

左栏不增加 Worktree 层级，不改成“项目 -> Worktree -> 任务”。保留当前布局：

```text
PromptX V2
────────────
[+ 新对话]
[▣ 导入会话]

工作区
  ▾ promptx
      ● 修复登录
      ● 更新文档
  ▾ demo
      ● 重构 API

────────────
[⚙ 设置]
```

必须保留：

- 左栏顶部的“新对话”。
- 左栏顶部的“导入会话”。
- 左栏左下角的全局“设置”。
- 工作区和对话的现有展开结构。
- 对话行的删除操作。

Worktree 信息只允许以轻量辅助信息出现在对话行，例如分支名；完整路径、基线和 Git 状态不放进左栏。

### 3.2 Timeline 顶部操作

当前右上角已有同步状态、运行状态、文件抽屉和 Diff 抽屉。新增一个任务详情按钮：

```text
[同步状态] [运行状态] [文件] [Diff] [任务详情]
```

任务详情使用信息类图标，例如 Lucide `Info`，不使用齿轮。全局设置仍然只从左栏左下角进入。

### 3.3 任务详情抽屉

文件、Diff 和任务详情共用同一个右侧抽屉区域，同一时间只打开一个：

```js
drawerMode = 'files' | 'diff' | 'task-details' | null
```

打开任务详情时，左栏保持完整，Timeline 仍然可见，只是被抽屉压缩；不叠加多个抽屉。点击“查看 Diff”时切换到现有 Diff 抽屉。

任务详情抽屉包含：

```text
任务详情

实现 Worktree 支持
● 运行中 · Codex

任务
标题、Provider、创建时间、最近活动

执行环境
Worktree

分支
codex/implement-worktree

基线
origin/main

工作目录
~/.promptx/worktrees/xxxx/implement-worktree

Git 状态
3 个未提交文件
领先基线 2 个提交
落后基线 0 个提交

操作
[查看 Diff] [打开目录] [复制路径] [复制分支名]

生命周期
[归档任务]
[删除任务并删除 Worktree]
```

普通目录任务只显示当前目录和工作路径，不显示 Worktree 删除操作。

## 4. 创建任务和 Worktree

左栏“新对话”按钮保持不变，创建弹窗增加执行位置：

```text
Provider
任务标题

执行位置：
  当前目录
  新建 Worktree
  使用已有目录
```

选择“新建 Worktree”时填写：

- 基线，例如 `origin/main`。
- 分支名，例如 `codex/fix-login`。
- Worktree 名称，例如 `fix-login`。

推荐默认值：

```text
执行位置：新建 Worktree
基线：远端默认分支
分支：codex/<slug>
```

创建任务必须在后端完成完整流程后才返回成功：

```text
校验项目是 Git 仓库
  -> 解析 repository root
  -> 校验 baseRef
  -> 校验分支和 slug
  -> 创建 Worktree
  -> 创建 Task
  -> 创建 Agent
  -> 返回成功
```

任何一步失败都要回滚 Worktree、Task 和 Environment，不留下半成品。

Worktree 创建命令通过参数数组调用 Git，不拼接 shell 字符串：

```bash
git -C <repositoryRoot> worktree add -b <branchName> <worktreePath> <baseRef>
```

已有分支使用：

```bash
git -C <repositoryRoot> worktree add <worktreePath> <branchName>
```

## 5. Worktree 目录和元数据

默认目录布局：

```text
~/.promptx/worktrees/
└── <repository-hash>/
    ├── fix-login/
    ├── update-docs/
    └── refactor-api/
```

可通过以下环境变量覆盖：

```text
PROMPTX_WORKTREES_DIR
默认 ~/.promptx/worktrees
```

slug 规则：

- 只允许 ASCII 字母、数字、`-`、`_`。
- 最长 64 个字符。
- 禁止 `.`、`..` 和路径分隔符。
- 冲突时自动追加短 ID。
- 分支名和目录名分开校验，不直接互相替换。

每个执行环境记录：

```text
repositoryRoot
worktreePath
branchName
baseRef
slug
ownership
status
```

`ownership`：

- `promptx`：PromptX 创建，可以由 PromptX 删除。
- `external`：外部已有目录，只能解绑，不能自动删除。

## 6. 数据模型

直接重建数据库，不迁移旧 workspace 数据：

```sql
projects (
  id TEXT PRIMARY KEY,
  repository_root TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  default_branch TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_opened_at TEXT NOT NULL
);

tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  title TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  environment_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT NOT NULL,
  archived_at TEXT,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

execution_environments (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  cwd TEXT NOT NULL UNIQUE,
  repository_root TEXT NOT NULL,
  branch_name TEXT NOT NULL DEFAULT '',
  base_ref TEXT NOT NULL DEFAULT '',
  worktree_path TEXT,
  ownership TEXT NOT NULL DEFAULT 'external',
  status TEXT NOT NULL DEFAULT 'ready',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
```

约束：

- `tasks.environment_id` 唯一，保证一个任务一个执行环境。
- `execution_environments.cwd` 唯一，防止两个任务共享目录。
- PromptX 创建的 `worktree_path` 唯一。
- `kind` 取 `local` 或 `worktree`。

其他表改为使用 `task_id`：

- `task_import_sources`
- `task_attachments`
- `agent_turns`
- `agent_timeline_rows`
- `agent_timeline_sync_state`

## 7. Agent 和文件边界

当前通过 `workspaceId` 取得 cwd 的逻辑全部改为：

```text
task -> environment -> cwd
```

以下功能统一使用 Task 的 Environment cwd：

- Provider 启动 cwd。
- 文件浏览、读取和文件流。
- Git status 和 Git diff。
- Timeline 中的文件链接。
- 附件路径检查。
- 终端或命令执行。

项目根目录只用于创建 Worktree、解析默认分支和项目级配置。Agent 默认不能直接修改项目源目录，除非任务明确选择“当前目录”。

文件安全规则继续保留：

- 访问路径必须位于 environment cwd 内。
- 使用 realpath 校验。
- 禁止符号链接逃出执行目录。
- 禁止通过 `..` 访问外部路径。

## 8. 删除、归档和清理

删除对话、归档任务和删除 Worktree 是三个独立动作。

### 删除对话

默认行为：

```text
停止 Agent
归档或删除 Task
保留 Worktree
Environment 标记为 orphaned
```

确认文案：

```text
删除此任务？
任务记录会被移除，Worktree 默认保留。
```

删除对话不会静默删除代码。

### 归档任务

归档表示任务生命周期结束，不代表删除目录：

```text
task.lifecycle = archived
environment.status = orphaned
Worktree 保留
```

### 删除 Worktree

只有用户明确选择“删除任务并删除 Worktree”时执行。执行前检查：

- 没有运行中的 Turn。
- 没有未提交修改，或用户明确强制确认。
- 没有未推送提交，或用户明确确认。
- `ownership` 为 `promptx`。
- 没有其他记录引用该目录。

外部 Worktree 只解除 PromptX 关联，不删除磁盘目录。

## 9. Git 交付流程

任务完成后不自动合并，也不自动删除 Worktree。

推荐流程：

```text
Agent 修改代码
  -> 查看 Diff
  -> 提交到任务分支
  -> 推送分支
  -> 创建 Pull Request 或本地合并
  -> 归档任务
  -> 按需删除 Worktree
```

第一阶段只提供：

- 当前未提交 Diff。
- 相对 `baseRef` 的完整 Diff。
- 提交列表。
- 复制分支名。
- 打开目录。

后续再增加提交、推送、Pull Request、合并和合并后自动归档。

## 10. 导入会话

导入会话导入成 Task，不再导入成旧 Workspace。

```text
导入 = 恢复历史任务
复制 = 从历史任务创建新的独立任务
```

导入流程：

1. 扫描 Provider 历史会话。
2. 提取标题、Provider、原始 cwd、Session ID、消息和 Timeline。
3. 根据 cwd 匹配 Project。
4. 恢复或关联原始 ExecutionEnvironment。
5. 创建 Task 和 Timeline。

项目匹配规则：

```text
cwd 与已有项目根目录完全匹配
  -> 关联该项目

cwd 位于已有 Git 项目内
  -> 关联该项目，保留原 cwd

cwd 是 Git Worktree
  -> 解析 repository root 和分支

无法识别
  -> 创建新的项目记录
```

导入默认不创建新的 Worktree。

如果历史目录存在，使用原目录并标记 `ownership = external`。如果历史目录不存在，仍然导入对话，Environment 标记为 `unavailable`；用户可以查看历史，但暂时不能继续执行 Agent。

详情抽屉提供：

```text
[重新绑定目录]
[复制到新 Worktree]
[仅查看历史]
```

“复制到新 Worktree”创建一个新 Task，继承标题、摘要和必要上下文；原任务保留完整历史。不要直接复用原任务 Timeline，避免两条任务的执行记录混在一起。

`task_import_sources` 使用 `(provider_id, source_session_id)` 唯一约束，保证同一个 Provider 会话不会重复导入。

## 11. 状态和恢复

Environment 状态：

```text
creating
ready
running
dirty
clean
orphaned
missing
archiving
archived
```

Daemon 启动时执行 reconcile：

```text
读取数据库记录
  -> 检查 cwd 是否存在
  -> git worktree list --porcelain
  -> 检查分支
  -> 更新 missing / orphaned / ready
```

Worktree 被用户从终端删除时，任务历史保留，详情显示“Worktree 不可用”，并提供重新绑定或复制到新 Worktree。

发现磁盘上存在未登记的 PromptX Worktree 时，不自动删除，显示为未关联 Worktree，提供重新关联或删除。

## 12. API 方向

项目：

```http
GET    /api/v2/projects
POST   /api/v2/projects
GET    /api/v2/projects/:projectId
PATCH  /api/v2/projects/:projectId
DELETE /api/v2/projects/:projectId
```

任务：

```http
GET    /api/v2/projects/:projectId/tasks
POST   /api/v2/projects/:projectId/tasks
GET    /api/v2/tasks/:taskId
PATCH  /api/v2/tasks/:taskId
POST   /api/v2/tasks/:taskId/archive
DELETE /api/v2/tasks/:taskId
```

执行环境：

```http
GET    /api/v2/tasks/:taskId/environment
GET    /api/v2/tasks/:taskId/files
GET    /api/v2/tasks/:taskId/file
GET    /api/v2/tasks/:taskId/git/status
GET    /api/v2/tasks/:taskId/git/diff
GET    /api/v2/tasks/:taskId/git/commits
POST   /api/v2/tasks/:taskId/environment/archive
POST   /api/v2/tasks/:taskId/environment/reconcile
```

不再继续扩展以 `workspaceId` 为中心的新 API，直接切换到 Project、Task 和 Environment。

## 13. 代码模块调整

建议新增：

```text
apps/daemon/src/projects/
  projectRepository.js
  projectInspection.js

apps/daemon/src/tasks/
  taskRepository.js
  taskService.js
  taskLifecycle.js

apps/daemon/src/environments/
  environmentRepository.js
  environmentService.js
  worktreeService.js
  environmentInspection.js
  environmentReconcile.js
```

`worktreeService` 只负责 Git Worktree add/remove/list；`environmentService` 负责 local/worktree 两种执行环境；`taskService` 负责任务创建、归档和删除；`agentManager` 只接受 `taskId`，由服务层解析到 Environment cwd。

协议包重建为：

```text
packages/protocol/src/project.js
packages/protocol/src/task.js
packages/protocol/src/executionEnvironment.js
```

## 14. 实施阶段

### 第一阶段：模型重建

- 删除旧数据库。
- 建立 Project、Task、ExecutionEnvironment。
- 重写协议 Schema 和 Repository。
- 让普通目录任务完整工作。
- 让 AgentManager 接收 `taskId`。

### 第二阶段：Worktree 核心

- 实现 `git worktree add/remove/list`。
- 实现分支、基线和 slug 校验。
- 实现创建失败回滚。
- 让 Agent、文件和 Git 全部使用 Environment cwd。
- 完成 Worktree 状态检测。

### 第三阶段：界面接入

- 保持现有左栏。
- 新对话弹窗增加执行位置。
- 右上角增加任务详情按钮。
- 新增任务详情抽屉。
- 文件、Diff、详情统一抽屉状态。
- 显示分支、目录和 Git 状态。

### 第四阶段：生命周期

- 任务归档。
- Worktree 保留和删除。
- 未提交修改保护。
- `missing` / `orphaned` 状态。
- Daemon 启动 reconcile。
- 删除任务不再误删代码。

### 第五阶段：导入会话

- Provider 统一导入模型。
- 自动匹配 Project。
- 恢复历史 cwd。
- 支持缺失目录任务。
- 支持重新绑定和复制到新 Worktree。
- 保证导入幂等。

### 第六阶段：Git 交付能力

- 提交。
- 推送。
- Pull Request。
- 合并。
- 合并后归档。
- 可选 setup/teardown 和服务脚本。

## 15. 验收标准

- 左栏仍有“新对话”和“导入会话”。
- 左栏左下角仍是全局“设置”。
- 每个任务可以拥有独立 Worktree。
- 两个任务可以同时修改同一个项目而互不干扰。
- Timeline、文件浏览和 Diff 都针对当前任务环境。
- 右上角有文件、Diff、任务详情三个入口。
- 任务详情使用右侧抽屉。
- 删除任务不会静默删除代码。
- 删除 Worktree 前检查脏文件和未推送提交。
- 导入会话能恢复历史目录。
- 历史目录不存在时仍能查看对话。
- 可以把历史任务复制到新的 Worktree。
- 重启 Daemon 后任务和 Worktree 状态可恢复。
- Worktree 被外部删除时显示明确的缺失状态。
- Worktree 创建失败没有残留目录和数据库记录。
- `pnpm build` 通过，并完成新建任务、导入会话、Timeline、文件、Diff、归档和删除流程的冒烟验证。

## 16. 最终定义

```text
工作区 = 一个项目仓库
对话 = 一个开发任务
任务详情 = 当前任务的执行环境和 Git 状态
Worktree = 任务的独立执行目录
导入 = 恢复历史任务
复制 = 创建新的隔离任务
归档 = 结束任务，不默认删除代码
```

