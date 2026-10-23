# PromptX

[English README](README.en.md)

本地优先的 AI 编程工作台，支持 Codex、Claude Code、Kimi Code、Grok 和 Pi。统一管理工作区与会话，查看执行过程、文件和 Git Diff，并支持手机远程访问。

## 安装使用

需要 Node.js 20.19+（20.x）、22.13+（22.x）或 24.x，以及至少一个已安装并配置好的 Agent CLI。

```bash
npm install -g @muyichengshayu/promptx
promptx doctor
promptx start
```

浏览器打开 [http://127.0.0.1:4001](http://127.0.0.1:4001)，选择工作区即可新建或导入会话。

```bash
promptx status
promptx restart
promptx stop
```

运行数据保存在 `~/.promptx/`，面向本机单用户使用，无需注册账号。

## 主要功能

- 多 Agent 会话与历史导入，实时展示消息、思考和工具调用。
- 多标签与分屏、文件浏览、Git Diff、图片附件和交互图表预览。
- 托管 Web 服务、桌面应用和监听任务，按需查看日志、停止与重启。
- 多种主题，适配桌面与手机。
- 手机远程访问采用端到端加密，Relay 仅转发密文。

手机连接：进入“设置 → 远程访问”扫码打开。配对链接等同访问凭证，请勿公开分享。详见 [Relay 使用说明](docs/relay-quickstart.md)。

## 源码开发

```bash
pnpm install
pnpm dev
```

开发统一入口为 [http://127.0.0.1:4002](http://127.0.0.1:4002)，支持热更新，API 通过同一端口转发至内部 Daemon。开发与正式环境沿用相同的数据配置，默认使用 `~/.promptx/`。正式环境使用 4001。

```bash
pnpm build
pnpm test
pnpm release:check
```

更多说明见 [架构文档](docs/v2-architecture-baseline.md)，版本变化见 [更新记录](CHANGELOG.md)。

## 协议

[Apache-2.0](LICENSE)
