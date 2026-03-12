# TmpPrompt

一个轻量匿名工具：把需求描述、上下文文本和截图整理成临时页面，再把公开链接或 Raw 文本交给 Codex 等模型继续使用。

## 快速使用说明

如果你第一次接触这个项目，可以先按下面步骤跑起来。

### 1. 下载代码

```bash
git clone https://github.com/bravf/tmpprompt.git
cd tmpprompt
```

### 2. 安装依赖

```bash
pnpm install
```

### 3. 启动前后端

```bash
pnpm dev
```

默认会启动：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

### 4. 安装禅道扩展

1. 打开 Chrome 扩展管理页：`chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：`apps/zentao-extension`

### 5. 开始使用

- 打开首页创建临时文档
- 或打开禅道 Bug 详情页，点击右下角 `AI提示词`
- 或在编辑页直接拖入 `.pdf`、`.md`、`.txt`、图片文件
- 生成完成后，可继续编辑文档，或复制 Raw 链接给 Codex

## 项目定位

- 面向“先把需求和上下文整理好，再交给模型继续开发”的轻量场景。
- 不引入登录和账号体系，默认匿名使用，尽量减少使用门槛。
- 默认单机使用，文档打开后即可继续编辑，不再做额外编辑权限校验。
- 公开文档默认进入首页列表，并在 24 小时后自动过期。
- 当前优先解决个人与小团队的临时整理需求，不追求复杂协作和权限体系。

## 当前能力

- Web 端
  - 创建匿名文档并自动生成公开链接
  - 首页查看最近公开文档列表，支持继续编辑和删除
  - 编辑页支持纯文本块、导入文本块、图片块混排
  - 支持粘贴截图、拖拽图片、选择图片上传
  - 支持导入 `.md`、`.markdown`、`.txt` 文本文件
  - 支持导入单栏、简单图文 PDF，并按图文顺序插入编辑器
  - 自动保存、站内离页确认、快捷键保存
  - 公开页查看和 Raw 文本导出
  - 浅色 / 深色主题切换

- Server 端
  - 提供文档的创建、读取、更新、删除接口
  - 提供图片上传、压缩和静态访问能力
  - 使用本地 SQLite 持久化文档与块数据
  - 支持文档过期清理与公开列表读取

- 禅道插件
  - 在禅道 Bug 详情页一键生成 TmpPrompt 文档
  - 自动提取正文文本、图片和部分上下文信息
  - 自动复制适合发给 Codex 的提示词
  - 避免把禅道原始链接写进文档正文，减少对模型的误导

## 技术栈

- `apps/web`
  - 基于 Vite + Vue 3 + Vue Router + TailwindCSS
  - 负责首页、编辑页、公开页和主题切换等前端交互

- `apps/server`
  - 基于 Fastify + `sql.js` + `jimp`
  - 负责文档接口、图片上传、静态资源和本地数据持久化

- `apps/zentao-extension`
  - 基于 Chrome Manifest V3
  - 负责在禅道 Bug 页面提取内容并创建 TmpPrompt 文档

- `packages/shared`
  - 存放共享常量、块类型、导出逻辑和标题提取逻辑

- `pnpm workspace`
  - 负责管理多包仓库和统一构建流程

## 目录结构

```text
apps/
  zentao-extension/
  server/
    src/
  web/
    src/
packages/
  shared/
```

主要模块说明：

- `apps/web/src/views`: 页面级视图，如首页、编辑页、公开页
- `apps/web/src/components`: 编辑器、通知、主题切换等组件
- `apps/web/src/lib`: API 请求等工具函数
- `apps/zentao-extension`: 禅道 Bug 转 TmpPrompt 的浏览器插件，当前默认连接本地 `5173/3000`
- `apps/server/src/index.js`: Fastify 入口与 HTTP 接口
- `apps/server/src/repository.js`: 文档和块数据读写
- `apps/server/src/db.js`: 本地 SQLite 初始化与持久化封装
- `packages/shared/src/index.js`: 前后端共享常量和文档导出逻辑

## 本地开发

安装依赖：

```bash
pnpm install
```

启动前后端开发环境：

```bash
pnpm dev
```

默认地址：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

## 构建与检查

构建整个工作区：

```bash
pnpm build
```

运行占位 lint：

```bash
pnpm lint
```

当前仓库还没有完整自动化测试。提交前至少建议完成：

1. 运行 `pnpm build`
2. 运行 `pnpm dev` 做基础冒烟验证
3. 手动验证创建文档、编辑保存、上传图片、导入文本文件、公开页访问、Raw 导出

## 数据与本地文件

服务端运行时数据默认放在 `apps/server/` 下：

- `data/tmpprompt.sqlite`: SQLite 数据文件
- `uploads/`: 上传后的图片文件
- `tmp/`: 临时处理中间文件

这些目录和文件不应提交到仓库。

## API 概览

- `POST /api/documents`: 创建文档
- `GET /api/documents`: 获取公开文档列表
- `GET /api/documents/:slug`: 获取文档详情
- `PUT /api/documents/:slug`: 更新文档
- `DELETE /api/documents/:slug`: 删除文档
- `POST /api/uploads`: 上传并压缩图片
- `GET /p/:slug/raw`: 获取文档 Raw 文本

## 使用说明

1. 在首页创建新文档。
2. 在编辑页输入需求文本，或直接粘贴截图、拖入图片和文本文件。
3. 如需处理需求 PDF，可直接把单栏 PDF 拖入编辑页，系统会尝试按图文顺序解析。
4. 自动保存完成后，复制公开页链接或 Raw 文本链接给模型。
5. 如需继续编辑，直接打开对应文档的编辑页即可。

## 禅道插件使用

`apps/zentao-extension` 是当前仓库内置的禅道浏览器插件，用来把禅道 Bug 详情页快速整理成 TmpPrompt 文档，并自动复制适合发给 Codex 的提示词。

### 适用场景

- 在禅道 Bug 详情页快速提取正文内容
- 自动抓取正文中的图片并转存到 TmpPrompt
- 直接生成可编辑、可公开访问、可导出 Raw 的临时文档
- 复制一段可直接发给 Codex 的提示词

### 使用前提

- 本地已经启动前端：`http://localhost:5173`
- 本地已经启动后端：`http://localhost:3000`
- 使用 Chromium 内核浏览器，例如 Chrome

也就是先执行：

```bash
pnpm install
pnpm dev
```

### 安装插件

1. 打开扩展管理页：`chrome://extensions`
2. 打开右上角“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择目录：`apps/zentao-extension`

### 实际使用流程

1. 打开一个禅道 Bug 详情页
2. 点击页面右下角的 `AI提示词` 按钮
3. 插件会自动提取正文、图片和部分上下文信息
4. 插件会调用 TmpPrompt 接口创建文档
5. 生成完成后，可直接：
   - 点击“复制给 Codex”
   - 点击“编辑”继续整理内容

### 当前行为说明

- 插件会优先提取禅道正文内容和图片
- 生成的文档不再写入“禅道链接”，避免误导 Codex 认为自己可以访问原页面
- 复制给 Codex 的内容本质上是一段带 Raw 链接的提示词
- 当前默认连接本地地址，如需支持其他环境，可后续再补配置化

## PDF 导入说明

- 当前只支持非扫描件 PDF
- 当前优先支持单栏、简单文本 + 图片的需求文档
- 解析结果会直接变成普通文本块和图片块，插入当前编辑位置
- 暂不保证多栏排版、复杂表格、宣传页式 PDF 的图文顺序完全准确

## 当前限制

- 没有用户体系和多人协作能力
- 过期策略当前固定为 24 小时
- 可见性当前固定为公开列表
- 图片上传后统一压缩为 `jpg`
- 文本文件导入当前仅支持纯文本类文件，不包含 PDF 解析

## 协作约定

- 默认使用中文沟通。
- 文档、界面文案、开发说明和交付内容以中文优先。
- 只有在代码标识、协议字段、第三方接口或外部工具要求时保留必要英文。

更细的仓库协作规则请查看 `AGENTS.md`。
