# Agent 交互问答

本次接入让 Agent 提出的问题直接显示在 Timeline 内。桌面、本地手机和手机 Relay 共用交互卡片；同步问题回答回到原工具调用，异步问题回答恢复会话。

## 交互规则

- 完全访问仍自动处理普通命令、文件与网络权限，不代替用户做需求选择。
- Codex 的 `item/tool/requestUserInput`（兼容 `tool/requestUserInput`）支持选项、自由回答及隐藏输入，按问题 ID 回传 `answers`。
- 启动 Codex app-server 时仅对该子进程启用 `default_mode_request_user_input`，允许默认模式提问，不改变用户全局配置或切换到计划模式。
- Codex 的异步 `agentMessage` 仅在原生 `delivery: async` 和 `questions` 字段齐全时生成卡片。按原生调用身份回传 `send_user_message_question_reply`；执行中通过 `turn/steer` 回答，原轮已完成时创建新轮恢复会话。Timeline 显示友好的答案摘要。
- Claude SDK 的 `canUseTool` 接收 `AskUserQuestion` 和实际进入回调的 `ExitPlanMode`。问答保留原始输入，按完整问题文本回填答案；其他工具维持完全访问策略。
- Kimi/Grok 共用 ACP：普通允许/拒绝权限自动处理。相同允许类型出现多次时，参考 Paseo 判断为需要选择的请求；模式切换也交给用户。显示原始选项，回传原始 `optionId`。ACP 不提供自由输入时，不额外构造文字回答。
- Grok CLI 1.0.40 的原生问答另外使用 `_x.ai/ask_user_question` 扩展；接入客户端 `extMethod`，保持原 RPC 等待。支持 `multiSelect`、选项说明与其他回答；答案以完整问题文本为键、字符串数组为值，返回 `{ outcome: 'accepted', answers, annotations: {} }`，取消返回 `{ outcome: 'declined' }`。连接关闭、停止任务时解除等待；过期连接和跨会话请求不得生成卡片，未知扩展继续返回 Method not found。
- 多选题提交全部选项；“其他回答”替代已选选项。填写完整后才可提交。
- 普通回复中的文字提问继续通过输入框回复，不根据内容猜测交互表单。

待回答时会话列表、桌面标签及会话状态显示提醒，生成动画暂停，仍保留停止任务操作。已回答、已取消及已失效的问题留下可展开摘要；秘密输入的答案不会写入 PromptX 的 Timeline。

## 状态与 Relay

`PendingInteractions` 在原 Runtime 内保存待回答请求及回调。问题和最终状态写入当前 Turn 的 Timeline，由投影合并为一张卡片。SSE 初始快照带待回答列表，刷新、切换标签、Relay 重连均可恢复。

回答接口为 `POST /api/v2/tasks/:taskId/interactions/:requestId/respond`。服务端校验题目、选项和动作，并同步取走请求；重复回答和失效请求返回 409。取消任务、关闭会话、Agent 退出或原请求被 Codex 结束时，解除等待并标记失效。

服务重启无法恢复已退出 Provider 的同步回调，因此将同步未决问题标记失效。Codex 异步问题保存于会话历史，重启后仍可回答。取消任务会将当前异步问题失效；显式取消询问只收起卡片。

Relay 沿用现有加密请求与共享 SSE，只同步问题字段和状态变化，不加载执行详情。前端回答验证单独放在无 Zod 依赖的模块中，避免新增完整协议校验库到浏览器包。

当前不支持 MCP 的复杂表单及外部 URL 授权。Codex 未识别的请求返回明确的 JSON-RPC 不支持错误并显示提示，避免静默返回空对象。

## Paseo 参考

参考本地 `/Users/bravf/code/paseo`：

- `packages/server/src/server/agent/providers/codex-app-server-agent.ts`：保持 RPC 等待，按问题身份回传答案。
- `packages/server/src/server/agent/providers/claude/agent.ts`：`AskUserQuestion` 回调、其他答案入口、完整问题文本作为答案键。
- `packages/server/src/server/agent/providers/acp-agent.ts`：选择请求不参与自动批准，保留原生选项 ID。
- `packages/app/src/components/question-form-card.tsx`：单选、多选、自由输入及明确提交。

PromptX 保留原有 REST/SSE、Timeline 分页及主题体系，没有引入 Paseo 的会话管理层。另用本机 Codex CLI 导出的 JSON Schema 校验当前问答和权限审批响应结构。

## 验证

- Provider 测试：Codex 默认模式开关、原 RPC、异步结构化问题与历史映射、自动结束请求、新权限审批结构；Claude SDK 回调及答案映射；ACP 普通权限和原生选择；无效与重复答案、秘密输入、取消。
- API 测试：会话隔离、SSE 游标重连、注意状态、重复提交、继续原 Turn、取消及重启失效。
- 浏览器测试：桌面及手机真实加密 Relay 通道，刷新恢复、单选/多选/文字提交、跨端更新、ACP 操作卡片、停止任务与手机布局，以及异步问题在完成后回答并创建恢复轮次。
- 本机 Codex CLI 0.159.2 的独立临时会话真实验证：默认模式收到同步提问 RPC，回复 Markdown 后完成；另启用异步工具收到结构化问题，用原生答案文本恢复后识别 Markdown。测试不对用户现有会话发送消息或读写工作区文件。Claude/Kimi 的模型行为用协议模拟验证。
- 本机 Grok CLI 1.0.40 独立临时目录真实验证：原生扩展问题回传 JSON 单选和“前端、Relay”多选后，模型正确复述选择并完成；另测取消问题后回复“已取消”。手机加密 Relay 回归复用实际 Grok 问答映射，验证刷新、单选、多选、提交和跨端摘要。该 Grok 扩展依据真实 CLI 请求与响应验证接入，Paseo 当前的标准 ACP 权限实现不覆盖此扩展。
