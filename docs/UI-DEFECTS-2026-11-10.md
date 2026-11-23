# 界面样式错乱实证清单（2026-11-10）

> 结论先行：390px 下存在 7 类结构性破版，全部可归因到「主视图零断点 + 固定宽度子块」；1440px 下最严重的是项目卡片标题被压到 17px。其余问题集中在版式令牌缺失（6 种页面标题字号、两套页面内衬、8 档字号）。
> 本轮只做取证与方案，未修改任何业务代码。

## 1. 取证环境与方法

| 项 | 值 |
|---|---|
| 时间 | 2026-11-10 |
| 分支状态 | 工作区有未提交改动（另一会话正在修运行时崩溃），本报告基于当时快照 |
| 构建方式 | Vite dev server，`http://localhost:5199/`（未占用 1420，避免与 `tauri dev` 冲突） |
| 浏览器 | 本机 Google Chrome，`deviceScaleFactor: 1` |
| 视口 | 1440×900、1024×768、768×1024、390×844 |
| 路由 | `#/chat`（空态）、`#/chat`（会话态 2 轮）、`#/projects`、`#/projects/p-flow-b`、`#/inbox`、`#/settings`、`#/capabilities?tab=team`、`#/capabilities?tab=market`、`#/library`、`#/plugins`、`#/memory` |
| 截图产物 | `docs/ui-audit-2026-11-10/*.png`（44 张） |
| 原始指标 | `docs/ui-audit-2026-11-10/metrics.json` |

**数据注入说明（重要）**：纯浏览器预览没有 Tauri IPC，直接打开会是空壳，无法暴露真实排版。因此复用仓库既有的 `scripts/visual-check.mjs` 中的 `PI_STUB_SCRIPT` 桩（脚本运行时提取，未修改该文件），注入项目/插件/资料库等样例数据，并置 `__PI_SCRIPTED__=true` 让对话走脚本化回复。所有**几何测量**在注入后的真实 DOM 上进行；所有**举例文案**来自桩数据，不代表真实数据质量。

**测量口径**：
- 溢出 = 元素 `getBoundingClientRect().right > innerWidth + 1` 或 `left < -1`，且父元素在视口内（排除滚动容器内的正常溢出）。
- 裁切 = 含文本节点且 `scrollWidth > clientWidth + 1`，或 `scrollHeight > clientHeight + 1`。
- 命中区 = `button/a/[role=button]/input/select/textarea/[role=tab]` 的 `width < 24` 或 `height < 24`（WCAG 2.5.8 最小 24×24）。

**横向溢出计数（每视口）**：

| 路由 | 1440 | 1024 | 768 | 390 |
|---|---|---|---|---|
| chat 空态 | 0 | 0 | 1 | 1 |
| chat 会话态 | 0 | 0 | 1 | 1 |
| projects | 0 | 0 | 1 | 1 |
| project-workspace | 0 | 0 | 1 | 4 |
| inbox | 0 | 0 | 1 | 2 |
| settings | 0 | 0 | 1 | 3 |
| capabilities（team/market） | 0 | 0 | 1 | 2 |
| library | 0 | 0 | 1 | 6 |
| plugins | 0 | 0 | 1 | 1 |

> 768 起的「1」全部是同一个元素：折叠侧栏底部 `.foot` 左溢出 13px（D-07）。1024 以上清零，说明断点设计只在 ≥1024 成立。

**全局基线**：

| 指标 | 值 |
|---|---|
| Vue 文件 | 53 个，53 个含 `<style>` 块 |
| CSS 文件 / 行数 | 57 个 / 12,402 行 |
| 含 `@media` 的 CSS | 9 / 57（`layout`、`base`、`ChatHero`、`CollapsibleRow`、`TraceDrawer`、`MessageList`、`ExpertDraftEditor`、`SettingsView`、`ChatView`） |
| 硬编码 `font-size: Npx` | 347 处 |
| 硬编码字体栈（`PingFang SC`） | 7 处 |
| `border-radius` 取值 | 12 种：3/4/5/6/7/8/9/10/12/14/16/999px |
| 页面标题字号 | 6 种：38 / 27 / 22 / 20 / 19 / 18px |
| 空态页字号分布（chat 空态 1440） | 27/15/13.5/13/12.5/12/11/10px，其中 10px×3、11px×6 |

## 2. 缺陷分级定义

| 级别 | 判据 |
|---|---|
| P0 破版 | 元素宽度归零/溢出视口/内容不可读，功能入口不可达 |
| P1 间距与对齐 | 同级元素左缘/基线不一致 ≥4px，或同一语义间距存在多套值 |
| P2 层级与字体 | 同级标题字号不一致、正文/元信息低于 12px、命中区 <24px、圆角/边框无梯度 |
| P3 细节 | 视觉噪点、负 margin 补丁、文案与控件语义不符 |

## 3. 缺陷清单

### P0 — 破版 / 重叠 / 裁剪

#### D-01 项目卡片标题被压到 17px，只剩 1–2 个字
- 路由/视口：`#/projects`，1440（1024 仍截断）
- 现象：卡片标题显示为「产…」「pi-…」，副标题「未绑…」；卡片宽 267px，但标题容器只有 17px。
- 证据（1440）：`.wd-p-grid` 计算 4 列 × 267px（x=292，gap 16）；`.wd-p-card` 267×88；内部 `.wd-p-card-open` 仅 97px，扣掉 `padding: 18px 12px 18px 18px`（30px）、图标 38px、gap 12px 后，文本容器 = 17px；390 下卡片虽占满宽度，标题 `scrollWidth 98 / clientWidth 40`，副标题 `161 / 40`。1024 下卡片 342px，文本容器 92px，仍不足。
- 涉及样式：[ProjectsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L204-L208)（`minmax(245px, 1fr)`）、[ProjectsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L258-L268)（图标固定 38px）、[ProjectsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L280-L293)（open 内衬与 gap）、[ProjectsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L295-L313)（归档按钮常驻占位）。
- 判定：最小列宽 245px 未计入 3 个固定操作按钮 + 图标 + 内衬的合计宽度（约 235px），留给标题 ≤92px；4 列时直接塌到 17px。
- 截图：`projects-1440.png`、`projects-1024.png`、`projects-390.png`。

#### D-02 收件箱页头被挤成 27px 宽，标题断 5 行、描述断 12 行，操作区溢出 13px
- 路由/视口：`#/inbox`，390
- 现象：`收件箱` 三个字竖排成 5 行；描述每行 1 字；右侧两个按钮被切掉右边缘。
- 证据（390）：`.ib-head` = 258×379（x=100）；左侧文本容器 **27.2px 宽**，其中 `h1` 27.2×121.5（5 行）、`p` 27.2×253.5（12 行）；`.ib-head-actions` x=151.2、w=252，右缘 403.2 > 390（溢出 13.2px）。
- 涉及样式：[InboxView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/InboxView.css#L15-L21)（`display:flex` 无 `flex-wrap`）、[InboxView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/InboxView.css#L35-L40)（`flex-shrink: 0`）；该文件 0 条 `@media`。
- 判定：页头用「左文本 flex + 右操作 nowrap」且无断点，390 下剩余宽度 27px。
- 截图：`inbox-390.png`。

#### D-03 资料库预览面板在 390 下坍缩为 2px
- 路由/视口：`#/library`，390
- 现象：文件树占满宽度，右侧预览区不可见；预览内容（图标 40px、标题、说明）被挤到 40px 宽并溢出面板。
- 证据（390）：`.lib-tree` 固定 280px（`flex-shrink: 0`）；`.lib-preview` 实测 **w=2px**；其子元素 x=385、w=40，右缘 425 > 390；页面主区宽 302px。
- 涉及样式：[LibraryPanel.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/panels/LibraryPanel.css#L151-L160)（280px 固定）、[LibraryPanel.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/panels/LibraryPanel.css#L225-L234)（`flex:1; min-width:0`）；该文件 0 条 `@media`。
- 判定：固定 280 + 内衬 40 + 边框/gap 后，主区 302px 无法容纳第二列。
- 截图：`library-390.png`。

#### D-04 项目工作台标题宽度归零，标题与路径不可读
- 路由/视口：`#/projects/p-flow-b`，390
- 现象：标题「pi-workbench」缺失，只剩模式选择与「在对话中打开」；路径 chip 截断且无省略号为可读文本。
- 证据（390）：`.pw-head` 内容宽 266px；固定子项 = 返回 17 + 图标 20 + 模式选择 73 + 「在对话中打开」128 + 4×gap12=48 → 286 > 266；`.pw-title` 计算宽 **0px**；`.pw-chip-path` `scrollWidth 314 / clientWidth 264`；`.pw-tabs` 第 3/4/5 个 tab 右缘 447/505/576，全部越界。
- 涉及样式：[ProjectWorkspace.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectWorkspace.css#L13-L23)（nowrap 页头）、[ProjectWorkspace.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectWorkspace.css#L84-L87)（`flex:1; min-width:0`）、[ProjectWorkspace.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectWorkspace.css#L104-L115)（固定按钮）、[ProjectWorkspace.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectWorkspace.css#L181-L185)（tabs 无换行/滚动）；该文件 0 条 `@media`。
- 截图：`project-workspace-390.png`。

#### D-05 能力中心 tab 条固定 511px，390 下硬裁 209px
- 路由/视口：`#/capabilities?tab=team`、`?tab=market`，390
- 现象：`专家/技能/连接器/团队/市场/浏览器` 只露出前 3 个半，右侧无滚动提示。
- 证据（390）：`.market-tabs` x=88、w=511、右缘 599（视口 390）。无 `overflow-x`、无 `flex-wrap`。
- 涉及样式：[CapabilitiesView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/CapabilitiesView.css#L23-L30)（整条 tab 容器）。
- 截图：`capabilities-team-390.png`、`capabilities-market-390.png`。

#### D-06 资料库工具栏 / tab 条横向溢出
- 路由/视口：`#/library`，390
- 现象：工具栏最右侧按钮被切掉；`资料/检索/标签…` tab 尾部越界。
- 证据（390）：`.lib-tabs` x=88 w=382（右缘 470）；`.lib-tools` x=88 w=404（右缘 492）。
- 涉及样式：[LibraryPanel.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/panels/LibraryPanel.css#L43-L96)（`.lib-toolbar` / `.lib-tabs` / `.lib-tools`）。
- 截图：`library-390.png`。

#### D-07 折叠侧栏底部溢出左边界 13px
- 路由/视口：全部路由，768 / 390
- 现象：主题切换与设置按钮压出侧栏左缘，被裁掉一角。
- 证据：`.sidebar.collapsed` 宽 68；`.foot` x=**-13**、w=93（父容器内衬 8px）；`.foot-actions` 不换行，`theme-toggle` 有 `flex:1` 但最小内容宽 60+，加上设置按钮 29 + gap 8 → 93。
- 涉及样式：[Sidebar.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/layout/Sidebar.css#L422-L435)。
- 判定：折叠态没有为 footer 提供纵向堆叠或图标化方案。
- 截图：`chat-hero-768.png`、`library-390.png`（左下角）。

#### D-08 窄屏会话头部胶囊折成两行，圆角包住两排控件
- 路由/视口：`#/chat`（会话态），390
- 现象：顶部出现「胶囊内两行」：第一行项目名被截成 `pi-workb…`，第二行是「标准」「自动」等；整个胶囊高约 70px，圆角 999px 包住两排，视觉上像一个鼓包。
- 证据：截图 `chat-conversation-390.png`；`.header-pill` 在 640 断点被显式允许 `flex-wrap: wrap`，而容器仍是 `border-radius: var(--r-full)`。
- 涉及样式：[ChatView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ChatView.css#L235-L250)（640 断点内给 pill 加 wrap）、[ChatView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ChatView.css#L103-L118)（胶囊圆角与内衬）。
- 判定：换行策略与容器形状冲突；应改为「胶囊单行 + 控制组独立一行」或把次要选择器收进溢出菜单。

#### D-09 会话头部工作区名被裁到 42px
- 路由/视口：`#/chat`（会话态），1440 / 1024
- 现象：`pi-workbench` 显示为 `pi-w…`，同一行其他选择器（角色/模型）却保留完整标签。
- 证据（1440）：`.ws-label` `scrollWidth 85 / clientWidth 42`，高度 15px（单行未换行）；同排 `.chat-controls` 固定 344px 宽且 `flex-shrink:0`。
- 涉及样式：[ChatView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ChatView.css#L142-L148)（省略号规则）、[ChatView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ChatView.css#L151-L157)（控制组不收缩）、[ChatView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ChatView.css#L166-L177)（角色/模型 min-width 72/56）。
- 判定：工作区名的可用宽度被后置的 min-width 选择器挤占；1440 下不应发生。

### P1 — 间距与对齐不一致

#### D-10 页面左内衬三套：292 / 300 / 370px
- 路由/视口：全路由，1440
- 证据（h1 左缘）：projects 292、inbox 292、library 300、capabilities 300、plugins **370**、settings 页头在 20px+ 卡内（`settings-header` padding 24px）。
- 涉及样式：[ProjectsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L44-L51)（hero padding 20px，外层 32px）、[InboxView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/InboxView.css#L6-L13)（`--sp-7` = 32px）、[CapabilitiesView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/CapabilitiesView.css#L3-L11)（`24px clamp(20px,3vw,40px)`）、[PluginsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/PluginsView.css#L3-L11)（同 40px，但标题嵌在 hero 卡内再加 70px）、[SettingsView.css](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/SettingsView.css#L47-L52)。
- 判定：同级页面标题左缘最大偏差 78px（292 vs 370），远超 4px 容差。

#### D-11 页面标题 6 种字号，层级不成立
- 证据：projects `38px`（[ProjectsView.css:53-57](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectsView.css#L53-L57)）、inbox `27px`（[InboxView.css:23-27](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/InboxView.css#L23-L27)）、library `22px`、plugins `22px`（[PluginsView.css:56-60](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/PluginsView.css#L56-L60)）、settings `20px`（[SettingsView.css:54-58](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/SettingsView.css#L54-L58)）、capabilities `18px`（复用 `--fs-xl`）。
- 判定：最大/最小差 2.1 倍；同为一级页面却视觉上像两个层级。设计令牌里只有 `--fs-2xl: 27px` 一档大标题（[base.css:49-55](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/styles/base.css#L49-L55)），其余为硬编码。

#### D-12 基础字号 13 / 14 混用，字体栈硬编码 7 处
- 证据：`base.css` `--fs-base: 13px`；`CapabilitiesView.css`、`ProjectWorkspace.css`、`PluginsView.css` 各自硬编码 `font: 14px/1.5 'PingFang SC', 'Microsoft YaHei', sans-serif`。
- 影响：同屏切换路由时正文尺寸跳变 1px，行高基准变化，长文阅读密度不一致。
- 涉及：[CapabilitiesView.css:7-11](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/CapabilitiesView.css#L7-L11)、[ProjectWorkspace.css:4-11](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/ProjectWorkspace.css#L4-L11)、[PluginsView.css:3-11](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/PluginsView.css#L3-L11)。

#### D-13 设置页 390 分区 tab 溢出 185px，末两项不可见
- 证据（390）：`.settings-tabs` 可视宽 322，最后两项右缘 494.5 / 575.5；`overflow-x` 可滚动但无渐隐/箭头提示，截图上表现为直接切断。
- 涉及：[SettingsView.css:66-101](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/SettingsView.css#L66-L101)、[SettingsView.css:478](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/SettingsView.css#L478)（640 断点改为横向）。
- 截图：`settings-390.png`。

#### D-14 收件箱错误条直接输出英文异常
- 证据：`#/inbox` 顶部满宽红条文案 `TypeError: Cannot read properties of null (reading 'unread')`，12px。
- 涉及：[InboxView.css:83](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/InboxView.css#L83)（`.ib-error`）。
- 判定：与「用户友好中文优先、禁止技术日志直出」的产品约束冲突；原始异常应折叠进详情。
- 截图：`inbox-1440.png`、`inbox-390.png`。

### P2 — 层级 / 字体 / 可访问性

#### D-15 元信息字号 10–11px，低于可读下限
- 证据（chat 空态 1440）：字号分布 27/15/13.5/13/12.5/12/11/10；10px 出现 3 次、11px 出现 6 次。会话态用量行 `0 步 · $0` 为 11px，且横向占满 678px（近似一条分隔线）。
- 涉及：`--fs-xs: 11px`（[base.css:49](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/styles/base.css#L49)）、`LibraryPanel.css` `.tree-badge` 10px、`MessageList.css` 用量行。

#### D-16 命中区小于 24×24（WCAG 2.5.8）
- 证据：1440 每个路由 7 个；会话态 11 个。具体：侧栏工作区操作按钮 22×22（3 个）、列表项内按钮 20×20、激活项内按钮 16×16；390 下「新对话」17×37。
- 涉及：`Sidebar.css` 折叠/紧凑按钮、`Sidebar.vue` 工作区操作组、`ChatView.css` 顶栏图标按钮（`.chat-controls` 内 28px 容器但实际图标按钮可被压到 22px）。

#### D-17 圆角 12 种取值，卡片/面板无统一梯度
- 证据：8px×23、9px×20、6px×17、10px×17、12px×11、4px×10、7px×8、3px×8、999px×7、14px×5、16px×3、5px×2。
- 判定：同层级卡片出现 6/8/10/12/14px 五种圆角；按钮 8/9/10px 混用。

#### D-18 资料库空态三行间距 203px（应为 8px）
- 证据（1440，`.lib-preview.empty` 804×685.5）：图标 y=289.1（h=40），标题 y=532.2，说明 y=756.4 → 相邻间距 **203.1 / 203.2px**，而 CSS 写的是 `gap: 8px`。
- 原因：`display:grid; place-items:center; gap:8px` 未约束隐式行高，三行自动行各占 1/3 高度并各自居中。
- 涉及：[LibraryPanel.css:236-242](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/panels/LibraryPanel.css#L236-L242)、结构见 `LibraryPanel.vue:689-693`。
- 判定：同一空态组件内部自相矛盾，视觉上像三段互不相关的提示。

#### D-19 插件行描述被裁成 73px 宽、3 行内容塞进 2 行高度
- 证据（390）：`.row-desc` `scrollWidth 73 / clientWidth 73`、`scrollHeight 121 / clientHeight 40`——宽度被右侧徽标与按钮挤到 73px，`-webkit-line-clamp: 2` 之外的内容直接消失，且单词被硬断。
- 涉及：[PluginsView.css:307-345](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/views/PluginsView.css#L307-L345)（`row-body` / `row-desc`）、右侧 `.row-actions` / `.row-tools` 固定宽度。
- 截图：`plugins-390.png`。

### P3 — 细节

#### D-20 侧栏用量卡用负 margin 对齐，左缘比内衬少 6px
- 证据：`.usage-card` `margin: -4px -6px 4px`，实测 x=6，而 `.foot` 内衬 12px（[UsageCard.css:1-13](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/layout/UsageCard.css#L1-L13)）。
- 判定：视觉上略偏左，属补丁式对齐，令牌化时应删掉。

#### D-21 侧栏搜索按钮是「假入口」
- 证据：图标按钮 tooltip「搜索项目（在项目页）」，点击直接 `router.push('/projects')`（[Sidebar.vue:293-295](file:///Users/tatsuma/Documents/GIT/pi-workbench/src/components/layout/Sidebar.vue#L293-L295)）。
- 判定：与成熟客户端的全局搜索预期不符（见对标报告第 5 节），本轮先记录，批次 C 处理。

#### D-22 页面标题区块结构不统一
- `#/projects`：hero 208px 高 + 大插图 + 38px 标题；`#/library`：标题下直接配额条；`#/capabilities`：tab 条在标题之上；`#/plugins`：标题嵌在 hero 卡内。
- 判定：同一 App 出现 4 种页头范式，导致 D-10 的 78px 偏差。

## 4. 排除项与已知限制

| 项 | 说明 |
|---|---|
| `#/memory` | 该路径未注册路由，实际渲染 `NotFoundView`（`memory-1440.png`）。记忆入口在 `#/library?view=memory`。属路由信息架构问题，不计入样式缺陷。 |
| 运行时异常 | 会话态出现 `t2 is not a function`；capabilities 两个 tab 出现 `Cannot read properties of null (reading 'length')`。由另一会话负责修复，本报告不计入样式缺陷，仅记录为观察。 |
| 数据内容 | 截图内项目名、插件描述等来自测试桩，仅用于暴露排版；不作为数据层问题。 |
| 原生窗口 | 截图仅覆盖 webview 内容区，未包含 Tauri 标题栏/红绿灯按钮，macOS 原生 chrome 未审。 |
| 深色模式 | 本轮只截浅色；深色对比度未测量（**未核实**）。 |
| 动画 | 未测量过渡时长与 `prefers-reduced-motion` 覆盖范围（仅 `base.css:290` 一处声明）。 |

## 5. 整改方案（4 批）

> 原则：先「不破版」再「统一」再「补能力」。每批可独立提交、独立验收；批次边界避免与另一会话的运行时修复冲突（本方案只动样式与布局组件）。

### 批次 A：响应式闭环（P0，D-01～D-09）

| 项 | 内容 |
|---|---|
| 涉及文件 | `src/styles/layout.css`、`ProjectsView.css`、`InboxView.css`、`LibraryPanel.css`、`ProjectWorkspace.css`、`CapabilitiesView.css`、`Sidebar.css`、`ChatView.css` |
| 改动要点 | ① 在 `layout.css` 定义三档断点契约（≥1200 / 640–1199 / <640）与「主区最小可用宽 240px」；② 项目卡片 `minmax(245px → 320px)`，归档/删除收进溢出菜单（hover/focus 才出现），标题最小宽 120px；③ 收件箱页头 `flex-wrap: wrap`，操作组在 <640 独占一行；④ 资料库 <900 单栏（树 → 选中后进预览，带返回），预览 `min-width: 240px`；⑤ 工作台页头允许换行、`.pw-title` 给 `min-width: 96px`，tabs 横向滚动；⑥ 能力中心 tab 容器 `overflow-x:auto` + 两侧渐隐；⑦ 折叠侧栏 footer 改纵向堆叠；⑧ 会话头部 640 断点取消 pill 内换行，控制组独立一行。 |
| 验收判据 | 四个视口 × 11 路由，`documentElement.scrollWidth === innerWidth`（容差 0）；390 下项目卡标题 `clientWidth ≥ 120`、工作台标题 `≥ 96`、资料库预览 `≥ 240`（或单栏模式）；能力中心 tab 可滚动到最后一个且无元素 `right > innerWidth`；`.foot` 的 `left ≥ 0`；所有 h1 可读（`scrollWidth ≤ clientWidth`）。 |
| 借鉴 | Open WebUI 响应式工作区（v0.11.0 界面重组）；Chatbox 侧栏折叠与会话列表分组（1.24）。 |

### 批次 B：版式令牌与页头骨架统一（P1，D-10～D-13、D-22）

| 项 | 内容 |
|---|---|
| 涉及文件 | `src/styles/base.css`、`src/components/layout/PageHeader.vue`（新增）、6 个视图 CSS |
| 改动要点 | ① 新增令牌 `--page-pad-x: 32px`、`--page-pad-y: 24px`、`--title-page: 27px/600`、`--r-card: 12px`、`--r-control: 9px`、`--r-chip: 999px`；② 抽 `PageHeader`（标题/描述/右侧操作/可选 tab 槽），projects、inbox、library、plugins、settings、capabilities 全部换用；③ 删除 3 处 `font: 14px/1.5 'PingFang SC'` 硬编码，统一 `--fs-base`；④ 圆角收敛到 4 档（6/9/12/999），替换其余 8 种。 |
| 验收判据 | 1440 下六个页面 h1 左缘均为 292px（±0）；h1 `font-size` 均为 27px、`font-weight` 600；正文 13px；`PingFang` 硬编码 7 → 0；`border-radius` 取值 12 → 4 种；页头高度差 ≤4px。 |
| 借鉴 | Chatbox 1.24 设置页重组；Open WebUI 文件夹描述层级（v0.12.4）。 |

### 批次 C：会话列表 + 全局搜索 + ⌘K（能力的结构性补齐）

| 项 | 内容 |
|---|---|
| 涉及文件 | `Sidebar.vue/.css`、新增 `src/components/layout/CommandPalette.vue/.css`、新增 `src/composables/useGlobalKeys.ts`、`router/index.ts`（如需会话路由） |
| 改动要点 | ① 侧栏增加「最近会话」列表（分组 + 空查询给最近项）；② `⌘K / Ctrl+K` 打开命令面板，检索会话/项目/设置/动作，↑↓ 选择、Enter 进入、Esc 关闭并归焦；③ 删除假搜索按钮或改为真正打开面板；④ 面板 <640 全宽、命中区 ≥32px。 |
| 验收判据 | `⌘K` 打开到首帧 ≤100ms（DevTools Performance）；Esc 后焦点回到触发元素；键盘可完成「搜索→进入会话」全流程，无需鼠标；390 下面板不溢出；`aria-modal` / `role=listbox` / `aria-activedescendant` 齐备。 |
| 借鉴 | Lobe Chat Command Menu（⌘K 检索 Agent/话题/设置/动作）；LibreChat Message Search；Open WebUI Cmd+K 分层搜索。 |

### 批次 D：状态规范（骨架 / 空态 / 错误 / 密度）

| 项 | 内容 |
|---|---|
| 涉及文件 | 新增 `src/components/ui/AppSkeleton.vue/.css`、`AppEmptyState.vue/.css`；`LibraryPanel.css`、`InboxView.css/.vue`、`MessageList.css` |
| 改动要点 | ① 空态统一为「图标 40 + 标题 + 说明」三段，`align-content:center`，间距 8px，总高 ≤160px；② 首次加载 300ms 后显示骨架（列表 3 行 / 卡片 4 块 / 树 6 行）；③ 错误条改为中文摘要 + 「查看详情」折叠原始异常；④ 工具行与用量行字号 ≥12px，密度提供紧凑/标准两档（令牌 `--row-dense`）。 |
| 验收判据 | 资料库空态三段间距 8px（±1）、总高 ≤160px；加载态 300ms 内出现骨架且无布局跳动（CLS ≤0.02）；错误条默认不出现英文栈，展开后可见原文；所有元信息 `font-size ≥ 12px`；命中区 ≥24px。 |
| 借鉴 | Lobe Chat Skeleton、Cline 审批与检查点分层、AnythingLLM 引用回链。 |

**批次顺序理由**：A 修「不可用」，B 修「不一致」，C/D 补「不成熟」。A、B 只改 CSS 与布局外壳，可与另一会话的运行时修复并行；C、D 涉及新组件，需在运行时修复合并后开始。
