# Pi 接入

PromptX 通过 `pi --mode rpc` 启动独立进程，使用 Pi 原生账号、模型目录与扩展配置。无需在 PromptX 中另存 API Key。

## 本机准备

安装 Pi（当前适配版本为 1.3.0，需要 Node.js 22.19 或更新版本）：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent@1.3.0
pi
```

在 Pi 中运行 `/login` 配置供应商，再使用 `/model` 选择模型。先确保在相同工作目录下能正常对话。

重启 PromptX daemon，新建会话时选择 Pi。模型列表直接来自当前 Pi RPC 的 `get_available_models`，保留 `deepseek/deepseek-flash` 等完整供应商前缀。模型切换后重新读取实际支持的思考档位。

找不到命令时，可在启动 daemon 前通过 `PI_BIN` 设置 Pi 可执行文件的绝对路径；也兼容 Paseo 的 `PI_COMMAND` 环境变量（单个命令路径）。

## 已接入能力

- 文本、思考和工具调用的流式 Timeline。
- 图片与文件输入，由所选模型决定是否支持图片。
- 动态模型选择、思考强度和实际上下文使用量。
- 保存原生会话文件路径，重启 daemon 后恢复会话；支持发现并导入 Pi 原生历史会话。
- 取消、模型错误、重试提示及进程意外退出处理。
- Pi 扩展的 select、confirm、input 和 editor 问答。

本轮完成等待 `agent_settled`，不把 prompt 接收成功或中间的 `agent_end` 当作最终完成。

## 当前范围

首版不提供后台子任务状态映射，也未注入 PromptX 专用的服务管理 MCP。Pi 自身配置的工具和扩展保持可用。不要将 Pi 认证文件提交到仓库。

实现参考本机 Paseo 的 Pi RPC 适配思路，并使用本机安装版本的 RPC 文档校验字段。
