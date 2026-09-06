# PromptX 全面回归测试报告

- 测试日期：2026-09-06
- 测试分支：`feat/task-worktree-architecture`
- 基线提交：`3853ca5 feat: 完成任务级 Worktree 数据模型升级`
- 测试系统：Windows，Node.js `v22.22.1`，pnpm `10.15.1`，Git `2.52.0.windows.1`
- 页面尺寸：桌面 `1440x900`，移动端 `390x844`
- 数据隔离：浏览器回归使用内存 SQLite、系统临时工作区、临时上传目录和临时 Relay 身份；服务命令使用独立 `PROMPTX_HOME` 和端口 `31871`

## 结论

本轮覆盖当前 V2 工作台、Daemon、共享协议、Relay、CLI 服务脚本和发布物。自动化测试共 140 项通过、2 项因 Windows 环境限制跳过；3 条浏览器 E2E 全部通过；工作区构建、运行时导入检查、Doctor 和 npm 打包预览通过。

回归发现并修复 4 类问题：新建会话错误在弹窗内不可见；非法工作区路径和 Relay URL 被错误归类为 HTTP 500 且暴露英文底层异常；原有 E2E 的 Relay 配置和身份文件没有显式隔离；Windows 下 Git Worktree 路径分隔符不一致导致真实存在的 Worktree 被误判为 `missing`。修复后已重新执行完整测试。

## 现有功能清单与结果

| 功能域 | 当前功能 | 本轮验证 | 结果 |
| --- | --- | --- | --- |
| 工作区 | 真实目录绑定、目录搜索、工作区展开/收起、移除 | API、目录搜索单测、桌面 E2E、移动端 E2E | 通过 |
| 会话 | 新建、导入、删除、切换、标题、草稿按会话保留 | API、Provider 导入单测、桌面 E2E、确认弹窗 | 通过 |
| 执行环境 | 当前目录、独立 Worktree、基线、分支、目录状态对账 | API、Worktree 单测、任务详情 E2E | 通过 |
| 数据模型 | Project、Task、Execution Environment、Agent Session、Turn、Timeline | 数据库和 Repository 单测 | 通过 |
| 旧数据策略 | 新数据库只创建当前模型；检测到旧业务表时拒绝启动 | 数据库单测 | 通过 |
| Provider | Codex、Claude Code、Kimi Code/ACP 注册与统一能力 | Provider 单测、Doctor、模拟 Runtime E2E | 条件通过 |
| Provider 控制 | 模型、思考强度、上下文用量、运行中锁定设置 | Daemon 单测、桌面 E2E | 通过 |
| Provider 生命周期 | 启动、恢复、取消、失败、writer 冲突和自动解归档 | AgentManager 与 Provider 单测、桌面 E2E | 通过 |
| Timeline | 用户消息、思考、工具、Todo、系统通知、最终回复、错误 | Protocol/Web/Daemon 单测、桌面 E2E | 通过 |
| Timeline 同步 | 增量、历史对账、rewind、epoch、游标分页、并发补跑 | Repository、Store、Coordinator 单测 | 通过 |
| Timeline 交互 | 自动滚动、离底提示、耗时、过程展开、文件路径跳转 | Web 单测、桌面 E2E、视觉检查 | 通过 |
| SSE | 全局事件、会话事件、跨域头、事件游标 | EventHub、API、Web 解析器单测 | 通过 |
| 附件 | 图片和文件上传、预览、移除、失败重试、纯附件发送 | API/Provider 单测、桌面 E2E | 通过 |
| 附件限制 | 单文件 50 MB、每次最多 10 个、MIME 与会话归属校验 | 代码审查、API 单测、超限 E2E | 通过 |
| 文件浏览 | 目录树、隐藏文件、文本高亮、图片、二进制、超大文件 | Workspace 单测、桌面/移动端 E2E | 通过 |
| 文件安全 | 父目录逃逸、工作区外路径、外部符号链接 | Workspace 单测 | 条件通过 |
| Git | 分支、staged/unstaged/untracked 状态和 Diff、超大 Diff 截断 | Workspace 单测、桌面 E2E、视觉检查 | 通过 |
| Git 操作 API | 提交、推送、合并、提交列表 | 路由和实现审查；底层 Git 能力由 Worktree/API 测试覆盖 | 静态检查通过 |
| 任务详情 | 会话、Provider、执行目录、Worktree 分支、Git 状态 | 桌面 E2E | 通过 |
| 详情同步 | 详情打开时切换左侧会话，同步加载新会话信息 | 两条 E2E | 通过 |
| 抽屉 | 文件、Diff、任务详情同尺寸，开关和切换 | 桌面/移动端 E2E、视觉检查 | 通过 |
| 设置 | 外观、远程访问、关于 | 桌面/移动端 E2E、视觉检查 | 通过 |
| 主题 | 8 个主题、明暗模式、即时切换、刷新持久化 | 现有 E2E、全面 E2E | 通过 |
| 响应式 | 桌面双栏、移动端侧栏/Timeline、全屏弹层 | 移动端 E2E、截图检查 | 通过 |
| 移动端 History | 返回侧栏、关闭设置、新建和导入弹层 | 两条 E2E | 通过 |
| Relay | E2EE、密钥派生、Offer、nonce 防重放、双向转发、离线握手 | Relay 单测、Daemon Relay 集成测试 | 通过 |
| Relay 设置 | 地址、启停、配对链接、重连、身份重置确认 | 桌面 E2E、输入错误单测 | 通过 |
| 安全边界 | Origin 白名单、Relay 凭证头剥离、仅允许 V2 API | Daemon/Relay 单测 | 通过 |
| 服务脚本 | start、status、restart、stop | 隔离目录和独立端口实测 | 通过 |
| Doctor | Node、目录、前端产物、Provider CLI、端口 | `node bin/promptx.js doctor` | 8 通过、1 警告 |
| 发布物 | 构建、测试、运行时 import、npm pack 清单 | 发布检查与 `npm pack --dry-run` | 通过 |
| Android 壳 | WebView、地址管理、上传/拍照、下载、图片分享、返回导航 | 源码和 Manifest 审查 | 环境未构建 |

## 浏览器回归细项

桌面链路使用隔离的 Git 工作区和模拟 Provider Runtime，实际操作了以下流程：

1. 加载已有 Timeline，展开思考、工具调用和 Todo，检查最终回复和耗时。
2. 浏览文本、PNG、二进制和超过 2 MB 的文本文件，切换隐藏文件显示。
3. 检查 unstaged、staged、untracked 三类 Git 变更及对应 Diff。
4. 打开任务详情并切换左侧会话，确认标题、目录和 Git 信息同步更新。
5. 在两个会话间切换并验证独立草稿恢复。
6. 切换模型和思考强度，检查 75% 上下文环和运行中控件禁用。
7. 上传并预览图片、移除附件、模拟上传失败、重试成功、检查 50 MB 超限错误。
8. 发送正常消息并接收 Timeline 增量；启动长任务并取消。
9. 检查新建会话的默认当前目录、Worktree 字段、非法目录错误、本地会话创建。
10. 检查删除会话的取消与确认。
11. 检查导入列表、Provider 错误、搜索空态、清空搜索、筛选和导入成功。
12. 检查主题切换和持久化、Relay 非法 URL、配对信息、身份重置确认、关于页。
13. 全程收集 `pageerror` 和非预期 console error，并检查页面水平溢出。

移动端链路验证了侧栏进入 Timeline、返回侧栏、文件抽屉、设置/新建/导入全屏尺寸、浏览器 History 返回，以及各阶段水平溢出。稳定动画后人工复核截图，未发现文本遮挡、控件重叠、抽屉越界或异常空白。

## 自动化结果

`pnpm test`：

| 包 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: |
| `@promptx/shared` | 2 | 0 | 0 |
| `@promptx/relay` | 9 | 0 | 0 |
| `@promptx/protocol` | 4 | 0 | 0 |
| `@promptx/daemon` | 85 | 2 | 0 |
| `@promptx/web` | 40 | 0 | 0 |
| 合计 | 140 | 2 | 0 |

`pnpm test:e2e`：3 通过，0 失败。

- V2 全面桌面交互回归
- V2 移动端布局、弹层和 History 回归
- V2 桌面首屏与移动端 History 返回链路

其他检查：

| 命令 | 结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm lint` | 脚本通过，但当前各包只有占位 lint，没有 ESLint/静态规则 |
| `node scripts/release.mjs check --skip-git-check` | 通过 |
| `pnpm release:check` | 按设计拒绝未提交工作区；本轮后续只读检查已单独完整执行 |
| `pnpm release:check:imports` | 通过 |
| `npm pack --dry-run` | 121 个文件，包约 951.8 KB，解包约 3.5 MB |
| `git diff --check` | 通过 |

## 本轮发现与修复

### 1. 新建会话失败时弹窗不显示错误

原行为：`createConversation` 把错误写到主工作台底部，弹窗覆盖页面后用户看不到失败原因。

修复：为新建会话弹窗增加独立错误状态和 `role="alert"` 提示；每次打开和提交前清理旧错误。E2E 使用不存在的目录验证中文错误在弹窗内可见。

### 2. 可预期输入错误被返回为 HTTP 500

原行为：不存在的工作区目录返回底层 `ENOENT`；非法 Relay URL 返回 `Invalid URL`，两者状态码都是 500。

修复：工作区路径不存在、路径不是目录、Relay URL 格式错误和协议错误统一返回 HTTP 400，并使用中文提示。新增 Daemon 单测和浏览器回归断言。

### 3. E2E Relay 身份没有完全隔离

原行为：即使 `relay: false`，应用仍会初始化 Relay 身份；旧 E2E 没有传入临时配置路径。

修复：现有和新增 E2E 都显式传入临时 `configPath` 与 `identityPath`，测试结束后清理，不再依赖用户目录。

### 4. Windows Git Worktree 被误判为不可用

原行为：数据库保存的 Worktree 路径使用 Windows 反斜杠，而 `git worktree list --porcelain` 输出使用正斜杠。环境对账使用严格字符串比较，将实际存在且分支正常绑定的 Worktree 标记为 `missing`，任务详情页因此提示“当前会话的执行目录不可用”。

修复：对 Git 输出路径和数据库路径统一解析、分隔符和 Windows 大小写后再比较，并补充路径格式、大小写和缺失路径回归用例。已对任务 `d26762ae-0d57-4d75-8ff8-51d205b9bd16` 与 `task-3` 实际调用环境对账接口，二者均恢复为 `clean`。

## 环境限制与剩余风险

1. Windows 当前权限不能创建测试符号链接，工作区外符号链接逃逸分支跳过。父目录逃逸和普通路径边界已通过。
2. Windows 临时目录偶发 `EBUSY`，非 Git 工作区状态用例跳过；Git 工作区、文件浏览和 Diff 均已实测。
3. Kimi CLI 未安装。Kimi 的 ACP、历史 JSONL 映射、控制状态和错误处理单测通过，但没有真实 Kimi 进程会话。
4. Codex CLI `0.153.4` 和 Claude Code `2.1.90` 已由 Doctor 检测；本轮没有发起会消耗真实模型配额的在线请求。发送、取消、设置和增量 Timeline 使用模拟 Runtime 验证。
5. Relay 已完成本地盲转发、E2EE、SSE 和 FormData 集成测试，没有连接公网 `px.mushayu.com` 做跨网络稳定性测试。
6. Android 项目没有 Gradle Wrapper，当前机器也没有 Java/Gradle，无法生成 debug APK 或做模拟器/真机测试。本轮只完成源码、权限、WebView、文件选择和分享流程审查。
7. `pnpm lint` 当前是占位脚本，不能替代 ESLint、Vue 模板规则或类型检查。
8. 构建提示 `caniuse-lite` 数据约 7 个月未更新，不影响本轮构建，但应在后续依赖维护中更新。
9. Git 提交、推送和合并没有连接测试远端执行破坏性写入；本轮覆盖状态、Diff、Worktree 和路由实现，真实远端权限及分支保护仍需在受控仓库验证。

## 建议的后续门禁

1. 保留新增全面 E2E 作为每次 UI、会话模型和抽屉改动后的回归门禁。
2. 在 CI 的 Linux 环境补跑符号链接逃逸和非 Git 工作区测试，消除 Windows 跳过项。
3. 增加真实 ESLint/Vue 检查，替换现有占位 lint。
4. 配置 Java 17、Android SDK 36 和可复现的 Gradle Wrapper，将 debug APK 构建纳入 CI。
5. 为真实 Provider 和公网 Relay 建立显式启用、受配额控制的夜间冒烟任务。
