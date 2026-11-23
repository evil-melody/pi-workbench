# Pi Workbench 能力与界面体检报告

> 审计对象：`/Users/tatsuma/Documents/GIT/pi-workbench`
> 代码基线：`bd7c14f`（2026-10-23），`piVersion: 0.87.1`
> 目标形态：面向全球超级个体的主动服务 AI Agent
> 报告性质：只读静态审计 + 现有文档/测试交叉核对。**未修改任何业务代码**，**未做真机视觉回归与性能压测**；凡未经运行态验证的判断均显式标注。
> 变更记录：2026-11-06 —— 移除商业化与身份范围（多租户、计费、配额、商业审计全部删除），总人日由 118 调整为 106。

---

## 0. 证据口径

1. 结论只写代码里存在的东西；未实现的能力直接标「缺失」，不把 roadmap、注释、旧文档当成已实现。
2. 行号对应当前 commit，后续改动会漂移，评审时以符号名 + 行号双定位。
3. 跨文件关系用 `graphify` 遍历 `graphify-out/graph.json` 交叉验证（调度/触发类查询只命中前端 `trigger` 变量与 `project_task_context`，无后台任务链路）。
4. 涉及的「外围运行时」判断（Pi 扩展加载时序）来自本机已安装的 `@earendil-works/pi-coding-agent@0.87.1` dist，不在本仓内，单独标注。

---

## 1. 结论摘要

**一句话：工程底座合格，产品形态仍是「本地单人对话工作台」；距离「主动服务的超级个体 Agent」缺的是任务生命周期，不是界面皮肤。**

成熟度自评（L0 无 → L4 主动服务）：

| 维度 | 当前 | 目标 | 判断 |
|---|---|---|---|
| 对话与执行 | L3 工具型助手 | L4 | 文件/命令/编辑/MCP/技能已闭环 |
| 主动性 | L0 | L4 | 无调度、无事件源、无后台任务、无回推 |
| 记忆与个性化 | L2（可管可纠错，有画像视图） | L4 | 词面检索、标签折叠画像、append-only 纠错 |
| 多端与触达 | L0 桌面单端 | L4 | 仅 Tauri 桌面，无 IM/邮件/移动 |
| 编排与可靠性 | L2（有编排，无恢复） | L4 | 有团队并发，无重试/队列/预算 |
| 全球化 | L0 | L4 | 中文硬编码、人民币硬编码、单机本地 |

核心结论：

1. **主动服务基本没有实现。** 全仓无 `cron/schedule/interval` 运行时，无事件订阅入口，无任务持久化队列，无系统通知插件；应用关闭后没有任何后台进程。唯一「后台」能力是 Pi 子进程内的一次流式对话。
2. **单任务模型。** `PiState` 只持有一个 `Child`（`src-tauri/src/state.rs:11-13`），同一时刻只跑一个主会话；多成员并发靠扩展临时 `spawn`，不进入任务系统。
3. **长时任务不可恢复。** 会话以 `--no-session` 启动（`src-tauri/src/pi_bridge.rs:297`），持久化只有 journal 与只读回放窗口（`src/composables/useReplay.ts:15-21`），没有「中断后续跑」。
4. **记忆已可管可纠，但召回仍是词面。** 存储是全局 `.pi/memory/memory.jsonl`（`src-tauri/extensions/agent-memory.ts`），召回是多信号词面评分；删除有 24 小时撤销窗口与立即永久删除，更正走 append-only 事件，画像由保留标签折叠。Rust 侧向量库仍只有外壳能查；100 条词面评测基线已固化，向量是否值得接按下轮结果决定。
5. **执行面有硬伤。** MCP 的 streamable-http 未接入（`src-tauri/src/connectors.rs:403`）；浏览器只能抓 HTML/截图，不能点击填表（`src-tauri/extensions/agent-browser-session.ts:9-13`）；沙箱检测不到隔离环境时回落宿主机执行（`src-tauri/extensions/sandbox-env.ts:156`）。
6. **界面主要问题不在「丑」，在「不成体系」。** 设计令牌集中（`src/styles/base.css:12-19/40-46/93-99/123-150`），0 个内联 `<style>` 块，单文件均未超 2000 行；但导航缺对话入口、模式切换器只在对话页、三态覆盖不均、229 个原生按钮仅 9 个 `aria-label`、无移动断点。
7. **最小可行「主动」落地点：新增调度器 + 任务账本 + 收件箱 + 系统通知**，复用现有 journal、审批门、Pi 子进程拉起逻辑；不需要重写内核（见 §3.7）。

---

## 2. 仓库实况地图

| 模块 | 位置 | 实际能力 | 成熟度 |
|---|---|---|---|
| 桌面外壳 | `src-tauri/`（Tauri 2） | 116 个 IPC 命令（`src-tauri/src/lib.rs:94` 起）；仅开放 dialog/opener 插件权限（`src-tauri/capabilities/default.json`） | 在用 |
| 前端 | `src/`（Vue 3.5 + TS + Vite 5） | 11 个视图、51 个 Vue 文件、55 个 CSS 文件、36 个单测文件；手写 UI Kit（Input/Select/Checkbox/Textarea/Modal/Icon/ContextMenu），无 AppButton | 在用 |
| 内核桥 | `src-tauri/src/pi_bridge.rs` | 以 `--mode rpc --no-session` 拉起 Pi（`:297`），注入 agent 目录（`:301`）、API Key（`:314`）、扩展路径（`:324`）；锁文件防多实例 | 在用 |
| 内核扩展 | `src-tauri/extensions/*.ts` | 10 个扩展：记忆、守卫、工具门、沙箱、团队、技能池、MCP 桥、浏览器会话、代码库检索、角色注入 | 在用 |
| 工具面 | 扩展 `pi.registerTool({` 注册 | 10 个扩展共 21 个工具 + Pi 内置文件/命令工具 + 动态 `mcp__*`；工具目录由后端下发（`src-tauri/src/tools.rs`） | 在用 |
| 记忆 | `agent-memory.ts`；`memory_vec.rs`；`MemoryView.vue` | 全局 JSONL 追加写 + 词面召回；向量库仅外壳可查；UI 可浏览/新增 | 半成品 |
| 会话与回放 | `pi_events.rs`、`conversation.rs`、`useReplay.ts`、`RunHistory.vue` | journal 事件流、按索引回放窗口、导出/导入；无续跑 | 半成品 |
| 治理与用量 | `governance.rs`、`agent_ops.rs`、`UsageCard.vue` | 按 provider/model 聚合 calls/tokens/cost（`:277`）；技能/工具开关；无预算硬限 | 半成品 |
| 检查点 | `checkpoint.rs` | 每轮标记 + edit/write 前备份 + rewind；**bash 产生的变更不在快照内**（`:5-6` 自述） | 半成品 |
| 文档/资料库 | `LibraryPanel`、`projects.rs` | 项目、任务上下文、资料库树、修订快照、分享文本 | 在用 |
| MCP | `mcp.rs`、`connectors.rs`、`agent-mcp-bridge.ts` | stdio 连接器可握手；HTTP 传输仅声明（`connectors.rs:403`） | 半成品 |
| 浏览器 | `browser.rs`、`agent-browser-session.ts`、`BrowserView.vue` | 系统浏览器打开；Node fetch（无 JS 渲染）；本机 Chrome 无头截图 | 半成品 |
| 终端 | `terminal.rs` | `sh -lc` 流式输出，`cwd` 由前端传入（`:9-14`），不做根目录约束 | 在用（风险） |
| 文件 | `fs.rs` | `canonicalize` 后做根目录前缀校验（`:19-44`） | 在用 |

补充（待运行态验证）：每个扩展在工厂函数里调用 `pi.setActiveTools([...])` 只列自身工具（如 `agent-memory.ts:167`、`agent-teams.ts:395`）。按本机 Pi 0.87.1 dist 的加载顺序，工厂执行早于 runtime 绑定，该调用会命中未初始化占位实现；同时 Pi 默认 `includeAllExtensionTools=true`。因此这些调用疑似未生效，实际是全部扩展工具常驻，存在工具描述占用上下文与扩展间互相覆盖的隐患。建议阶段 0 用真实会话验证一次工具列表。

---

## 3. 能力差距矩阵

判定口径：**已有**＝端到端可用；**半成品**＝链路存在但关键环节缺失或受限；**缺失**＝代码中无实现。工作量＝1 名熟悉本仓工程师的有效人日，不含评审/设计加签。

### 3.1 主动性与触发

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 定时/周期调度 | 全仓无 `cron`/`schedule`/`tokio::time::interval` 运行时；`lib.rs:94` 起的 116 个命令无调度类 | 缺失 | 无法「每天早上 9 点整理简报」；主动服务的地基不具备 | P0 | 5 |
| 事件订阅（邮件/IM/日历/GitHub） | 无 webhook/HTTP server/订阅循环；连接器只做 MCP stdio | 缺失 | 只能人问才答，无法「有事找你」 | P1 | 8 |
| 长时任务与断点恢复 | 单 `Child`（`state.rs:11-13`）；`--no-session`（`pi_bridge.rs:297`）；无 job 表 | 缺失 | 应用退出/崩溃即任务丢失；不能跑多步长任务 | P0 | 10 |
| 无人值守执行 | 有工具门审批（`agent-tool-gate.ts:275`）与守护（`agent-guard.ts:174`），但审批依赖人工点击，无「预授权策略」模型 | 半成品 | 夜里没人点按钮，任务卡死；无法真正托管 | P0 | 6 |
| 结果回推 | 无 `notification` 插件依赖；仅应用内事件流；`tauri.conf.json` 只挂 dialog/opener | 缺失 | 结果只能回应用里看，离开应用即失联 | P0 | 5 |
| 主动建议/待办收件箱 | 导航只有插件/项目/能力中心/资料库（`Sidebar.vue:42-46`），无 inbox/任务页 | 缺失 | 没有承载主动产物的容器 | P0 | 4 |

### 3.2 记忆与个性化

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 长期记忆存储 | 全局 `memory.jsonl`（`agent-memory.ts:24`），Rust 侧 `agent_memory_list/store`（`lib.rs:200-204`） | 已有 | 可存可读；但仅纯文本 + tags | — | 0 |
| 语义召回 | 召回为中文 bigram 词面评分（`agent-memory.ts:9-10`）；`memory_vec.rs:17-18` 明确写 Agent 工具够不到向量库 | 半成品 | 「意思相同、字面不同」检索不到；记忆量上来后可用性骤降 | P1 | 4 |
| 用户画像/偏好 | 由记忆保留标签（`profile:preference|taboo|goal|workflow=`）折叠成只读视图，`before_agent_start` 注入；无手工档案 | 可用 | 字段集最小，证据仍依赖记忆写入纪律 | P1 | 6 |
| 跨会话上下文 | journal + 只读回放（`useReplay.ts:15-21`）；`--no-session` 不保留内核会话树；前端消息在组件内（`Sidebar.vue:97` 注释说明重挂载即清空） | 半成品 | 重启后不能「接着上次继续」 | P1 | 5 |
| 遗忘/纠错 | 删除有 24 小时撤销窗口，也支持立即永久删除（二次确认 + 审计）；更正走 append-only `update` 事件，列表/召回都读物化结果；画像由保留标签折叠 | 可用 | 无物理删改；召回仅词面 | P1 | 2 |
| 记忆治理（去重/衰减/分层策略） | 仅 `ts/text/tags` 三字段，无来源、置信度、命中统计 | 缺失 | 噪声累积，召回质量不可控 | P2 | 4 |

### 3.3 执行面

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 文件读写/编辑/命令 | Pi 内置工具 + `fs.rs` 根目录约束 | 已有 | 单机场景够用 | — | 0 |
| 代码执行沙箱 | `sandbox-env.ts:156` 在无隔离环境时直接 `sh -lc` 跑宿主机；无 cgroup/namespace/seatbelt | 半成品 | 提示注入可触达本机任意文件/网络；无人值守时风险放大 | P0 | 8 |
| 浏览器自动化 | 只能 `browser_fetch`（无 JS 渲染）与截图（`agent-browser-session.ts:9-13`）；无点击/输入/等待 | 半成品 | 表单、登录后操作、SPA 场景全不可用 | P1 | 10 |
| 外部系统集成（MCP） | stdio 可握手；streamable-http 明确未接（`connectors.rs:403`） | 半成品 | 云端 MCP（GitHub/Notion/Linear 等）接不进 | P1 | 6 |
| 权限与策略 | 工具门 + 技能/工具开关 + `fs` 根约束；但 `terminal.rs:9-14` 无根目录限制、无命令白名单 | 半成品 | 终端是审批以外的旁路；策略不闭环 | P0 | 5 |
| 多智能体编排 | `agent-teams.ts:235/240` 并行 `Promise.all`，成员超时回收（`:156`） | 半成品 | 有并发无依赖图、无重试、无结果落账 | P1 | 6 |
| 凭证安全 | API Key 写入 `app-settings.json`（`models.rs:244-245`）并以 `--api-key` 传参（`pi_bridge.rs:314`） | 半成品 | 明文落盘 + 进程参数可见；不符合全球隐私基线 | P0 | 3 |

### 3.4 多端与可达性

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 桌面端 | Tauri 2，`minWidth 900`（`tauri.conf.json:18-19`） | 已有 | 桌面体验可用 | — | 0 |
| 移动端 | 无移动目标配置；布局无 <720 断点设计（仅 3×1180、1×1080、1×720、1×640） | 缺失 | 超级个体在手机上无法接手 | P2 | 20+ |
| IM/邮件触达 | 无机器人/邮件发送能力；MCP 也无 IM 服务端 | 缺失 | 无法「在飞书/邮件里收到并回复」 | P1 | 10 |
| 多设备同步 | 数据全在 `app_config_dir`，无同步/账号体系 | 缺失 | 换机即失忆 | P2 | 15 |

### 3.5 编排与可靠性

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 任务规划 | 依赖模型自身规划；无 DAG/步骤账本/人工确认节点 | 半成品 | 长任务不可解释、不可干预 | P1 | 5 |
| 失败重试/补偿 | 无 retry/backoff；团队成员失败即返回错误（`agent-teams.ts:156-158`） | 缺失 | 网络抖动即整任务失败 | P0 | 5 |
| 可观测性 | journal 事件、Trace 抽屉、RunHistory、用量聚合（`governance.rs:277`） | 半成品 | 能看到，但不能按任务追踪/告警 | P1 | 4 |
| 成本控制 | 只读聚合 tokens/cost；无预算阈值、无超限熔断、无按任务归集 | 半成品 | 无人值守可能烧钱 | P1 | 4 |
| 并发 | 主会话单 `Child`；团队临时并发；无队列/优先级/限流 | 半成品 | 多任务会互相抢进程；无公平调度 | P1 | 6 |

### 3.6 全球化

| 能力项 | 现状证据 | 判定 | 差距与影响 | 优先级 | 人日 |
|---|---|---|---|---|---|
| 多语言 | 无 i18n 依赖；`index.html` 写死 `lang="zh-CN"`；视图字符串中文硬编码 | 缺失 | 非中文用户不可用 | P1 | 8 |
| 多时区 | 无时区配置/换算；时间显示用本机 | 缺失 | 跨时区定时/简报错位 | P2 | 2 |
| 多币种 | `UsageCard.vue:115-116` 写死 ¥ | 缺失 | 海外账单展示错误 | P2 | 2 |
| 合规/数据驻留 | 单机本地，无数据分类/导出/删除策略；CSP 为 `null`（`tauri.conf.json:23`） | 缺失 | 无法满足 GDPR 类要求 | P1 | 10 |
| 隐私 | Key 明文；journal 存正文；无脱敏 | 半成品 | 泄漏面大 | P0 | 3 |

### 3.7 「主动服务」的真实状态与最小落地点

**状态：没有实现。** 代码里不存在任何「无人触发—后台执行—结果送达」的闭环；现有链路全部由用户在前端点「发送 / 运行」启动。

**最小可行落地点（建议新增模块，不重写内核）：**

```
src-tauri/src/scheduler.rs   // 新增：Tokio 定时循环，读 jobs.json，到点触发
src-tauri/src/jobs.rs        // 新增：任务账本（id/schedule/prompt/cwd/status/attempts/result）
src-tauri/src/inbox.rs       // 新增：主动结果收件箱（未读/已读/归档）
src/views/InboxView.vue      // 新增：三态齐全的收件箱页
```

复用点：

- 拉起方式复用 `pi_bridge.rs` 的 `--mode rpc --no-session` + 扩展注入；
- 事件与产物复用 `pi_events.rs` 的 journal；
- 审批复用 `agent-tool-gate.ts`，新增「任务级预授权」字段；
- 通知用 `tauri-plugin-notification`（当前未安装）。

最小闭环验收：定时任务 ±60s 触发 → 失败退避重试 3 次 → 结果 30s 内进 Inbox 并弹系统通知 → 应用重启后任务状态可查。

---

## 4. 界面与样式审计

### 4.1 技术栈与令牌现状

| 项 | 事实 | 证据 |
|---|---|---|
| 框架 | Vue 3.5 + TypeScript + Vite 5 + Tauri 2 | `package.json` |
| 组件库 | 无第三方 UI 库，全部手写 | `src/components/ui/`（7 个组件） |
| 样式组织 | 每个组件独立 `.css` 文件，全部外链 | 51 个 `.vue` / 55 个 `.css`，0 个内联 `<style>` 块 |
| 设计令牌 | 集中管理，暗色为默认、亮色覆盖 | `base.css:12-19`（色）、`:40-46`（圆角）、`:69-70`（动效）、`:93-99`（间距）、`:123-150`（亮色） |
| 主题切换 | `[data-theme='light']` + `color-scheme` | `base.css:9`、`:123-124` |

**判断：令牌层是达标的，问题在「令牌之下没有组件层」。**

### 4.2 项目铁律合规实测

| 规则 | 实测结果 | 判定 |
|---|---|---|
| 禁止内联样式 | 0 个 `<style>` 块；12 处 `:style` 均为动态 CSS 变量或浮层定位（`Sidebar.vue:315`、`WorkspacePicker.vue:220` 等），非静态样式 | 合规 |
| 样式抽离 | 全部组件使用独立 `.css` | 合规 |
| 重复代码抽公共组件 | 无 `AppButton`，229 个原生 `<button>` 分散在各视图；无 `EmptyState`、无 `PageHeader`（`aops-head`/`pw-head`/`community-head` 各自实现）；4 套对话框内容样式（`LibraryPanel.css:468`、`Sidebar.css:437`、`RunHistory.css:168`、`TeamsView.css:85`）；3 套菜单定位（`ActivityPanel.vue`、`WorkspacePicker.vue`、`RunHistoryMenu.vue`） | 不合规 |
| 禁用原生交互控件 | `select/radio` 已全部封装；仅 `AppInput/AppTextarea/AppCheckbox` 内部使用原生标签（`AppInput.vue:17`、`AppTextarea.vue:59`、`AppCheckbox.vue:8-9`），属合理封装 | 合规 |
| 单文件 ≤2000 行 | 最大 `ChatView.vue` 1079 行；Rust 最大 `pi_bridge.rs` 1766 行 | 合规 |
| 硬编码颜色 | 49 处 hex 集中在 `base.css` 令牌区；越界仅 `Sidebar.css:488/494` 的 `#fff`，以及 `index.html:7` 的 `theme-color` | 基本合规 |

### 4.3 问题清单（按优先级）

| ID | 问题 | 证据 | 影响 | 优先级 | 修法 |
|---|---|---|---|---|---|
| UI-01 | 对话页不在主导航 | `Sidebar.vue:42-46` 只有插件/项目/能力中心/资料库；`router/index.ts:12-15` 的 `/chat` 靠「新会话」按钮进入（`:220`） | 用户进项目后找不到回对话的稳定入口 | P0 | 主导航增加「对话」，保留新会话按钮 |
| UI-02 | 模式切换器不常驻 | 仅在 `ChatView.vue:37-41`；`ProjectWorkspace.vue:386-399` 头部无任何模式/模型切换 | 与项目既有硬约束冲突；项目内无法调整深度 | P0 | 抽 `AppTopBar`，对话/项目工作台共用 |
| UI-03 | 三态覆盖不均 | 实测：`BrowserView` loading 0、error 1、empty 1；`SkillPoolView` loading 0、error 0、empty 1；`SettingsView` loading 0；`TeamsView` error 0 | 慢请求/断网时白屏或静默失败 | P1 | 抽 `AsyncSection`，统一 loading/empty/error |
| UI-04 | 可访问性弱 | 229 个 `<button>`，仅 9 个 `aria-label`，138 个 `title`；图标按钮主要靠 title 提示 | 键盘/读屏用户可用性差；title 不是可靠的可访问名称 | P1 | 图标按钮强制 `aria-label`；补焦点样式；加 a11y 单测 |
| UI-05 | 无响应式 | `minWidth 900`（`tauri.conf.json:18-19`）；断点仅 1180/1080/720/640 各 1–3 处，侧栏折叠靠手点（`Sidebar.vue:184-190`） | 小屏 / 分屏不可用；为后续移动端埋雷 | P1 | 定义 3 档断点，窄屏自动折叠侧栏 |
| UI-06 | 缺组件层 | 无 `AppButton/AppPageHeader/AppEmptyState/AppDialog`；5 类页头、17 个空状态选择器、4 套对话框行、3 套菜单定位 | 改一处要改多处，视觉易漂移 | P1 | 建 `components/ui` 第二层，逐页替换 |
| UI-07 | 颜色小范围越界 | `Sidebar.css:488/494` 写死 `#fff`；`index.html:7` 写死主题色 | 亮/暗主题下可能失真 | P2 | 改用 `--accent-ink` / 动态 theme-color |
| UI-08 | 缺视觉回归基线 | 有 `scripts/visual-check.mjs`（`package.json:28`），但无基线截图对比门禁 | 样式回归靠人眼 | P2 | 关键页截图入 CI，像素阈值 + 人工复核 |
| UI-09 | 信息架构缺「任务/收件箱」 | 导航无 inbox；`RunHistory` 只在对话右侧 | 主动服务产物无处安放 | P0（随主动能力） | 与 §3.7 同步上线 |

### 4.4 业界标准对照

| 维度 | 现状 | 差距 |
|---|---|---|
| 布局栅格 | 侧栏 + 主区 + 可折叠右栏；宽度用固定值 + `1fr` | 无统一栅格令牌（列数/沟槽），页面间留白不一致 |
| 组件库使用 | 自研 UI Kit，覆盖输入/选择/弹窗 | 缺按钮、页头、空态、骨架屏、Toast 统一层 |
| 响应式 | 桌面优先，最低 900px | 无平板/手机策略，侧栏不自动收纳 |
| 暗色主题 | 完整令牌覆盖，默认暗色 | 达标；仅 3 处硬编码需收口 |
| 空/加载/错误态 | 各页自实现，覆盖不均（见 UI-03） | 无统一异步容器与错误重试 |
| 可访问性 | Modal 有焦点陷阱与 Esc（`AppModal.vue:22-88`），语义标签局部使用 | `aria-label` 覆盖极低；对比度未校验；无键盘走查用例 |
| 信息架构 | 4 个主导航 + 新会话入口；模式切换仅在对话页 | 对话、任务、收件箱三条主线未成体系 |

### 4.5 设计体系落地方案

**目标结构：**

```
src/styles/
  base.css          # 现有：色/间距/圆角/动效令牌
  tokens.css        # 新增：栅格、层级 z-index、排版比例、状态色
  themes.css        # 新增：dark/light 语义映射（从 base.css 拆出）
src/components/ui/
  AppButton.vue     # 新增：primary/ghost/danger/icon 四种
  AppPageHeader.vue # 新增：标题/描述/操作区
  AppEmptyState.vue # 新增
  AppSkeleton.vue   # 新增
  AppDialog.vue     # 由 AppModal 升级：header/footer 插槽
  AsyncSection.vue  # 新增：loading/empty/error 三态容器
```

**迁移顺序（从收益高、冲突低开始）：**

1. 建 `AppButton`，先替换 3 个高频页（Chat/Capabilities/Projects），再全量替换 229 处。
2. 建 `AsyncSection`，按 UI-03 清单逐页接入。
3. 建 `AppPageHeader`，统一 5 类页头。
4. 建 `AppDialog`，合并 4 套对话框内容样式。
5. 导航与顶栏改造（UI-01/UI-02），这一步与主动能力页面一起做。
6. 响应式：先做 1024/1280 两档可用，移动端单独立项。

**可量化验收标准：**

- `rg "<button" src --glob "*.vue"` 结果中，除拖拽/特殊容器外为 0；按钮统一走 `AppButton`。
- 图标按钮 `aria-label` 覆盖率 100%；`title` 仅作补充提示。
- 所有异步视图三态覆盖率 100%（用 grep + 单测双校验）。
- CSS 中令牌区外硬编码颜色 = 0；静态 `style=` = 0。
- 1024×768 / 1280×800 / 1440×900 三档无横向滚动、无遮挡。
- 关键 8 个页面进入视觉基线，CI 像素差异阈值 ≤0.1%。

---

## 5. 分阶段路线图

> 排期按 1 名熟悉本仓工程师计算；阶段内条目可并行给 2 人，但阶段验收门禁不变。

### 阶段 0：收口与地基（2 周，约 20 人日）

| 目标 | 改动点 | 验收标准 | 风险 |
|---|---|---|---|
| 安全与隐私收口 | Key 迁移到系统钥匙串或 0600 文件；移除 `--api-key` 传参改环境变量；`terminal.rs` 增加根目录约束与命令白名单；CSP 从 `null` 改为白名单 | 进程参数不含密钥；越界 `cwd` 被拒；CSP 无 `unsafe-eval` | 环境变量仍可能被子进程读取，需限制 env 继承 |
| 任务可靠性地基 | 抽出统一 `PiRunner`（拉起/超时/重试/事件落账）；补 3 次指数退避 | 模拟断网 20 次，任务成功率 ≥95%；重试日志可查 | 单 `Child` 模型需改造为受控池 |
| UI 一致性第一刀 | 新增 `AppButton/AsyncSection/AppPageHeader`；导航补「对话」；顶栏抽 `AppTopBar` 并用于项目工作台 | 三态覆盖 100%；模式切换器在对话与项目页均可见；原生按钮替换 ≥80% | 大范围替换易引入样式回归，需要视觉基线 |
| 可访问性 | 图标按钮补 `aria-label`；键盘走查 10 条主路径 | 10 条路径全程键盘可达；无焦点丢失 | 自研弹窗/菜单需逐个补焦点管理 |

### 阶段 1：主动服务 MVP（3 周，约 30 人日）

| 目标 | 改动点 | 验收标准 | 风险 |
|---|---|---|---|
| 定时任务 | 新增 `scheduler.rs` + `jobs.rs`；`jobs.json` 持久化；启动时恢复 | 3 种周期任务连续 7 天触发偏差 ≤60s；重启后状态一致 | 系统休眠导致错过触发，需补「补跑」策略 |
| 任务执行与恢复 | 复用 `PiRunner`；任务级状态机 pending/running/failed/done；失败重试 3 次 | 人为 kill 进程后，重启能标记中断并可选续跑 | 中断续跑需模型侧可恢复上下文，短期先做「重跑」 |
| 收件箱 | 新增 `inbox.rs` + `InboxView.vue`；未读/已读/归档 | 任务产物 100% 入箱；未读数准确 | 与现有 RunHistory 语义重叠，需明确边界 |
| 结果触达 | 引入 `tauri-plugin-notification`；点击通知直达对应任务 | 任务完成后 30s 内出通知；点击命中率 100% | macOS 通知权限需引导 |
| 无人值守策略 | 在工具门上增加「任务级预授权」：只读自动放行、写操作需预授权清单 | 未授权写操作执行次数 = 0；审批记录可审计 | 过度预授权会放大风险，需默认最小权限 |

**实现状态（2026-11-06，阶段 1 收尾）**

- 已落盘：`src-tauri/src/proactive.rs`（账本 + 单调度线程 + 启动恢复 + 收件箱 + 系统通知 + 通知定位目标）、`agent-tool-gate.ts`（任务级预授权硬边界 + 额度用量回写 + `proactive-audit.jsonl`）、`InboxView.vue` + `InboxView.css` 与侧栏入口（含未读角标）。
- 复用而非新建：执行走既有 `pi_bridge::start_kernel` / `send_prompt`，并发判定读 `PiState.running_since`（即 `pi_status`），结果从既有 journal 增量读取。
- 通知点击：桌面通知无可靠点击回调，改用「通知发出后 90 秒内应用首次获得焦点」作为点击代理（`proactive_take_focus`），前端定位到 `/inbox?job=&item=` 并滚动高亮、自动标已读。**边界**：应用已在前台时点通知不会产生窗口焦点事件，因此不跳转——这是代理方案的天花板，接入原生通知点击回调前不会改善。
- 预授权编辑：任务卡片「预授权」弹窗可改 bash 命令前缀白名单与单次风险动作额度（20/40/80/200），保存即时生效；执行中拒绝修改，写入根固定为项目目录。策略文件 15 分钟 TTL、任务结束清除、用户发消息清除，越界一律 block。
- 长跑验证（缩短尺度）：`scheduler_does_not_drift_over_1000_cycles` 以 60s 周期模拟 1000 次「每次晚 5s 才执行」，断言 `next_at == 1000 × 周期`，零累积漂移；`mark_done_catches_up_without_double_run` 覆盖错过周期不补跑。等价于 7 天量级的调度推进逻辑，真机 7 天观察仍留作上线前例行检查。
- 后台驻留（条目 3）：`background.rs` + 托盘菜单 + 登录项 + 单实例。关窗行为首次询问并持久化到 `background.json`，设置页可改回「每次询问」；驻留态调度线程与账本照常，内核空闲 5 分钟且窗口隐藏时回收，任务到点由 `start_kernel` 重拉；彻底退出（托盘 / Dock / Cmd+Q）停内核并清理预授权策略文件；启动 `recover` 继续把 Running 标 Interrupted 重排。值守边界不变：执行态不回收内核，暂停只拦执行、不推进 `next_at`。
- 明确未做：外部 IM/邮件/webhook 通道；系统级守护进程（应用彻底退出期间不调度，登录项只在下次登录恢复）。


### 阶段 2：记忆与个性化（3 周，约 28 人日）

| 目标 | 改动点 | 验收标准 | 风险 |
|---|---|---|---|
| 语义召回进 Agent | 把 `memory_vec` 检索暴露为 Pi 工具（走本地 HTTP 桥或 MCP），替换/并行词面召回 | 同义改写查询 Top5 命中率 ≥80%（固定 100 条评测集） | embedding 服务不可用时需优雅降级到词面 |
| 用户画像 | 新增 `profile.json`：身份、语言、时区、工作习惯、禁忌；设置页可编辑 | 画像字段被注入系统提示；关闭后不注入 | 画像膨胀占 token，需要摘要压缩 |
| 记忆纠错 | `MemoryView` 增加编辑/删除/合并；写入带来源与置信度 | 删除后 1s 内召回不可见；操作有审计记录 | 与 Pi 进程内缓存一致性 |
| 跨会话续跑 | 持久化会话摘要 + 最近 N 轮；新会话可「接着上次」 | 重启后继续对话，关键事实保持 ≥90% | 摘要失真，需要可回溯到 journal |

### 阶段 3：全球化（3 周，约 28 人日）

| 目标 | 改动点 | 验收标准 | 风险 |
|---|---|---|---|
| 多语言 | 引入轻量 i18n；字符串 key 化；`<html lang>` 动态 | 中英双语 100% 覆盖；无硬编码中文漏网 | 文案量大，需分批 |
| 时区/币种 | 设置项 + 格式化工具；定时任务按用户时区 | 跨 3 个时区用例正确；金额按币种格式化 | 夏令时边界 |
| 远程 MCP | 接入 streamable-http（`connectors.rs:403`） | 至少 1 个云端 MCP 端到端可用 | 鉴权/重连/超时 |
| 合规/数据驻留 | 数据分类、导出/删除、CSP 白名单 | 可导出并删除本地用户数据；CSP 无 `unsafe-eval` | 与本地优先定位的边界 |

### 排期总览

| 阶段 | 周期 | 人日 | 关键依赖 |
|---|---|---|---|
| 0 收口与地基 | 2 周 | 20 | 无 |
| 1 主动 MVP | 3 周 | 30 | 阶段 0 的 `PiRunner` |
| 2 记忆个性化 | 3 周 | 28 | 阶段 1 的任务账本 |
| 3 全球化 | 3 周 | 28 | 阶段 1/2 稳定 |

合计约 **106 人日**；若含移动端，追加约 **20 人日**。

---

## 6. 不建议做的事

1. **不要自研 Agent 主循环。** Pi 已经是内核；重造会同时失去工具生态与升级路径。
2. **不要为「主动」先做移动端。** 桌面 + 通知 + 收件箱先闭环，移动端是放大器，不是地基。
3. **不要引入大而全 UI 框架替换现有令牌体系。** 现有令牌质量高于平均水平，缺的是组件层，不是换皮肤。
4. **不要自研浏览器内核/CDP。** 优先接 Playwright 或系统 Chrome 的受控会话；先补「能点能填」即可。
5. **不要为全球化先做全量翻译。** 先 key 化 + 英文，其他语言按需。
6. **不要重写检查点去覆盖 bash 变更。** 成本高收益低；明确告知边界即可。

---

## 7. 度量看板（改造后持续跟踪）

| 指标 | 现状 | 阶段 1 目标 | 阶段 3 目标 |
|---|---|---|---|
| 主动任务成功率 | 不适用（无任务） | ≥95% | ≥98% |
| 定时触发偏差 | 不适用 | ≤60s | ≤30s |
| 未授权写操作次数 | 无法统计 | 0 | 0 |
| 任务可恢复率（重启后） | 0 | 100% 可查，≥80% 可续跑 | ≥95% |
| 首次结果触达时延 | 不适用 | ≤30s | ≤10s |
| 三态覆盖页面 | 2/10 三态齐全（Chat、ProjectWorkspace） | 100% | 100% |
| 图标按钮可访问名称覆盖 | 全局仅 9 处 `aria-label` / 229 个按钮 | 100% | 100% |
| 令牌区外硬编码颜色 | 3 处 | 0 | 0 |
| i18n 覆盖 | 0% | 0% | 100%（中英） |
| 单任务成本可见 | 仅总量 | 按任务归集 | 预算 + 熔断 |

---

## 8. 证据索引

| 主题 | 位置 |
|---|---|
| IPC 命令注册 | `src-tauri/src/lib.rs:94` 起（116 条） |
| Pi 启动参数 | `src-tauri/src/pi_bridge.rs:297`、`:301`、`:314`、`:324` |
| 单子进程状态 | `src-tauri/src/state.rs:11-13` |
| 记忆存储与词面召回 | `src-tauri/extensions/agent-memory.ts:9-10`、`:24`、`:167` |
| 向量召回边界 | `src-tauri/src/memory_vec.rs:17-18` |
| MCP HTTP 未接 | `src-tauri/src/connectors.rs:403` |
| 沙箱宿主机回落 | `src-tauri/extensions/sandbox-env.ts:156` |
| 浏览器能力边界 | `src-tauri/extensions/agent-browser-session.ts:9-13` |
| 终端无根约束 | `src-tauri/src/terminal.rs:9-14` |
| 文件根约束 | `src-tauri/src/fs.rs:19-44` |
| 检查点边界 | `src-tauri/src/checkpoint.rs:5-6` |
| 用量聚合 | `src-tauri/src/governance.rs:277` |
| 回放能力 | `src/composables/useReplay.ts:15-21` |
| 导航结构 | `src/components/layout/Sidebar.vue:42-46`、`:97`、`:220` |
| 对话页头 | `src/views/ChatView.vue:26-41` |
| 项目页头 | `src/views/ProjectWorkspace.vue:386-399` |
| 设计令牌 | `src/styles/base.css:12-19`、`:40-46`、`:69-70`、`:93-99`、`:123-150` |
| 颜色越界 | `src/components/layout/Sidebar.css:488`、`:494`；`index.html:7` |
| 弹窗可访问性 | `src/components/ui/AppModal.vue:22-88` |
| 桌面窗口约束 | `src-tauri/tauri.conf.json:18-19`、`:23` |

---

## 9. 文档状态

- 状态：**评估完成**（只读审计；未修改业务代码；未做运行态视觉与性能验证）
- 审计基线：`bd7c14f`（2026-10-23），Pi `0.87.1`
- 生成日期：**2026-11-06**
