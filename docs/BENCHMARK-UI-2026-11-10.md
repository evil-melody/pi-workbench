# 界面业界对标报告（2026-11-10）

> 范围：视觉结构、交互机制、可访问性、响应式。不含商业化、计费、多租户。
> 方法：仓库/官方文档核对机制 → 与本项目源码逐项比对 → 差距矩阵。
> 标注规则：**未核实** = 闭源产品或仅凭公开界面观察，未读到实现；不编造版本号与内部实现。

## 1. 参考产品与版本基线

| # | 产品 | 形态/栈 | 版本或地址 | 核对方式 |
|---|---|---|---|---|
| 1 | LibreChat | Web，React | `github.com/danny-avila/LibreChat`，v0.8.8-rc2（官方 changelog） | 官方 changelog + 功能文档 |
| 2 | Lobe Chat | Web/PWA，Next.js | `github.com/lobehub/lobe-chat`（仓库；具体 tag 未核实） | 官方文档 |
| 3 | Open WebUI | Web，SvelteKit | `github.com/open-webui/open-webui`，v0.11.0 / v0.11.1 / v0.12.4（官方博客） | 官方文档 + 版本博客 |
| 4 | Chatbox | 桌面，Electron | `github.com/chatboxai/chatbox`，1.23 / 1.24（官方博客） | 官方博客 + 用户指南 |
| 5 | AnythingLLM | 桌面 + Web，Node/React | `github.com/Mintplex-Labs/anything-llm`，MIT（仓库） | 仓库 README 摘要 |
| 6 | Cline | VS Code 扩展 / CLI | `github.com/cline/cline`（仓库） | 官方 FAQ + CLI README |
| 7 | Raycast | macOS 启动器，闭源 | 未开源 | 仅观察公开交互，内部实现**未核实** |
| 8 | ChatGPT macOS 桌面端 | 闭源 | 未开源 | 公开界面观察，版本**未核实** |

排除项：ChatGPT/Claude 的具体版本号与内部组件树无法验证，本报告只引用其公开可见的交互形态，并在矩阵中标 **未核实**。

## 2. 可借鉴机制（逐产品）

### 2.1 LibreChat v0.8.8-rc2
- **会话与搜索**：跨全部会话的消息搜索（官方 Features: Message Search）；项目（Projects）把相关会话归入工作空间。
- **产物**：Artifacts 把对话输出变成可交互应用/图表/文档。
- **队列消息**：保存型 Agent 会话中的排队消息存服务端，关浏览器不丢（官方 Agents 文档）。
- **可迁移**：本项目 `MessageList` 已有 turn 分组基础，缺的是「会话级全局搜索」；LibreChat 的搜索入口在侧栏顶部而不是按钮跳转。

### 2.2 Lobe Chat
- **命令面板**：⌘K / Ctrl+K 打开覆盖层，一次检索 Agent、话题、设置、动作（官方 Command Menu 文档）。
- **话题面板**：侧栏列表负责快速切换，独立 Topic Panel 负责浏览、筛选、批量整理（官方 Topics 文档）。
- **运行状态**：Live Run Status 在会话内展示运行进度；连接器有统一的权限层（自由运行 / 需审批 / 关闭）（官方 changelog 2026-06-08、06-15）。
- **可迁移**：本项目工具行已有 running/error 状态（`MessageList.vue` toolRowView），缺「统一权限层」的呈现与 ⌘K。

### 2.3 Open WebUI v0.11.x–v0.12.x
- **搜索分层**：Cmd+K 在当前工作区内搜文件名/会话/消息；Cmd+Shift+F 打开更大范围搜索（官方 Search and chats 文档）。
- **快捷键可改**：Settings > Keyboard 里逐条重绑，冲突告警、保存到账户、一键恢复默认（v0.11.0 / v0.12.4 博客）。
- **工具审批**：v0.11.1 引入 Tool Approvals 与 `ask_user`，把「停下来问」做成产品能力。
- **信息架构**：v0.11.0 做了一次界面重组；文件夹可写描述（v0.12.4）。
- **可迁移**：本项目没有快捷键层；`ApprovalDialog.vue` 已有审批 UI，但没有可发现的快捷键与分组设置。

### 2.4 Chatbox 1.23 / 1.24
- **会话列表**：1.24 起会话列表可按项目文件夹分组排序（官方博客）。
- **工具行密度**：1.24 明确「tool calls take up less room」，工具调用默认压缩。
- **设置重组**：1.24 重排设置页。
- **可迁移**：本项目侧栏没有会话列表（只有导航 + 项目运行记录），这是与全部参考产品差距最大的一项。

### 2.5 AnythingLLM
- **工作区模型**：以 workspace 为单位组织文件与会话，而不是一次性附件。
- **引用**：对话内引用链回原始文档与原文片段（仓库 README: in-chat citations）。
- **检索模式**：`conversation` 与 `query` 两种模式区分上下文保留与纯问答。
- **可迁移**：本项目 `LibraryPanel` 有 draft/published 概念，缺对话内「引用到具体片段」的可见回链。

### 2.6 Cline
- **Plan / Act 双模式**：Plan 只读讨论，Act 才执行（官方 FAQ）。
- **检查点**：每步写入 shadow git，可回滚（第三方 Agent Patterns Catalog 的描述，未在仓库内逐行核实）。
- **审批粒度**：auto-approve 按操作类型分级，读文件可自动、写入/命令需批准（官方 FAQ / 教程）。
- **可迁移**：本项目已有 plan toggle（`ChatView.css:262-271`）与审批对话框，但「每步可回滚」的检查点 UI 未见实现（**未核实** `fileChanges` 是否有还原入口）。

### 2.7 Raycast（闭源，**未核实**实现）
- **命令面板即主导航**：键盘优先，列表结果带分组与快捷键提示；空查询展示最近使用。
- **可迁移**：只借「面板即入口 + 空查询给最近项」的交互结论，不假设其内部技术。

### 2.8 ChatGPT macOS 桌面端（闭源，**未核实**版本）
- **并列面板**：对话与 Canvas/产物并排，而非切页。
- **可迁移**：本项目 `TraceDrawer`/`ActivityPanel` 已是并列面板思路，缺统一的打开/收起动效与宽度档位。

## 3. 本项目现状（对照依据）

| 能力 | 现状 | 依据 |
|---|---|---|
| 会话历史列表 | 无 | `Sidebar.vue` 仅有导航与项目运行记录（`Sidebar.vue:344`） |
| 全局搜索 | 无 | 侧栏搜索按钮直接 `router.push('/projects')`（`Sidebar.vue:293-295`） |
| 流式状态 | 有 | `MessageList.vue:218-225`（live / stopped / interrupted） |
| 推理过程 | 有 | `MessageList.vue:244-254`、`549-554`（折叠 + 流式末行摘要） |
| 工具调用卡 | 有 | `MessageList.vue:294-310`（icon / state / summary / error） |
| 产物预览 | 有 | `ArtifactCard.vue`、`ArtifactPreview.vue` |
| 空状态 | 部分 | 各视图手写；资料库空态三行间距 243px（见缺陷 D-18） |
| 骨架屏 | 无 | 源码 `skeleton` 0 命中 |
| 命令面板 | 无 | `metaKey`/`ctrlKey`/`palette` 0 命中 |
| 多面板 | 部分 | `ProjectWorkspace` 三栏、`TraceDrawer`、`ActivityPanel`、`AgentBrowserPane` |
| 设置 IA | 部分 | 5 个平铺 tab（`SettingsView.vue:395-412`），无分组/搜索 |
| 键盘可达 | 部分 | tablist/menu/listbox 已补方向键（批次 3），无全局快捷键 |
| 深浅色 | 有 | `ThemeToggle.vue` + `base.css` 令牌 |
| 密度调节 | 无 | 无 density 相关令牌或设置项 |
| 窄屏适配 | 无 | 57 个 CSS 中仅 9 个含 `@media`；Inbox/Projects/Capabilities/Plugins/ProjectWorkspace/Library/Sidebar 均为 0 |
| 引用回链 | 部分 | 资料库有 draft/published，对话内未见片段级回链（**未核实**） |

## 4. 差距矩阵

`有 / 部分 / 无`；格内依据尽量指向文件或官方机制名。

| 能力项 | 本项目 | LibreChat | Lobe Chat | Open WebUI | Chatbox | AnythingLLM | Cline | Raycast | ChatGPT 桌面 |
|---|---|---|---|---|---|---|---|---|---|
| 会话历史列表 | 无（仅导航） | 有（会话侧栏） | 有（话题列表） | 有（会话+文件夹） | 有（1.24 文件夹分组） | 部分（按 workspace） | 有（任务历史） | 部分（最近项，未核实） | 有（侧栏） |
| 会话/消息搜索 | 无（按钮跳项目页） | 有（Message Search） | 有（⌘K 含话题） | 有（Cmd+K / Cmd+Shift+F） | 部分（会话列表过滤） | 部分（workspace 内） | 无（未核实） | 有（全局） | 有（搜索会话，未核实范围） |
| 流式状态 | 有（live/stopped） | 有 | 有（Live Run Status） | 有 | 有 | 有 | 有 | 不适用 | 有 |
| 推理过程呈现 | 有（折叠行） | 部分（reasoning 区块） | 有（思考过程折叠） | 有（thinking 折叠） | 部分 | 部分 | 有（Plan 模式） | 不适用 | 有 |
| 工具调用卡 | 有（状态+摘要） | 有（工具调用卡片） | 有（工具调用块） | 有（Tool Approvals） | 有（1.24 压缩工具行） | 有（agent 步骤） | 有（审批级） | 不适用 | 有（未核实细节） |
| 产物/文件预览 | 有（ArtifactCard/Preview） | 有（Artifacts） | 有（Artifacts + 预览页签） | 有（Artifacts） | 部分（附件预览） | 有（文档查看） | 有（diff 视图） | 不适用 | 有（Canvas/预览） |
| 空状态 | 部分（手写、间距破） | 有 | 有 | 有 | 有 | 有 | 有 | 有（最近项） | 有 |
| 骨架屏 | 无 | 部分（加载占位） | 有（加载占位） | 部分 | 部分 | 部分 | 不适用 | 不适用 | 有 |
| 命令面板 ⌘K | 无 | 部分（搜索覆盖层） | 有（Command Menu） | 有（Cmd+K） | 无（未核实） | 无（未核实） | 无 | 有（核心） | 无（系统级） |
| 多面板布局 | 部分（三栏/抽屉） | 部分（侧栏+主区） | 有（话题面板+主区） | 有（侧栏+工作区） | 部分（双栏） | 有（workspace+文档） | 有（编辑器+聊天并列） | 不适用 | 有（Canvas 并列） |
| 设置页 IA | 部分（5 平铺 tab） | 有（分组设置） | 有（分组+搜索） | 有（分组，含 Keyboard） | 有（1.24 重排） | 有（分组） | 有（分组） | 有（分组+搜索） | 有（分组） |
| 键盘可达 | 部分（局部方向键） | 部分 | 有（⌘K + 菜单） | 有（可重绑快捷键） | 部分 | 部分 | 部分 | 有（全键盘） | 部分 |
| 深浅色 | 有 | 有 | 有 | 有 | 有 | 有 | 随 IDE | 有 | 有 |
| 密度调节 | 无 | 无 | 部分（布局密度，未核实） | 部分（字号/密度设置，未核实） | 部分（1.24 压缩工具行） | 无 | 不适用 | 不适用 | 无 |
| 窄屏适配 | 无（7 个主视图 0 断点） | 有（响应式 Web） | 有（移动端 PWA） | 有（响应式） | 有（移动端 App） | 部分 | 不适用 | 不适用 | 部分 |

> 矩阵中「部分」均指机制存在但覆盖不全，不等价于缺陷；本项目「部分/无」的展开证据见 `docs/UI-DEFECTS-2026-11-10.md`。

## 5. 对标结论

1. **最大结构性缺口是导航**：八个参考产品里七个把「会话历史 + 搜索」放在侧栏第一屏；本项目侧栏只有六个导航项，搜索图标还是跳转按钮（`Sidebar.vue:293-295`）。这是用户感知「不像成熟客户端」的首要原因，优先级高于任何像素级修复。
2. **工具与推理呈现不缺，缺可发现性**：`MessageList` 的 turn/tool/reasoning 模型已经接近 Cline/Chatbox 的做法，问题是 10–11px 的字号与 24px 以下命中区（见缺陷 D-15/D-16），让人「看不见、点不准」。
3. **响应式是硬缺口**：57 个样式文件只有 9 个含断点，7 个主视图为 0。390px 下出现标题宽 0、预览面板 2px 这类破版，属于结构性缺失，不是个别样式写错。
4. **版式缺单一事实源**：页面标题有 38/27/22/20/18/19 六种字号、页面内衬有 32/40 两套、基础字号 13 与 14 混用、硬编码字号 347 处、圆角 12 种取值。对标产品都有明确的设计令牌层。
5. **状态规范缺组件**：无骨架屏、无统一空态组件，导致资料库空态三行间距 243px 这类「同一组件内自相矛盾」的排版。

## 6. 整改批次索引

完整方案（涉及文件、验收判据、像素口径）见 `docs/UI-DEFECTS-2026-11-10.md` 第 5 节。

| 批次 | 主题 | 借鉴来源 |
|---|---|---|
| A | 响应式闭环（P0 破版） | Open WebUI 响应式布局、Chatbox 侧栏折叠 |
| B | 版式令牌与页面骨架统一 | Chatbox 1.24 设置重组、Open WebUI v0.11.0 界面重组 |
| C | 会话列表 + 全局搜索 + ⌘K | LibreChat Message Search、Lobe Chat Command Menu、Open WebUI Cmd+K |
| D | 状态规范（骨架/空态/错误/密度） | Lobe Chat Skeleton、Cline 审批与检查点、AnythingLLM 引用 |
