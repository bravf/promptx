# 后台任务与自动续跑

## 行为与边界

前台 Turn 完成和后台任务完成是两个独立状态。主回复结束后，后台任务归在主 Timeline 的发起轮次内；可在原处展开查看 Markdown 结果，不跳转到独立子 Timeline，也可停止会话全部任务。无法确定发起轮次的历史任务在主 Timeline 单独归组，不猜测归属。Provider 自动恢复主会话时创建新的 Turn，显示“后台任务触发自动续跑”，不伪造用户消息。

子任务正文不会直接混入主会话；迟到的工具更新归属原始 Turn。数据库 v8 增量增加 provider_tasks，保留旧数据。重启后保留任务摘要，无法恢复的运行中任务标为中断，不宣称仍在运行。

本版详情是任务摘要，不是完整子 Agent Timeline。Kimi 没有经确认的原生子任务协议，不依据 Task 工具名猜测支持。

## Provider 接入

- Claude：监听 SDK task_started、task_progress、task_notification；result 只结束当前前台轮次，流继续接收后台任务及自动回复。停止使用 SDK stopTask。
- Codex：识别 subAgentActivity 和 collabAgentToolCall；对子线程事件进行隔离和有界乱序缓存，子线程完成不结算主线程。通过子线程当前 Turn 执行中断。
- Grok：标准 ACP 负责输入输出；厂商扩展负责 subagent_spawned、subagent_progress、subagent_finished 和 turn_completed。停止使用已实测的 _x.ai/session/close；普通 ACP cancel(child session) 未能可靠停止后台任务。
- 通用 ACP：保留迟到的工具更新，使用请求标识隔离旧请求结束事件。准备输入期间若发生自动续跑，拒绝覆盖该自动轮次。

参考本地 Paseo 的会话级任务状态、自动轮次路由和子线程隔离。协议细节以本机 CLI 实际事件为准，没有直接复制其会话管理层。

Codex 无后台任务时仍按既有策略释放写入连接。有后台任务时保留连接等待自动续跑；若最后一个子任务结束却没有主线程结束通知，连接会保持至会话关闭或服务关闭，避免过早断开丢失汇总。这一保守策略尚未实现无通知情况下的可靠空闲回收。

## 验证

真实模型测试使用临时 Git 工作区、独立 SQLite 和只读任务，不改用户项目：

| Provider | 两个子任务及汇总 42 | 历史同步不重复汇总 | 后续对话 | 全部停止 |
| --- | --- | --- | --- | --- |
| Claude | 通过 | 通过 | 通过 | 通过 |
| Codex | 通过 | 通过 | 通过 | 通过 |
| Grok | 通过 | 通过 | 通过 | 通过 |
| Kimi | 未调用 | 未调用 | 未调用 | 未调用 |

Claude 首次测试遇到上游 502，重试通过。Grok 历史同步补入工具记录（14→17 行），最终汇总未重复。Claude 20→20 行，Codex 11→11 行。

复现命令（会实际调用模型并产生用量）：

```bash
node scripts/qa-background-tasks.mjs claude
node scripts/qa-background-tasks.mjs codex
node scripts/qa-background-tasks.mjs grok
node scripts/qa-background-tasks.mjs grok cancel
```

取消模式同样适用于 Claude、Codex。临时目录保留用于排查。

自动化覆盖：旧请求迟到、子线程乱序、自动续跑、子消息隔离、重启状态、数据库迁移、来源校验和残缺历史不覆盖明确终态。真实测试不代表所有时序组合均经过实际服务验证。

新增回归包含子任务区域的桌面/手机布局、轮次归属和完成提醒；pnpm build 通过。使用独立 PROMPTX_HOME 在 3198/5198 端口启动 pnpm dev，前端页面及工作区 API 冒烟通过。浏览器桌面和手机检查了后台任务摘要与横向溢出；完整 E2E 覆盖既有发送、取消、导入、附件、文件、Diff、终端、Relay 设置等交互。
