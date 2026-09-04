# Repository Guidelines

## 沟通约定

- 这个项目后续默认使用中文沟通。
- 生成的说明、文档、界面文案、开发备注与交付内容，均以中文优先。
- 只有在第三方接口、代码标识、协议字段或外部工具要求英文时，才保留必要英文。

## 项目结构与模块划分

本仓库使用 `pnpm workspace` 管理，主要分为以下部分：

- `apps/web`：前端应用，基于 Vite + Vue 3。页面放在 `src/views`，组件放在 `src/components`，工具函数在 `src/lib` 和 `src/composables`。
- `apps/daemon`：V2 本地服务，基于 Fastify。入口在 `src/index.js`，Provider 在 `src/agent/providers`，数据访问与 SQLite 封装在 `src/db`。
- `apps/android`：加载远程 H5 的 Android WebView 壳。
- `packages/protocol`：V2 前后端共享的 Zod 协议与 Timeline 投影逻辑。
- `packages/relay`：E2EE Relay 协议、加密实现与公网 Relay Server。
- `packages/shared`：跨进程共享的日志辅助函数。

前端构建产物在 `apps/web/dist`。本地运行数据默认位于 `~/.promptx/data`、`~/.promptx/uploads-v2` 和 `~/.promptx/tmp`，不要提交。

## 构建、测试与开发命令

- `pnpm install`：安装工作区依赖
- `pnpm dev`：同时启动前端和后端开发环境
- `pnpm build`：构建前端并执行工作区构建脚本

示例：

```bash
pnpm install
pnpm dev
```

## 代码风格与命名规范

- 使用 2 空格缩进。
- 默认使用 ASCII；若现有文件或中文文案需要，可使用中文。
- Vue 组件文件使用 PascalCase，例如 `TimelineTurn.vue`。
- 工具模块使用小写或 camelCase，例如 `api.js`、`useTheme.js`。
- 样式采用 Tailwind 优先，并保持既定 stone 工具风：`rounded-sm`、主结构实线边框、次级强调使用虚线边框。
- 前后端协议与 Timeline 投影优先放入 `packages/protocol`；进程通用日志逻辑放入 `packages/shared`。

## 产品术语约定

- 当前工作台的产品心智是：`工作区 -> Agent 对话 -> Turn -> Timeline`。
- 一个工作区绑定一个真实目录；同一工作区可以包含多条 Codex、Claude 或 Kimi 对话。
- 面向用户的主文案使用“工作区”和“对话”；“Session/线程”只用于描述 Provider 原生会话或内部协议。
- 代码实现与数据库字段沿用 `workspace`、`agent`、`session`、`turn` 和 `timeline` 命名，除非明确进行领域重构，不做仅为文案一致性的批量重命名。

## 主题开发约定

- 当前前端已经从简单深浅模式升级为可扩展的 themes system；新增界面或调整样式时，颜色优先走主题 token，不要重新写回大量 `dark:`、`bg-stone-*`、`text-stone-*` 这类硬编码颜色类。
- 主题定义集中在 `apps/web/src/lib/themes.js`；主题切换与持久化在 `apps/web/src/composables/useTheme.js`；全局语义样式和 token 映射在 `apps/web/src/styles.css`。
- 开发新主题时，优先复用现有 token 结构，不要为单个主题单独加特例逻辑；如确实缺少语义槽位，应先补 token 或语义类，再改组件。
- 组件层尽量只处理布局、间距、字号和结构；常见颜色与状态优先复用现有语义类，例如 `panel`、`tool-button`、`tool-button-primary`、`theme-status-*`、`theme-filter-*`、`theme-empty-state`、`theme-heading`、`theme-muted-text`。
- 新增或调整主题后，至少手动检查这些区域：工作区列表、Timeline、输入框、Diff 面板、各类弹窗、图片预览层、下拉/浮层。
- 主题相关改动提交前，至少运行 `pnpm build`，并确认主题切换、刷新后的持久化、文本对比度和状态色区分都正常。

## 测试要求

当前还没有完整自动化测试，提交前至少完成以下检查：

- 运行 `pnpm build`
- 使用 `pnpm dev` 做基础冒烟验证
- 手动检查核心流程：新建/导入对话、发送与取消、Timeline 同步、附件上传、文件浏览、Git Diff 和 Relay 设置

后续新增测试时，建议放在功能附近或 `__tests__` 目录，并使用 `*.test.js` 命名。

## 提交与合并请求规范

当前目录没有可参考的 Git 历史，默认采用简洁的 Conventional Commits 风格：

- `feat: 增加会话导入筛选`
- `fix: 修复 Timeline 增量同步`

PR 应包含：

- 变更目的和范围
- 涉及模块，例如 `apps/web`、`apps/daemon`、`packages/relay`
- 手动验证步骤
- UI 变更截图或录屏

## 安全与配置说明

- 不要提交数据库文件、上传文件、临时目录或 `.env`。
- 项目默认是匿名模式，不要在未讨论前引入登录、权限系统或复杂鉴权。
- Daemon 默认只监听 loopback；新增跨域入口时必须更新并验证 Origin 白名单。
- Relay 配对链接等同远程访问凭证，私钥、完整 Offer 和解密后的业务内容不得写入公网 Relay 日志。
