# V2 Agent 与 Timeline 协议

本文说明 PromptX V2 如何把 Codex、Claude 和 ACP/Kimi 的原生事件统一为前端可消费、SQLite 可持久化的 Timeline。完整领域模型见 [V2 架构基线](./v2-architecture-baseline.md)。

## 边界

```text
Provider 原生事件
  -> Provider Runtime
  -> 标准 TimelineItem
  -> TimelineStore
  -> SQLite + SSE
  -> Web Timeline
```

- Provider Runtime 负责启动、恢复和取消原生会话，并将原始事件映射为标准事件。
- `AgentManager` 负责 Turn 并发、生命周期和事件发布。
- `TimelineStore` 是实时事件写入与分页读取入口。
- `TimelineSyncCoordinator` 负责将 Provider 历史与本地 Timeline 对账。
- Relay 只转发端到端加密后的 HTTP/SSE 帧，不理解本协议。

## Turn

一次用户提交对应一个 Turn：

```text
queued -> running -> completed
                  -> failed
                  -> canceled
```

同一 Agent Session 最多只有一个 `queued` 或 `running` Turn。客户端必须生成 `clientMessageId`；相同 Agent Session 内重复提交同一 ID 时复用原 Turn，以保证重试幂等。

## Timeline Row

每条记录由 Daemon 分配严格递增的 `seq`：

```json
{
  "seq": 42,
  "timestamp": "2026-09-04T10:00:00.000Z",
  "turnId": "local-turn-id",
  "providerMessageId": "optional-provider-id",
  "item": {
    "type": "assistant_message",
    "phase": "final_answer",
    "text": "已完成"
  }
}
```

`item.type` 当前包括：

- `user_message`
- `reasoning`
- `assistant_message`
- `tool_call`
- `todo`
- `system_notice`
- `error`

具体字段由 `packages/protocol/src/timeline.js` 中的 Zod Schema 定义。Provider SDK 对象、进程句柄和私有协议字段不得进入 Timeline。

## 实时与分页

- 初次读取使用 `direction=tail`，只返回末尾窗口。
- 加载旧历史使用 `direction=before`，不得触发 Provider 全量同步。
- SSE 重连使用 `direction=after` 和 `epoch:seq` cursor 补齐增量。
- cursor epoch 过期或本地窗口存在缺口时，服务端返回 `reset=true` 和最新尾页。
- 前端首次加载显示骨架；已有缓存时保留内容并后台同步；局部动作只显示局部 loading。

## 历史对账

Provider 历史是跨客户端会话内容的来源，本地 SQLite 是 PromptX 的规范化视图。对账器通过 Provider revision、原生 Turn ID、客户端消息 ID 和规范化用户文本匹配 Turn：

- 历史只有追加内容时执行 append。
- 中间 Turn 缺失、顺序变化或历史被裁剪时执行 rebuild。
- 本地实时事件比 Provider 快时保留本地丰富事件，避免被较稀疏的历史快照降级。
- 同步写入以 `expectedNextSeq` 做乐观并发检查；并发变化时放弃本次结果并重新同步。
- 外部历史文件出现未结束 Turn 不等于 Provider 仍在运行，不能据此永久锁定输入。

## 参考实现

- Schema：`packages/protocol/src/timeline.js`
- Timeline 投影：`packages/protocol/src/timelineProjection.js`
- Agent 生命周期：`apps/daemon/src/agent/agentManager.js`
- 历史对账：`apps/daemon/src/agent/history/historyReconciler.js`
- 同步协调：`apps/daemon/src/agent/history/timelineSyncCoordinator.js`
- Codex：`apps/daemon/src/agent/providers/codex.js`
- Claude：`apps/daemon/src/agent/providers/claude.js`
- ACP/Kimi：`apps/daemon/src/agent/providers/acp.js`
- API 与 SSE：`apps/daemon/src/api/routes.js`
- 前端：`apps/web/src/views/WorkbenchView.vue`
