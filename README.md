# PromptX

PromptX 是一个面向需求整理和 AI 协作的轻量工具。

它解决的事情很简单：先把文本、图片、PDF、禅道 Bug 等上下文整理成一个临时文档，再继续交给 Codex 或其他模型处理。

## 有什么能力

- 创建临时需求页，支持公开访问和 Raw 文本导出
- 编辑页支持输入文本、上传图片、导入 `md` / `txt` / `pdf`
- 文档自动保存，支持删除、继续编辑、公开详情查看
- 可直接把当前文档发送到本机 Codex session，并查看执行过程和回复
- 禅道扩展支持一键提取 Bug 内容，自动创建 PromptX 文档并打开编辑页
- 默认匿名使用，不需要登录

## 适合什么场景

- 把零散需求、截图、说明文档整理成一页
- 把 Bug、需求、上下文发给 Codex 继续修复或开发
- 临时给同事共享一个可编辑、可公开访问的上下文页

## 安装

```bash
git clone https://github.com/bravf/promptx.git
cd promptx
pnpm install
```

## 启动

```bash
pnpm dev
```

默认会启动：

- 前端：`http://localhost:5173`
- 后端：`http://localhost:3000`

如果你在局域网里给别人访问，启动时日志里也会打印可用的局域网地址。

## 怎么使用

### 方式 1：直接在网页里整理需求

1. 打开首页，新建一个文档
2. 在编辑页输入文本，或插入图片 / 文件
3. 需要公开分享时，打开详情页或使用 Raw 导出
4. 需要继续让 Codex 处理时，在编辑页手动选择一个 session，再点击发送

说明：

- 编辑页进入时不会默认选中 session，避免误发
- 如果没选 session 就发送，会弹窗提醒先选择

### 方式 2：从禅道 Bug 一键进入编辑页

仓库内置了禅道 Chrome 扩展：`apps/zentao-extension`

安装方法：

1. 打开 `chrome://extensions`
2. 开启“开发者模式”
3. 点击“加载已解压的扩展程序”
4. 选择 `apps/zentao-extension`

使用方法：

1. 保持 `pnpm dev` 已启动
2. 打开禅道 Bug 详情页
3. 点击右下角 `AI修复`
4. 扩展会提取页面内容，创建 PromptX 文档，并直接打开编辑页

## Codex 使用说明

PromptX 目前已经支持调用本机 Codex session。

你可以在编辑页里：

- 手动选择一个本机 session
- 把当前文档内容发送给 Codex
- 实时查看执行过程、计划、命令输出和最终回复
- 在同一页里继续整理上下文再发送下一轮

前提是你本机已经有可用的 Codex session。

## 项目结构

```text
apps/
  web/                Web 前端
  server/             Fastify 后端
  zentao-extension/   禅道 Chrome 扩展
packages/
  shared/             前后端共享常量与工具
```

## 常用命令

```bash
pnpm dev
pnpm build
```

## 当前数据位置

本地运行时会生成这些目录：

- `data/`
- `uploads/`
- `tmp/`

这些都不应该提交到 Git。

## 备注

- 默认中文优先
- 当前没有账号体系和多人协作
- 当前更偏向个人 / 小团队的临时上下文整理场景

更细的仓库约定见 `AGENTS.md`。
