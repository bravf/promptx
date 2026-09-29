# tweakcn 配色适配

新增林间苔色（Kodama Grove）、海风（Ocean Breeze）、雅致酒红（Elegant Luxury）、咖啡（Caffeine）、北极光（Northern Lights），各包含浅色和深色，共 10 个主题，桌面和手机均可使用。

## 来源

原配色来自 [tweakcn 的主题预设](https://github.com/jnsahaj/tweakcn/blob/a3b47b37cba97dd637de517aab52c45ec0f83456/utils/theme-presets.ts)，按 Apache-2.0 使用，许可证保留于 [licenses/tweakcn.txt](licenses/tweakcn.txt)。项目作者为 jnsahaj 及 tweakcn 贡献者。

## PromptX 的适配

- 保留原配色的背景、主色和辅助色方向，映射到 PromptX 的面板、标签、提示词、执行过程、代码及弹层语义 token。
- 加深浅色主按钮和部分辅助文字，提高小字号阅读对比度；酒红深色主题单独使用较亮的标签强调色。
- 保持错误红、成功绿、警告黄、信息蓝的业务语义，Diff 增删保持红绿区分。
- 使用现有字体、布局圆角 0.5rem 和表单圆角 4px；不加载远程字体、图片、主题接口或额外渲染库。
- 配色统一定义于 `apps/web/src/lib/themes.js`。公共映射补齐所有业务色，避免针对单个主题添加组件 CSS 分支。
- 切换主题时清理目标主题未定义的内联 token，使渐变、字体和图标色回到样式表默认值。

## 验证

- `pnpm build` 通过。
- 浏览器定向回归 3 项通过：新增主题、桌面完整流程、移动端布局和 History。新增主题用例逐个验证 10 个主题的桌面与手机切换、刷新恢复和无横向溢出，并检查新旧主题 token 不串色。
- 已查看各主题的设置、Timeline、输入框和 Diff 截图；200 组主要文字/背景 token 对比度均达到 4.5:1（最低 4.51:1）。这不代表覆盖每一种透明叠加、禁用状态或代码语法颜色。
- 复测命令：`pnpm --filter @promptx/web exec node --test --test-name-pattern='新增配色|V2 全面桌面|V2 移动端布局' e2e/v2-regression.e2e.js`。可设置 `PROMPTX_REGRESSION_SCREENSHOT_DIR` 保存截图。
