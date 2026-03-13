# PromptX ZenTao Extension

一个最小可用的 Chrome Manifest V3 插件：在禅道 Bug 详情页右下角插入“AI修复”按钮，一键把当前页面的关键信息整理成 `promptx` 文档并打开编辑页。

## 当前能力

- 识别常见的禅道 Bug 详情页 URL
- 支持在 iframe 内识别禅道 Bug 详情正文
- 提取正文文本并转成普通文本块
- 抓取正文图片并转存到 `promptx` 自己的上传服务
- 调用 `promptx` 接口自动创建文档
- 生成后直接打开 PromptX 编辑页

## 使用方式

1. 打开 Chrome 扩展管理页：`chrome://extensions`
2. 打开“开发者模式”
3. 选择“加载已解压的扩展程序”
4. 选择当前目录：`apps/zentao-extension`
5. 打开禅道 Bug 详情页，点击右下角“AI修复”

## 说明

- 当前默认页面地址固定为 `http://localhost:5173`
- 当前默认 API 地址固定为 `http://localhost:3000`
- 当前版本优先处理正文内容，评论区后续可继续补强
