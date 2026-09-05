# PromptX

[English README](README.en.md)

PromptX 是一个本地优先的 AI 编程工作台。它把工作目录、Agent 会话、执行过程、最终回复、文件浏览和 Git Diff 放在同一个界面中，并通过 Relay 支持手机远程访问。

当前 V2 的核心模型是：

```text
工作区 -> Agent 会话 -> Turn -> Timeline
```

每个工作区对应一个真实目录；同一目录中可以建立多条 Codex、Claude 或 Kimi 会话。PromptX 负责恢复 Provider 原生会话，并把不同 Provider 的历史统一对账到本地 Timeline。

## 核心能力

- 支持 Codex、Claude Code 和 Kimi Code。
- 从本机扫描并导入三种 Provider 的已有会话。
- 实时展示用户消息、思考过程、工具调用和最终回复。
- 按会话保留内存草稿，切换会话后可立即恢复；刷新页面后不保留。
- 浏览工作区文件并查看 staged、unstaged 和 untracked Diff。
- 桌面与 H5 共用同一套界面；移动端页面和全屏弹层支持浏览器返回手势。
- 手机和 Daemon 之间使用端到端加密，公网 Relay 只转发密文。

## 快速开始

运行要求：

- 推荐 Node 22 LTS；兼容 Node 20.19+、22.13+ 和 24.x。
- 本机至少安装一个受支持的 Provider CLI：`codex`、`claude` 或 `kimi`。

安装并启动：

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
promptx start
```

默认地址为 `http://127.0.0.1:3001`。

```bash
promptx status
promptx restart
promptx stop
```

运行数据默认保存在 `~/.promptx/`。PromptX 当前面向本机单用户场景，不包含账号和团队权限系统。

## 源码开发

```bash
pnpm install
pnpm dev
```

开发环境默认使用：

- Web：`http://127.0.0.1:5174`
- Daemon：`http://127.0.0.1:3001`

常用检查：

```bash
pnpm test
pnpm build
pnpm test:e2e
pnpm release:check
```

工作区结构：

- `apps/web`：Vue 3 + Vite 前端。
- `apps/daemon`：Fastify 本地 Daemon，负责 Provider、Timeline、SQLite 和文件访问。
- `apps/android`：远程 H5 的 Android WebView 壳。
- `packages/protocol`：前后端共享协议与 Timeline 投影。
- `packages/relay`：E2EE、配对协议和公网 Relay Server。
- `packages/shared`：跨模块共享工具。

V2 不读取或迁移 V1 数据，也不保留旧 Server/Runner 双进程架构。详细设计见 [V2 架构基线](docs/v2-architecture-baseline.md)。

## 远程访问

启动 PromptX 后进入“设置 -> 远程访问”，扫描二维码即可在手机打开。完整配对链接等同远程访问凭证，请勿公开分享。

Relay 的协议、部署和运维说明见：

- [Relay 快速上手](docs/relay-quickstart.md)
- [E2EE Relay 架构](docs/relay-e2ee-architecture.md)

项目内置阿里云发布脚本：

```bash
pnpm deploy:relay:aliyun
```

## 开源协议

本项目采用 Apache-2.0 协议，详见 [LICENSE](LICENSE)。
