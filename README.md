# PromptX

[English README](README.en.md)

PromptX 是一个面向本机 AI Agent 的协作工作台。

它把 `Codex`、`Claude Code`、`OpenCode` 这些你已经熟悉的 CLI，整理成一套更适合持续协作的界面：

```text
任务 -> 项目 -> 目录 -> 线程 -> Run -> Diff
```

你继续使用熟悉的 agent 与模型，PromptX 负责把输入整理、项目绑定、执行过程、最终回复、代码变更、源码查看放进同一个工作台里。

并且，PromptX 与这些 agent CLI 可以双向复用会话：

- 你可以先在 `Codex`、`Claude Code`、`OpenCode` 里创建会话，再回到 PromptX 继续
- 也可以在 PromptX 里创建和推进项目，再回到 agent CLI 里恢复同一个会话

## 为什么现在值得用

- 一个项目可以挂多个 Agent，右侧直接切换发送目标
- 同页查看 `PromptX` 输入卡片、执行过程、最终回复、历史 run
- 直接查看当前项目源码，并支持按路径或内容搜索
- 直接审查 workspace / 任务累计 / 单轮 run 的代码变更
- 可以把 `Prompt`、回复、源码、Diff 中的内容再次插回编辑区，继续下一轮
- 内置多主题，当前 README 截图统一使用 `WeChat` 主题
- 可配合 Relay 从手机或外网访问自己的 PromptX

## 快速开始

### 运行前提

- 推荐 `Node 22 LTS`
- 当前兼容 `Node 20 / 22 / 24` 稳定版本
- 本机至少安装一个可用执行引擎：
  - `codex --version`
  - `claude --version`
  - `opencode --version`

### 安装

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
```

### 启动

默认地址：`http://127.0.0.1:3000`

```bash
promptx start
promptx status
promptx stop
```

### 基本使用流程

1. 新建任务，先整理本轮要发给 agent 的需求、日志、图片、文件
2. 给任务绑定一个项目
3. 给项目选择工作目录、默认执行引擎，以及可协作的其他 Agents
4. 在右侧选择这轮要发给哪个 Agent
5. 发送后，在同一页查看执行过程、最终回复、源码、代码变更
6. 把有价值的片段重新插回编辑区，继续下一轮

## 核心能力

- 输入整理：支持文本、图片、`md`、`txt`、`pdf`
- 项目复用：一个项目绑定固定目录与默认执行引擎，持续复用线程上下文
- 多 Agent 协作：一个项目可同时挂 `Codex`、`Claude Code`、`OpenCode`
- 过程可见：同页查看执行过程、最终回复、历史 run
- 源码查看：只读浏览当前项目源码，支持路径搜索与内容搜索
- 代码审查：直接查看 workspace / 任务累计 / 单次 run 的 diff
- 上下文回插：支持从 Prompt、回复、源码、Diff 中选取内容插回编辑区
- 会话互通：PromptX 与 `Codex`、`Claude Code`、`OpenCode` 可双向复用会话
- 远程访问：支持通过 Relay 从手机或外网访问自己的 PromptX

## 系统截图

以下截图基于 `WeChat` 主题。

### 1. 工作台总览

可以同时看到任务列表、Agent 过滤、输入卡片、执行过程和最终回复。

![PromptX 工作台总览](docs/assets/readme-workbench-wechat.png)

### 2. 执行过程与回复

同一轮里直接看 Prompt、过程日志、最终回复，不用在终端和 diff 工具之间来回切。

![PromptX 执行过程与回复](docs/assets/readme-execution-focus-wechat.png)

### 3. 多 Agent 项目管理

一个项目可以挂多个 Agent，目录保持一致，首次发送时自动建立各自线程。

![PromptX 多 Agent 项目管理](docs/assets/readme-project-manager-wechat.png)

### 4. 只读源码查看

左侧目录树与搜索结果，右侧文件预览；适合快速浏览、搜索、选中代码并插回编辑区。

![PromptX 源码查看](docs/assets/readme-source-browser-wechat.png)

### 5. 代码变更审查

直接看当前项目、任务累计或单轮 run 的代码变更，适合回顾 agent 到底改了什么。

![PromptX 代码变更审查](docs/assets/readme-diff-wechat.png)

### 6. 设置与系统

主题、快捷键、远程访问、系统配置集中在同一个设置面板里。

![PromptX 主题设置](docs/assets/readme-settings-theme-wechat.png)

![PromptX 系统设置](docs/assets/readme-settings-system-wechat.png)

### 7. 手机端

通过 Relay 或局域网访问时，可以在手机端继续查看任务、阅读回复、推进协作。

![PromptX 手机端](docs/assets/readme-mobile-wechat.png)

## 适合什么场景

- 先整理需求、截图、日志、文件，再交给 agent 执行
- 一个项目要持续多轮协作，希望稳定复用目录和线程
- 一个任务里需要多个 Agent 配合，但又不想来回切命令行
- 需要同时看执行过程、最终回复、源码与代码改动
- 离开电脑后，也想从手机继续推进本机 PromptX

## 源码开发

```bash
pnpm install
pnpm dev
pnpm build
```

工作区结构：

- `apps/web`：Vue 3 + Vite 前端工作台
- `apps/server`：Fastify 服务端
- `apps/runner`：独立 runner 进程
- `packages/shared`：前后端共享常量与事件协议

## 远程访问

如需使用 Relay，请直接看：

- `docs/relay-quickstart.md`

文档中包含公共 E2EE Relay 的本地配对、云端部署、Nginx 配置和运维命令。

## 禅道扩展

仓库内置了禅道 Chrome 扩展：`apps/zentao-extension`

注意：

- `npm install -g @muyichengshayu/promptx` 安装的正式包不包含该扩展目录
- 如需使用禅道扩展，请克隆源码后手动加载

使用步骤：

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”
4. 选择 `apps/zentao-extension`

## 注意事项

- 当前以本机单用户使用为主，不包含账号体系和团队权限
- 不同执行引擎的工具能力、输出事件丰富度和稳定性会有差异
- 如需跨设备访问，建议使用 Relay
- 运行数据默认保存在 `~/.promptx/`

## 开源协议

本项目采用 `Apache-2.0` 开源协议，详见 `LICENSE`。
