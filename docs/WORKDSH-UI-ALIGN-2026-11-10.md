# WorkDSH UI 1:1 对齐方案（2026-11-10）

## 0. 核实结论（先读）

| 项 | 结论 |
|---|---|
| 仓库 | `github.com/techflag/workdsh`，公开，默认分支 `main`，HEAD `e94c99d`（2026-10-31） |
| 体积 | 浅克隆 1647 文件 / 117 MB |
| 技术栈 | TypeScript；Electron 桌面 + Web；React 19；Cordis 插件化（`packages/plugins/*`）；yarn 4 |
| 样式方式 | 组件内 `<style>` 字符串（模板字符串导出 CSS），**无独立 .css 文件**；业务插件另有 `client/styles.ts` |
| 关键限制 | **应用外壳不在仓库里**：侧栏/主区/会话/composer 来自 npm 包 `@deepseek-ai/dsh-client-ui-*`（primitives、layout、sidebar、conversation、workspace、slots）。仓库只提供插件面板、`packages/ui` 的令牌与侧栏 CSS 文本、以及 `workdsh-ui` 组件封装 |
| 可 1:1 的范围 | ① 色板/圆角/字号令牌（`packages/ui/src/styles/tokens.ts`）；② 侧栏（`navigation.ts` 内含完整 `.wd-sidebar` CSS）；③ 表单/按钮（`controls.ts`）；④ 弹窗（`modal.ts`）；⑤ 项目页（`plugins/projects/src/client/styles.ts` 第 104–130 行是最终版覆盖）；⑥ 资料库/专家等插件面板样式 |
| 不可 1:1 的范围 | 官方外壳的会话流、composer、消息渲染、模型选择器（外部包，无源码）。这部分按 `navigation.ts`/`controls.ts` 的规格与官方截图对齐，不臆造 |
| 与本项目关系 | 本项目已沿用同一套 `wd-p-*` / `lib-*` 类名，是移植后样式漂移：类名相同、数值不同。因此多数修复是「按参考值回填」，不是重设计 |

参考证据文件（本地浅克隆 `/tmp/workdsh-ref`，可随时重新克隆）：
`packages/ui/src/styles/tokens.ts`、`navigation.ts`、`controls.ts`、`modal.ts`、`packages/plugins/projects/src/client/styles.ts`、`ProjectsPanel.tsx`。

## 1. 参考规格（可直接当作设计事实源）

### 1.1 色板（tokens.ts）

| 角色 | 参考值 | 本项目现值 | 动作 |
|---|---|---|---|
| canvas | `#121212` | `#0b0c0f` | 替换 |
| sidebar | `#202020` | `#141519`（panel） | 替换 |
| card | `#242424` | `#1b1d23`（elev） | 替换 |
| selected | `#3a3a3a` | `#2a2d35`（active） | 替换 |
| border | `#343434` | `#26282f` | 替换 |
| text | `#e7e7e7` | `#f0f1f5` | 替换 |
| secondary | `#a5a5a5` | `#9ba2ad` | 替换 |
| primary 按钮 | `#2563eb`，hover `#2f6fee`，边框 `#3b82f6` | `#4f8cff` | 替换 |

### 1.2 侧栏（navigation.ts，逐类）

| 元素 | 参考值 |
|---|---|
| `.wd-sidebar` | 背景 `#202020`；字 `14px/22px "PingFang SC","Microsoft YaHei"`；右边框 1px `#343434`；纵向 flex；`overflow:hidden` |
| `.wd-top-tools` | 高 46；右对齐；padding `0 14px`；gap 8 |
| `.wd-icon-button` | 32×32；圆角 6；颜色 `#aaa`；透明底 |
| `.wd-brand-row` | 高 48；padding `0 20px`；`margin-bottom:20px`；标题 18px/600 |
| `.wd-main-nav` | padding `0 10px` |
| `.wd-nav-item` | 高 36；圆角 8；padding `6px 8px`；gap 4；`margin-bottom:2px`；激活底 `#3a3a3a`、字重 500；`small` 10px `#a5a5a5` 靠右 |
| `.wd-icon-slot` | 宽 26；颜色 `#b9b9b9` |
| `.wd-list-scroll` | `flex:1`；padding `0 10px 20px`；`scrollbar-width:thin` |
| `.wd-nav-group` | `margin-top:26px`；summary 12px `#a5a5a5`，padding `0 10px 12px`；收起时箭头 -90° |
| `.wd-task-row` | 高 36；圆角 6；padding `8px 10px`；gap 8；单行省略；激活底 `#343434` |
| `.wd-filter input` | 背景 `#292929`；边框 1px `#454545`；圆角 6；padding `6px 8px` |
| `.wd-footer` | padding `12px 10px` |
| 折叠态 `.is-collapsed` | top-tools 居中、padding 0；main-nav padding `0 8px`；footer padding 8；nav-item 居中 padding 6；icon-slot 宽 auto |
| `@media(max-width:560px)` | nav-item / task-row / icon-button `min-height:44px`；brand-row margin-bottom 8；main-nav padding `0 6px` |

### 1.3 控件（controls.ts）

- 按钮：高 36（`sm` 28），`white-space:nowrap`，`flex-shrink:0`，圆角 9，padding `9px 16px`。
- 输入：高 36；字号 14/20；圆角 8；`--dsw-alias-bg-layer-1` 底。
- textarea：`min-height:100px`；padding `10px 12px`；可纵向拉伸。
- 焦点：`outline:2px solid brand; outline-offset:2px`。

### 1.4 弹窗（modal.ts）

- 遮罩：`fixed inset 0`，`place-items:center`，padding 24，`bg-mask-2`。
- 对话框：`width:min(720px,100vw-48px)`；`max-height:calc(100dvh - 48px)`；圆角 16；`animation .16s`；`prefers-reduced-motion` 关闭。
- 关闭按钮 32×32，圆角 6；`@media(max-width:640px)` 变 44×44，对话框圆角 12，遮罩 padding 12。
- 设置弹窗：`min(560px, 100vw-32px)`，圆角 20，背景 `#202020`；header padding `28px 30px 18px`；h2 `24px/32px`；分组列表边框 `#3b3b3b`、圆角 12、行 padding 16、行间 1px `#383838`。

### 1.5 项目页最终版（projects styles.ts 第 104–130 行）

| 元素 | 参考值 | 本项目现值 |
|---|---|---|
| `.wd-p-center` | `max-width:1600px; margin:0 auto; padding:48px 32px 64px` | padding 32，无 max-width |
| `.wd-p-hero` | `min-height:208px; padding:20px 0 36px; border:0; background:none; gap:40px` | 208px 高但带边框/渐变/圆角，padding 20 42 |
| hero h1 | `26px/1.3/650; margin:0 0 10px` | `38px` |
| hero p | `14px/1.7; margin-bottom:22px; label-secondary` | `17px` |
| hero-art | 340px 宽，三节点 68px / 中心 90px，圆角 18/24，旋转 -7°/5°，虚线连接 34px | 已实现但尺寸不同 |
| section-head | `margin:28px 0 14px; gap:16px`；h2 `16px/600` | 34/15，h2 未定 |
| grid | `repeat(auto-fill,minmax(245px,1fr)); gap:16px` | 同 245/16（但卡片动作多导致标题塌陷） |
| card | `min-height:88px; padding:16px; radius 12` | 88 高、padding 不同 |
| card-open | `padding:18px 12px 18px 18px; gap:12px` | 同左 |
| card-icon | 38×38，radius 10 | 38×38 |
| card strong | `14px/600`，`min-width:0; flex:1`，单行省略 | 14px 但容器 `flex:1` 被 3 个操作按钮挤爆 |
| card small | `12px/20`，单行省略，label-secondary | 12px |
| card-menu | 单一「归档」按钮，`align-self:center; margin:0 8px 0 0; font-size:12px; padding:6px; flex-shrink:0` | 归档 + 对话 + 删除三个固定占位 |
| 容器 `@container(max-width:720px)` | padding `24px 20px 40px`；隐藏 hero-art；section-head 换行；筛选独占整行；grid `minmax(220px,1fr)` | 无容器查询 |
| 容器 `@container(max-width:420px)` | grid 单列；padding `20px 16px 32px` | 无 |

**D-01 的直接结论**：参考实现只保留一个归档按钮，且 `strong` 有 `min-width:0;flex:1`。本项目在卡片里塞了归档/对话/删除三个固定宽度按钮（`ProjectsView.css:258-313`），把 267px 卡片中的文本挤到 17px。对齐 = 收成一个溢出菜单，按参考的 12px/600 单行省略规则渲染标题。

### 1.6 资料库（projects styles.ts 内嵌 + 插件列表）

- 列表：`grid-template-columns:1fr 1fr; gap:10px`，`@media(max-width:760px)` 单列。
- 行：`min-height:72px; padding:12px; radius 11; border 1px`；标题/副标题均单行省略；`em` 右侧说明 12px。
- 工具条：flex + wrap；输入 `min-width:220px`；select/input 圆角 9、padding `9px 11px`。
- 面包屑：gap 7；链接 `#9bbcf2`。
- 空态：`min-height:250px; place-items:center`。

### 1.7 弹窗内选择器

- 双列卡片 `1fr 1fr`，gap 14；卡片 `min-height:96px; padding:15px; radius 12`；选中边框 brand + 10% 背景混合。
- `@media(max-width:1050px)` 单列；`@container(max-width:900px)` 也单列。
- 加载态：`min-height:260px; place-items:center`。

## 2. 三方差异表（它 / 我们 / 差在哪 / 改哪些文件）

| # | 能力 | WorkDSH 做法 | 本项目做法 | 差异 | 改动文件 |
|---|---|---|---|---|---|
| 1 | 色板 | 7 个固定令牌，`#121212` 系 | 自建 30+ 变量，`#0b0c0f` 系 | 整体偏冷偏深，卡片层级对比弱 | `src/styles/base.css` |
| 2 | 侧栏结构 | 46 工具栏 / 48 品牌 / 36 导航 / 26 图标槽 / 10px 内衬 | 260px 宽，行高与内衬不同；折叠态 footer 溢出 13px | 尺寸与折叠策略不一致 | `Sidebar.css`、`Sidebar.vue` |
| 3 | 页面标题 | 项目页 26px/650；面板内 h2 16px/600 | 38/27/22/20/19/18 六种 | 无层级体系 | 6 个视图 CSS + `base.css` |
| 4 | 页头内衬 | `48px 32px 64px`，max 1600 居中 | 32 或 `clamp(20,3vw,40)` | 左缘 292 vs 300 vs 370 | `ProjectsView.css` 等 |
| 5 | 项目卡片 | 单归档菜单 + 标题 `flex:1;min-width:0` | 三个固定按钮 + 无 `min-width` | 标题 17px，内容不可读 | `ProjectsView.vue/.css` |
| 6 | 响应式 | `@container` 900/720/420 + `@media` 1050/760/600/560 | 57 个 CSS 仅 9 个有断点 | 390 全面破版 | 全部主视图 CSS |
| 7 | 按钮 | 36px 高、圆角 9、primary `#2563eb` | `AppButton` 变体，高度/色值不同 | 视觉不统一 | `AppButton.css` |
| 8 | 设置 | 560px 弹窗 + 分组卡片 + 行级说明 | 整页 5 个平铺 tab | 信息架构与密度不同 | `SettingsView.vue/.css` |
| 9 | 资料库 | 双列卡片列表 + 面包屑 + 上传 | 左树 280 + 右预览 | 结构不同；390 预览坍缩 2px | `LibraryPanel.vue/.css` |
| 10 | 空态 | `min-height:250px` 居中单段 | 手写，资料库空态三行间距 203px | 无统一组件 | `LibraryPanel.css` + 新组件 |
| 11 | 焦点可达 | `:focus-visible` 2px 全站；560px 下 44px 命中区 | 局部方向键，命中区 16–22px | 可访问性不足 | 全局 CSS |
| 12 | 消息/会话外壳 | 外部官方包（无源码） | 自研 `MessageList`/`ChatView` | **不可 1:1**，只能按规格贴近 | 仅对齐字号/间距/聚焦 |

## 3. 批次计划（每批可运行、可量测）

### 批次 A：令牌 + 侧栏 + 项目页（根问题优先）

- 文件：`src/styles/base.css`、`src/components/layout/Sidebar.css`、`Sidebar.vue`、`ProjectsView.css/.vue`、`AppButton.css`。
- 要点：① 色板替换为 tokens.ts 7 值 + primary `#2563eb`；② 侧栏按 navigation.ts 全套数值回填，折叠态改纵向图标栏、footer 单列；③ 项目页按 styles.ts 104–130 回填；卡片三按钮收为一个菜单；④ 断点按 `@container 720/420` + `@media 1050/760/560`。
- 验收：1440 下 h1 = 26px/650、卡片标题容器 ≥120px、页面左缘 32px、侧栏导航行高 36px；390 下 `scrollWidth === innerWidth`、卡片单列、标题容器 ≥120px、footer 无负坐标。

### 批次 B：资料库 + 能力中心

- 文件：`LibraryPanel.vue/.css`、`CapabilitiesView.vue/.css`、`ExpertsPanel`/`SkillPanel`/`ConnectorPanel` 对应 CSS。
- 要点：资料库 760px 以下单列、工具条 wrap、空态单段 8px 间距；能力卡片双列 → 1050 单列；tab 条横向滚动。
- 验收：390 无横向溢出；空态三段间距 8±1px；卡片点击区 ≥44px（<560）。

### 批次 C：设置 + 收件箱 + 插件

- 文件：`SettingsView.vue/.css`、`InboxView.css/.vue`、`PluginsView.css/.vue`。
- 要点：设置改为 560px 分组卡范式（页内或弹窗二选一，保持现有路由）；收件箱页头 wrap；插件行描述换行/收进详情。
- 验收：390 页头高度 ≤160px、标题不换行超过 1 行；错误条中文摘要。

### 批次 D：会话与工作台

- 文件：`ChatView.css`、`MessageList.css`、`ProjectWorkspace.css`。
- 要点：字号 12/14 基准、11px 元信息提到 12、pill 单行、工作台页头换行；外壳不可 1:1 的部分按 navigation/controls 规格贴近。
- 验收：1440 / 1024 / 768 / 390 四档无溢出；元信息 ≥12px。

## 4. 未对齐项与原因（需拍板）

1. **官方外壳无源码**：会话流、composer、模型选择器来自 `@deepseek-ai/dsh-client-ui-*` npm 包。要真正 1:1，需确认是否允许引入该依赖；否则只能做视觉贴近（本方案默认后者）。
2. **设置页形态（已定，见 §7）**：参考是模态弹窗，本项目已改为 `AppModal size="page"` 弹窗，关闭即回上一页。
3. **亮色主题（已定）**：参考仓没有任何亮色定义（`packages/ui/src` 内检索 `light`、`prefers-color-scheme` 均无命中），按「无同名变量即保持现状」处理，逐项见 §6。

## 5. 批次 A 执行记录（commit `a56dea9`）

| 项 | 内容 |
|---|---|
| 还原页面/组件 | 项目主页（hero + 卡片）、全局侧栏、全局按钮基座、暗色色板 |
| 源文件 | `src/styles/base.css`、`src/components/layout/Sidebar.css`、`src/components/ui/AppButton.css`、`src/views/ProjectsView.vue`、`src/views/ProjectsView.css` |
| 关键改动 | ① 暗色令牌 7 值 + primary `#2563eb`；② 侧栏品牌 48/内衬 20、导航行 36/圆角 8/图标槽 26、任务行 36/圆角 6、footer 12 10，折叠态 footer 改纵向；③ hero `h1` 38→26/650、`p` 17→14；④ 卡片三动作收为单一「归档/恢复」，标题列 `min-width:0`；⑤ AppButton 高 36/圆角 9 |
| 功能迁移 | 卡片「在对话中打开」「删除项目」入口取消，改为卡片点击进工作台 + 侧栏项目行「···」菜单（同一 `project_remove` 后端命令），能力未丢失 |

### 四视口实测（Playwright + Chrome，`#/projects`）

| 视口 | 溢出 | h1 | 页面左缘 | 卡片 | 标题容器 | 侧栏/导航行 | footer |
|---|---|---|---|---|---|---|---|
| 1440×900 | 0 | 26px/650 | 292（=260+32） | 267×88 r12 | 127px | 260 / 36px / 14px | left 10，宽 239 |
| 1024×768 | 0 | 26px/650 | 292 | 342×88 | 202px | 260 / 36px | left 10 |
| 768×900 | 0 | 26px/650 | 88（=68+20） | 322×88（单列） | 182px | 68 / 40px | left 15 ≥ 0 |
| 390×844 | 0 | 26px/650 | 84（=68+16） | 290×88（单列） | 150px | 68 / 40px | left 15 ≥ 0 |

- D-01（卡片标题 17px → 127–202px）、D-07（折叠 footer 左溢 13px → left 15）、D-10（项目页左缘 292 单一来源）已消除。
- 全路由溢出回归：1440 与 390 下 `#/chat`、`#/inbox`、`#/capabilities`、`#/library`、`#/plugins`、`#/settings`、`#/memory` 均为 0。
- 仍未对齐：亮色色板未取自参考仓（无源码）；侧栏顶部仍是带文字的「新会话」按钮，参考是 46px 图标工具栏；页面标题字号梯队（27/22/20/18）待批次 B–D 收敛；`@media(max-width:560px)` 的 44px 命中区在 68px 图标轨上生效，待批次 D 复核。

## 6. 亮色令牌：无对应清单

参考仓 `packages/ui/src/styles/tokens.ts` 只导出 7 个暗色常量，全仓（`packages/ui`、`packages/plugins/*`）没有 `[data-theme]`、`prefers-color-scheme` 或任何亮色字面量。按「有同名变量才映射」的口径，亮色块全部保持现状。

| 本项目亮色令牌 | 现有值 | 参考仓对应 |
|---|---|---|
| `--bg` | `#eceff3` | 无对应 |
| `--bg-panel` | `#f6f8fa` | 无对应 |
| `--bg-elev` | `#ffffff` | 无对应 |
| `--bg-hover` / `--bg-active` | `#e4e8ee` / `#dae0e8` | 无对应 |
| `--border` / `--border-strong` / `--border-soft` | `rgba(35,39,47,.10/.18/.06)` | 无对应 |
| `--text` / `--text-dim` / `--text-faint` | `#1a1d21` / `#5f6672` / `#6b7280` | 无对应 |
| `--accent` | `#2563eb` | 已一致（参考 `primary` = `#2563eb`，亮暗共用） |
| `--danger` / `--ok` / `--warn` | `#dc2626` / `#16a34a` / `#d97706` | 无对应（参考走 `--dsw-alias-state-*`，取值在外部包） |
| `--sh-*` | 三档阴影 | 无对应（参考为 `--dsw-elevation-*`，取值在外部包） |

结论：亮色无需改动，唯一动作是把 `--accent` 与参考 `primary` 对齐，本批 A 已随暗色一起替换。

## 7. 设置页：改为参考仓 modal 形态（批次 C-1）

| 项 | 参考 `modal.ts` | 落地 |
|---|---|---|
| 对话框宽 | `min(720px, 100vw - 48px)` | `AppModal size="page"`，实测 1440/1024/768 均 720 |
| 最大高 | `100dvh - 48px` | 同值 |
| 遮罩内衬 | 24px | 24px（390 下 12px） |
| 圆角 | 16px（≤640 → 12px） | 实测 16px / 12px |
| 入场 | `0.16s ease-out`，`prefers-reduced-motion` 关闭 | `modal-page-in .16s` + reduce 关断 |
| 关闭键 | 32×32（≤640 → 44×44） | 实测 32×32 / 44×44 |
| 标题 / 操作区 | 标题 18px/650，底部右对齐操作区 | `modal-header` 18px/650 + `modal-footer` 单个「关闭」 |

- 结构：`SettingsView.vue` 顶层由 `.settings` 页面容器改为 `AppModal :open="true"`，删除页内 `h1` 与 `.settings-header`（标题交给对话框），左侧分区栏 + 右侧编辑区继续复用。
- 关闭：`closeSettings()` → `router.back()`，无历史时回 `#/chat`；路由仍是 `#/settings`，深链不变。
- 源文件：`src/components/ui/AppModal.vue`、`src/components/ui/AppModal.css`、`src/views/SettingsView.vue`、`src/views/SettingsView.css`。

### 四视口实测（`#/settings`）

| 视口 | 溢出 | 对话框 | 圆角 | 关闭键 | 内容高 | 分区栏 / 主区 | 方向 |
|---|---|---|---|---|---|---|---|
| 1440×900 | 0 | 720×369 | 16px | 32×32 | 235 | 200 / 520 | row |
| 1024×768 | 0 | 720×369 | 16px | 32×32 | 235 | 200 / 520 | row |
| 768×900 | 0 | 720×369 | 16px | 32×32 | 235 | 200 / 520 | row |
| 390×844 | 0 | 366×432 | 12px | 44×44 | 298 | 366 / 366 | column |

## 8. 批次 B 执行记录（commit `588af29`）

| 项 | 内容 |
|---|---|
| 还原页面 | 资料库（`#/library`）、能力中心（`#/capabilities`） |
| 源文件 | `src/styles/base.css`、`src/components/panels/LibraryPanel.css`、`src/views/CapabilitiesView.css`、`src/views/ProjectsView.css` |
| 关键改动 | ① 新增 `--fs-page/--lh-page/--fw-page`（26/1.3/650），项目页、资料库、能力中心标题统一引用；② 资料库 ≤880 改上下两段（树 `max-height: 42vh`）、tab 横向滚动、空态 `flex` 居中、工具栏输入框自适应；③ 能力中心去掉硬编码 `PingFang SC`、分类 tab 横向滚动、专家层 ≤1050 单列、网格 ≤640 单列 |

### 四视口实测

| 视口 | 能力中心溢出 | 分类 tab | 资料库溢出 | 树 / 预览 | 方向 | 工具栏 |
|---|---|---|---|---|---|---|
| 1440×900 | 0 | 509/509 | 0 | 280 / 804 | row | 1100/1100 |
| 1024×768 | 0 | 509/509 | 0 | 280 / 406 | row | 703/703 |
| 768×900 | 0 | 509/509 | 0 | 653 / 653 | column | 654/654 |
| 390×844 | 0 | 288/509（滚动） | 0 | 282 / 282 | column | 282/282 |

- 390 下资料库预览由 2px → 282px（D-03），能力中心分类 tab 由溢出 209px → 容器内滚动（D-05），资料库工具栏 404px → 282px（D-06）。
- 三个一级页标题统一 26px/650（D-11 收敛中，剩余：会话 27px、收件箱 22px、工作台 20px、记忆 19px、插件 18px，批次 C/D 处理）。

## 9. 批次 C-2 执行记录（收件箱 + 插件）

| 项 | 内容 |
|---|---|
| 还原页面 | 收件箱（`#/inbox`）、插件市场（`#/plugins`） |
| 源文件 | `src/views/InboxView.css`、`src/views/PluginsView.css` |
| 关键改动 | ① 收件箱页头 `flex-wrap: wrap`，左侧文本 `flex: 1 1 240px; min-width: 0`，操作区可换行；标题改用 `--fs-page/--lh-page/--fw-page`。② 插件页去掉硬编码 `PingFang SC`，标题同令牌；hero 允许换行；≤640 页面内衬 14、分区内衬 12、行内衬 12，行改两段式（图标+正文首行，操作区第二行右对齐）。 |

### 四视口实测

| 视口 | 收件箱溢出 | 页头文本宽 | 标题字号 | 插件溢出 | 描述宽 | 行宽 | 插件行数 |
|---|---|---|---|---|---|---|---|
| 1440×900 | 0 | 840 | 26/650 | 0 | 891 | 1058 | 3 |
| 1024×768 | 0 | 424 | 26/650 | 0 | 493 | 660 | 3 |
| 768×900 | 0 | 360 | 26/650 | 0 | 444 | 611 | 3 |
| 390×844 | 0 | 258 | 26/650 | 0 | 188 | 268 | 3 |

- 390 收件箱页头文本容器 27.2 → 258px（D-02），操作区右缘 403 → 352（视口 390，不再溢出）。
- 390 插件行描述 73 → 188px，`scrollHeight === clientHeight`（D-19 的 3 行塞 2 行消失）。
- 插件页 390 页头「发现社区插件」仍为 26px，行内标题 14px 不变（层级正确）。

## 10. 批次 D 执行记录（会话 + 工作台）

| 项 | 内容 |
|---|---|
| 还原页面 | 会话页顶栏（`#/chat` 会话态）、项目工作台（`#/projects/:id`） |
| 源文件 | `src/views/ChatView.css`、`src/components/chat/MessageList.css`、`src/views/ProjectWorkspace.css` |
| 关键改动 | ① 顶栏内衬由 `--chat-pad`（锁 720 列）改为 `var(--sp-4)` 横跨整栏，pill `flex-grow` 吃满、控制组去掉 `margin-left:auto`；② ≤640 胶囊强制单行（不再 wrap），内部横向滚动、标签不缩；③ 工作台 ≤640 页头换行、标题 `flex: 1 1 140px`、模式选择留首行、「在对话中打开」第二行右对齐；tab 条横向滚动；④ 用量收据 `.msg-usage` 11 → 12px。 |

### 四视口实测

| 视口 | 会话溢出 | 顶栏高 | 胶囊高 | 工作区标签(可见/全文) | 工作台溢出 | 工作台标题宽 | tab(可视/内容) |
|---|---|---|---|---|---|---|---|
| 1440×900 | 0 | 63 | 42 | 85/85 | 0 | 812 | 1180/1180 |
| 1024×768 | 0 | 63 | 42 | 85/85 | 0 | 396 | 764/764 |
| 768×900 | 0 | 63 | 42 | 85/85 | 0 | 332 | 700/700 |
| 390×844 | 0 | 107（两行：胶囊 + 控制组） | 42（单行） | 85/85（胶囊内滚动） | 0 | 202 | 322/512（滚动） |

- 390 顶栏胶囊 70（两行鼓包）→ 42px 单行（D-08）；工作区名 42 → 85px（D-09，1440/1024 全显）。
- 390 工作台标题 0 → 202px（D-04），tab 右缘 576 → 390（容器内滚动）。

## 11. 批次 E：收尾两条「省略号」+ 剩余页面

| 项 | 内容 |
|---|---|
| 判据 | 元素可用宽度 = 内容所需宽度，不出现无意义省略 |
| 源文件 | `src/views/ChatView.css`、`src/views/ProjectWorkspace.css`、`src/views/SettingsView.css`、`src/components/panels/LibraryPanel.css` |
| 改动要点 | ① ≤900：控制组退化为图标按钮（title 保留说明）、隐藏 pill 分隔点、二级选择器 `flex: 0 0 auto`、胶囊内衬/间距收紧 10px，把 129px 完整让给工作区名；② ≤640 工作台路径 chip 允许换行显示全文，去掉省略号；③ 设置页 ≤640 分区 tab 按钮 `width: auto`（原 `width:100%` 导致每个分区各占一屏、只看得见「通用」），加右缘渐隐；④ 资料库 tab 条同加渐隐。 |

### 四视口实测（收尾两条）

| 视口 | 工作区名(可见/全文) | 工作台路径 chip(可见/内容) | 设置分区 tab(可视/内容) | 溢出 |
|---|---|---|---|---|
| 1440×900 | 85/85 | 314/314 | 199/199 | 0 |
| 1024×768 | 85/85 | 314/314 | 199/199 | 0 |
| 768×900 | 85/85 | 314/314 | 199/199 | 0 |
| 390×844 | 85/85 | 288/288（两行全文） | 366/520（滚动 + 渐隐） | 0 |

- 768 工作区名 66 → 85px（100% 全显）；390 路径 chip `clientWidth === scrollWidth`（288），换行后无省略号。
- 设置页 390 分区 tab 从「每个分区一屏、仅见通用」→ 五个分区同排可滚动（内容 520，可视 366）。
- 全量路由溢出复核（projects、工作台、inbox、settings、capabilities team/market、library、plugins）× 四视口：全部 0。
- 本轮不再有靠截断处理的元素；剩余未处理项均为缺陷清单里的能力类（D-16 命中区、D-17 圆角梯度、D-21 全局搜索），不属版式对齐。

## 12. 批次 F：命中区 44 与圆角收敛（D-16 / D-17）

| 项 | 内容 |
|---|---|
| 源文件 | `src/styles/base.css`（令牌 + 命中区共享规则）、`src/components/layout/Sidebar.css`、`src/components/ui/AppInput.css`，以及 24 个 CSS 文件的字面圆角替换 |
| D-16 做法 | 视觉尺寸不变：`.app-btn`/`.app-select`/tab/`.app-check` 等用 `::before` 撑到 `--hit`（44）；导航行与输入框直接做到 44×44（伪元素对 input 无效、导航行相邻间距只有 2px，隐形区会互相覆盖） |
| D-17 做法 | 令牌收敛为 `--r-sm 4 / --r 8 / --r-lg 12 / --r-xl 16 / --r-full 999`；24 个文件共 140 处字面值映射到令牌（3–6→4，7–10→8，11–15→12，16–24→16，999→999） |

### 实测

| 视口 | 命中区达标 / 不达标 | 计算后圆角取值 |
|---|---|---|
| 1440×900 | 228 / 0 | 4、8、12、16、999（含 `0 0 12 12`、`8 8 0 0` 两处单向圆角） |
| 1024×768 | 228 / 0 | 同上 |
| 768×900 | 156 / 0 | 同上 |
| 390×844 | 156 / 0 | 同上 |

- 命中区判定：`getBoundingClientRect()` ≥44 或 `::before` 计算尺寸 ≥44；不达标元素由 4 类（导航行 36、图标按钮 20–32、tab 36、搜索框 28）清零。
- 圆角判定：遍历全部元素 `border-radius` 计算值，仅剩 5 档 + 两处单向圆角组合；12 档（3/4/5/6/7/8/9/10/12/14/16/999）已消除。
- 例外：`WorkspacePicker.css`（8px/7px）由另一会话在改，未纳入本轮；`50%` 圆形（头像、状态点）保持。
- 侧栏导航行高 36 → 44，`app-input` 28 → 44；四视口全路由横向溢出仍为 0。

## 13. 批次 G：全局搜索（D-21，已实装）

### 落地

| 项 | 内容 |
|---|---|
| 新增 | `src/composables/useGlobalSearch.ts`、`src/components/search/CommandPalette.vue`、`src/components/search/CommandPalette.css` |
| 改动 | `src/App.vue`（挂载）、`src/components/ui/AppModal.vue/.css`（`bare` 形态复用遮罩/焦点陷阱/Esc）、`src/components/layout/Sidebar.vue`（搜索按钮改为开面板）、`src/components/panels/LibraryPanel.vue`（`?q=` 预填）、`src/i18n/en-US/common.ts`、`src-tauri/src/run_meta.rs` |
| 索引来源 | 会话 `pi_journal_sessions`（打开时预取）；项目 `projects_list`；记忆 `agent_memory_list` 词面过滤；文件 `library_search` 随输入查询 |
| 交互 | ⌘K/Ctrl+K 开合，Esc 关闭，↑↓ 跨组循环，Enter 进入，悬停同步高亮 |
| 结果 | 分组「会话/项目/文件/记忆」，单组限额 5/5/8/5；前缀命中优先 |
| 空态 | 无输入显示最近 8 条（localStorage `pi-workbench:search-recent`）；无历史时显示四类提示 |
| 无结果 | 「没有找到「X」」+「在资料库中搜索」（带词跳转 `#/library?view=search&q=`），不自动跳页 |
| 失败 | 单源失败静默隐藏该组；文件/项目/记忆三源全失败且会话为空才显示错误条 |
| 记忆向量 | 未接入 `memoryVecSearch`（嵌入模型首查延迟高）；`ponytail:` 注明升级路径为 vecStatus.ready 后并联语义命中 |
| 回放窗口 | `open_replay_window` 的 label 改为 `(cwd, index)` 稳定派生；已存在则 `unminimize/show/set_focus`，不再叠第二个窗口 |

### 四视口实测（Playwright + Chrome，`#/chat`）

| 视口 | 面板 | 位置 | 在视口内 | 页面横向溢出 | 行高 | 行内溢出 |
|---|---|---|---|---|---|---|
| 1440×900 | 640×209 | left 400 / top 346 | 是 | 0 | 49 | 无 |
| 1024×768 | 640×209 | left 192 / top 280 | 是 | 0 | 49 | 无 |
| 768×900 | 640×209 | left 64 / top 346 | 是 | 0 | 49 | 无 |
| 390×844 | 350×201 | left 20 / top 322 | 是 | 0 | 49 | 无 |

- 键盘：查询 `p` 得 4 条（会话 2 / 项目 1 / 记忆 1）；↓ 移到下一条、↑ 回退、首条再 ↑ 循环到末条。
- 回车：项目 → `#/projects/p-flow-b`；文件 → `#/library?view=search&q=会议` 且搜索框回填「会议」；记忆 → `#/library?view=memory`；会话 → 触发 `open_replay_window` 1 次并关面板。
- 最近项：经过项目/文件/记忆三次进入后重开，空查询回放 3 条、无分组标题。
- 无结果：`没有找到「zzz」` + `在资料库中搜索`，四类提示隐藏。
- Esc 关闭成功；⌘K 再次按下开、再按关。输入框打开即聚焦。
- 回放窗口复用为 Rust 侧逻辑（`get_webview_window(label)` → 聚焦），无头浏览器无法验证真实双窗；`cargo check` 通过，需桌面端手验一次。




---

## 14. 设计系统级视觉重做（2026-11-10）

不再按缺陷逐条修，改为「令牌 → 组件 → 逐页」三层收敛。改前/改后四视口截图存于
`docs/ui-redo-2026-11-10/{before,after}/`（另附 `after-dark/` 暗色），实测数据在
`consistency-1440.json` / `consistency-390.json` 与各页 `metrics-*.json`。

### 14.1 令牌层（`src/styles/base.css`，唯一事实源）

| 组 | 令牌 | 值 |
|---|---|---|
| 字号 | `--fs-display/page/section/body/ui/meta/micro` | 32 / 26 / 16 / 14 / 13 / 12 / 11 |
| 行高 | `--lh-display/page/section/body/ui/meta` | 1.15 / 1.3 / 1.4 / 1.65 / 1.5 / 1.5 |
| 字重 | `--fw-regular/medium/semibold/page` | 400 / 500 / 600 / 650 |
| 间距 | `--sp-1…--sp-10` | 4/8/12/16/20/24/32/40/48/64 |
| 密度 | `--page-max/page-x/page-y/page-bottom`、`--pad-card(+lg)`、`--gap-card/section/head`、`--row-h(+lg)` | 1280；clamp(20,3vw,32)；clamp(24,4vh,40)；clamp(32,6vh,64)；16/20；16/32/14；36/44 |
| 表面 | `--bg/panel/elev/hover/active/sunken` + `--border(+strong/soft)` | 7 级，亮/暗各一套 |
| 描边/焦点 | `--stroke(+strong)`、`--focus-ring(+danger)` | 1px；`0 0 0 3px accent-soft` |
| 动效 | `--dur-fast/--dur/--ease` | 120/180ms，`cubic-bezier(.22,1,.36,1)` |

旧别名（`--fs-xs…--fs-2xl`）全部指向语义层级，页面不再写数值。

### 14.2 组件层

- 新增 `src/styles/ui-kit.css`：`.page-shell/.page-inner/.page-head/.page-title/.page-sub/.page-actions`、
  `.section-head/.section-title`、`.card`、`.empty-state/.empty-icon/.empty-title/.empty-hint`、`.skeleton/.sk-line/.sk-block`。
- `AppButton`：36 高、`--r` 圆角、13/500，补齐 hover/active/focus-visible/disabled/loading（`aria-busy`）；
  新增 `.v-secondary` 幽灵态 —— 全站只有主操作带实底，工具栏不再一排方框。
- `AppInput/AppTextarea`：36 高、`--bg-sunken` 输入井、`--focus-ring`；文本框不再按 44 撑高（文本域宽度已远超命中下限）。
- `AppSelect`：触发器/选项/焦点环统一到令牌，选项补 `:focus-visible`。
- `AppModal`：头 16/20 内衬、标题 16/600、关闭键 26 视觉 + 44 命中区。

### 14.3 逐页落地

| 批次 | 页面 | 改动要点 |
|---|---|---|
| 1 | 对话（落地页/会话态）、项目 | hero 标题归 `--fs-page`、间距归刻度；项目 hero 收到 980 阅读宽、模板区空时不渲染、空态换 `empty-state`；会话顶栏次要动作改幽灵态 |
| 2 | 工作台、收件箱、设置 | 工作台 tab 从下划线改胶囊分段、正文卡片独立成卡；收件箱页内衬/按钮/空态统一；设置左栏改中性选中、表单下拉 36 高 |
| 3 | 能力中心、记忆、资料库、插件 | 能力中心标题提到 tab 之上、卡片中性字头、工具按钮幽灵态；记忆用骨架屏；资料库 tab/空态统一；插件去掉「卡中卡」、tab 改胶囊、行卡改白底 |

### 14.4 验收实测

- 全站 CSS `font-size` 字面量 **0** 处（改前 348 处，含 10.5/11.5/12.5/13.5/14.5 半像素字号）；圆角字面量余 2 处（`WorkspacePicker` 冻结区，未动）。
- 一级标题：项目/收件箱/能力中心/记忆/资料库/插件/设置 全部 `26px / 1.3 / 650`，左缘 292（1440）/ 84–88（390）。
- 区块标题：`16px / 1.4 / 600`；卡片圆角 `12px`、内衬 `16px`；行高 36。
- 横向溢出：10 页 × 4 视口 = 40 组，`overflowX` 均为 0；暗色 40 组同样 0。
- 键盘焦点：Tab 遍历侧栏/按钮/导航，均为 `2px solid rgb(37,99,235)`；导航命中区仍 239×44。
