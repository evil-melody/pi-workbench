# pi-workbench（Pi 内核） vs WorkDSH / DSH 生态 功能逐点对照

> 目标：以 **Pi 为内核核心**，把用户的 `pi-workbench`（Tauri2 + Vue3 + `pi --mode rpc`）
> 与开源的 **WorkDSH / DeepSeek Harness（dsh）生态** 做逐功能对比。
> 特殊焦点：**「中间输入框 → 运行」的那层 harness（执行内核）**。
>
> 资料来源：
> - WorkDSH 项目介绍（163.com / juejin.cn / exmay.com / cnblogs.com，2026-10 公开文章）
> - DSH 插件生态全景（cnblogs.com/bbqq1314，11 插件梳理）
> - dsh.so 工件页（dsh-tauri 安装/兼容性矩阵）
> - GitHub：techflag/workdsh、deepseek-ai/deepseek-harness、TommyFang2077/pi-workbench
> - 本仓库代码：src-tauri/src/{pi_bridge,agent_ops,extensions,codebase}.rs、src/composables/{usePi,useProject}.ts

---

## 0. 对比对象界定（避免同名混淆）

| 项目 | 内核 | 桌面壳做法 | 阵营 |
|------|------|-----------|------|
| **本仓库 pi-workbench**（用户） | **Pi**（`pi --mode rpc`） | Tauri2 + **原生 Vue3 webview**（自绘 UI） | Pi-core 工作台 |
| **WorkDSH**（techflag） | DeepSeek Harness（**dsh** CLI） | 能力全靠 dsh 插件扩展，官方 WebUI 复用 | dsh 生态 |
| **DSH Desktop / dsh-tauri**（smallhug） | dsh CLI | Tauri2 + **iframe 复用官方 WebUI** | dsh 生态桌面壳 |
| **TommyFang2077/pi-workbench** | dsh CLI | Tauri2 + iframe WebUI（实为 dsh 壳） | **属 dsh 生态**，与本仓库同名异物 |

结论：用户的 Pi 内核项目，对比的是「整个 dsh 生态（WorkDSH + 11 插件 + DSH Desktop）」。
下面把 dsh 生态统称为 **DSH**。

---

## 1. ★ 焦点：中间输入运行的 Harness（执行内核）

这是用户最关心的「输入框内容怎么被跑起来」。

### 1.1 DSH（DeepSeek Harness）的 harness 链路
```
用户输入（官方 WebUI / TUI / DSH Desktop iframe）
   │  "附件、输入和发送继续使用 Harness 原生能力"
   ▼
DSH Tauri 桥接插件（dsh-tauri：提供 Tauri↔harness 通信通道）
   │
   ▼
dsh 子进程（DeepSeek Harness 运行时）
   │  ├─ Cordis 插件系统（一切皆插件，官方/第三方同一套 API）
   │  ├─ profile 机制（按 web/desktop/tui 加载不同插件集）
   │  ├─ agent loop：工具调度 / 多轮编排 / 中断恢复
   │  ├─ 能力：文件读写、受控 shell（超时/截断/危险命令拦截）、MCP 工具
   │  └─ 会话持久化 → 本地 SQLite（可回溯）
   ▼
流式结果原路返回到 WebUI
```
- **进程模型**：DSH Desktop「检测到 3080 端口已有实例就复用，没有就自己拉子进程，
  且只回收自己启动的进程」——生命周期由桌面壳管理，harness 是常驻 dsh 进程。
- **插件是内核一等公民**：Cordis 插件可 hook harness 内部（如 `ctx.betterSidebar`
  服务对外开放，任意插件能注册 tab/viewer），能力对等。
- **输入/发送是 harness 原生**：WorkDSH 文档明确「附件、输入和发送继续使用 Harness 原生能力」，
  即中间输入框由 harness 自己的协议处理，外壳只负责把字节喂进去。

### 1.2 pi-workbench（Pi）的 harness 链路
```
用户输入（原生 Vue ChatView 输入框）
   │  ComposerStatus 显示「转圈/已索引/中断」——回答「有没有在跑」
   ▼
Tauri invoke('pi_send', {type:'prompt', message})  ← 控制面走 pi_call
   │
   ▼
Rust pi_bridge.rs —— 起并管理 pi 子进程（RPC 模式）
   │  ├─ Command::new("pi") --mode rpc --no-session
   │  ├─ 每个 --extension 注入 Pi agent runtime（sandbox-env / role-inject /
   │  │   agent-teams / agent-memory / agent-skill-pool / agent-browser-session / agent-codebase）
   │  ├─ 签名复用：cwd+provider+model 不变 → 复用子进程；变了 → 重启
   │  ├─ stdin/stdout 全双工 JSON-RPC：
   │  │     pi_call  → 按 id 等专属响应（#[tauri::command(async)]，30s 超时门，防主线程冻结）
   │  │     pi_send  → fire-and-forget 下发 prompt
   │  └─ 流式事件 → app.emit("pi://event") 推到前端
   ▼
前端 usePi：listen('pi://event') 消费流式；applyEvent 渲染消息/树/用量
   │
   ▼
Pi agent runtime 执行（调用 extension 注册的 tool / 内部能力）
   │  人面（面板）与 agent 面（工具）共享 <app_config_dir>/.pi/<kind>/ 状态
   ▼
结果经 pi://event 流回 Vue 渲染
```

### 1.3 两核 harness 逐项差异

| 维度 | DSH（dsh CLI） | pi-workbench（Pi） |
|------|---------------|-------------------|
| 内核身份 | DeepSeek Harness（dsh） | **Pi**（`pi --mode rpc`） |
| 桌面壳↔内核协议 | DSH Tauri 桥（Tauri↔harness 私有通道） | **JSON-RPC over stdin/stdout**（`pi_call`/`pi_send` ↔ `pi://event`） |
| 内核可插拔性 | Cordis 进程内插件，可 hook harness 内部 | Pi extension（`--extension` 注入 agent runtime，注册 tool/command） |
| 输入/发送归属 | harness 原生能力 | 前端 `pi_send` → Rust 桥 → Pi `prompt` 命令 |
| 多实例/重启 | 端口复用 + 子进程回收 | 签名复用 + `pi_restart`（换模型/工具白名单后重建） |
| 主线程冻结防护 | 壳侧管理子进程 | `pi_call` 强制 `#[tauri::command(async)]` + 30s 超时 + 源码级回归测试守卫 |
| 会话持久化 | 本地 SQLite | Pi 会话树（`get_tree`/`fork`）+ `.pi/` 状态目录 |
| 桌面 UI 来源 | **iframe 复用官方 WebUI**（DSH Desktop） | **自绘原生 Vue**（ChatView / ComposerStatus / 项目详情页） |
| 中间态可见性 | 官方 0.2.0 改进「对话状态展示」 | ComposerStatus 常驻状态行 + 过程抽屉（前几轮已做） |

**关键判断**：两边 harness 都是「外壳管理一个常驻 agent 子进程 + 把用户输入喂进去 + 流式回传」。
差异在 (a) 内核是谁（dsh vs Pi），(b) 壳↔核协议（私有桥 vs JSON-RPC stdin/stdout），
(c) UI 是自绘还是 iframe 复用官方 WebUI。pi-workbench 在 (c) 上更可控但工作量更大——
前几轮大量 UI 修复正源于此。

---

## 2. 功能逐点对照表（DSH 生态 ↔ pi-workbench）

状态图例：✅ 已实现 ｜ 🟡 部分/雏形 ｜ ❌ 缺口 ｜ — 不适用

| # | 功能 | DSH 生态（公开能力） | pi-workbench（Pi 内核） | 差距 |
|---|------|---------------------|------------------------|------|
| 1 | **核心运行时 harness** | DeepSeek Harness（dsh CLI，~0.2.0-rc） | Pi（`pi --mode rpc`）✅ | 内核不同，架构对等 |
| 2 | **桌面外壳** | DSH Desktop：Tauri2 + iframe 复用官方 WebUI | Tauri2 + 原生 Vue webview ✅ | pi 自绘 UI，可控性高 |
| 3 | **插件/扩展机制** | Cordis 插件 + profile，一等公民 | Pi extension（`--extension`，registerTool/Command）✅ | 粒度不同：Cordis 可 hook 更深 |
| 4 | **项目管理** | 集中管理任务/计划/资产/活动 ✅ | projects.rs + useProject ✅ | 对等 |
| 5 | **本地资料库** | 导入/浏览/搜索/预览，引用修订 ✅ | LibraryPanel + library.rs（树/发布/回滚/检索/记忆 tab）✅ | 已对等 |
| 6 | **技能 Skills** | 安装可复用技能，发布专家配置 ✅ | agent-skill-pool（SKILL.md 池）+ skills 管理 ✅ | 基本对等 |
| 7 | **专家 Experts** | 固定能力修订的专家配置 ✅ | 能力中心专家 tab（左列表+右编辑+导入+头像+发布态+市场池）✅ | 已对等（§5.14 勘误：原记 RoleSwitcher 时代） |
| 8 | **连接器 / MCP** | 配置 MCP 服务，明确选择能力 ✅ | ConnectorPanel（列表/启停/按会话选择/注入内核白名单 + 孤儿 MCP 工具）✅ | 已对等 |
| 9 | **会话树 / 多轮编排** | 多步拆解、中间结果、中断恢复 ✅ | Pi 会话树 `get_tree`/`fork` ✅ | 对等 |
| 10 | **多智能体 / 团队** | 专家团（名称展示，未必多成员真跑） | agent-teams（成员+策略+调度日志）✅ | pi 有真实 team 定义 |
| 11 | **长期记忆** | graph-memory（知识图谱+PageRank，token↓75%） | agent-memory（ts/text/tags 追加流）+ LanceDB 语义向量检索（B5）✅ | 词面+语义双通道；图谱形态不同，不缺召回 |
| 12 | **视觉 / 多模态** | ModLens（结构化 JSON 证据，6 provider failover） | 输出侧有（browser_screenshot / ArtifactPreview image / useOfficePreview）🟡；**输入侧已接**：ChatView 附件入口 + `attachment_add` 落盘 + 路径引用块喂 Pi（真·视觉理解待内核支持 content block） | 🟡 输入已接 / 真视觉待内核 |
| 13 | **浏览器自动化** | dsh-browser（接管已登录 Chrome，序列化 DOM） | agent-browser-session（开真实浏览器+状态）🟡 | pi 偏外部跳转，缺 DOM 注入 |
| 14 | **代码库索引** | 未见于公开 dsh 生态（属第三方可写） | **agent-codebase**（codebase-memory-mcp 索引+检索）✅ | **pi 独有，已实测 3130 节点/8836 边** |
| 15 | **文档/Office 产出** | Office/PDF 工作副本预览编辑 ✅ | useOfficePreview（docx-preview / SheetJS 真实库，docx+xlsx 预览）✅；pptx/pdf 仅外开 | 已对等 |
| 16 | **活动/过程可见性** | 官方 0.2.0 改进对话状态展示 | ComposerStatus 常驻状态行 + 过程抽屉 ✅ | pi 更强调「有没有在跑」 |
| 17 | **会话导入/迁移** | dsh-chat-import（16+ 工具全导入） | ✅ `conversation_export/import` + 版本化 JSON + 严格校验 + UI | 已对等 |
| 18 | **插件市场/发现** | dsh-market（1550+ 插件可视化市场）+ dsh-find-plugins | PluginsView（发现/标签/搜索/启禁/直链安装/诊断）+ Pi 托管包透传（`pi install/list/update/remove`，V18）+ 生态四卡一键装 ✅ | 已对等（服务端仍无，客户端透传 pi 官方源） |
| 19 | **桌宠娱乐层** | Awesome DSH Pet | ❌ 无 | 非核心，缺口可接受 |
| 20 | **自更新/打包** | 应用内自更新，Win/macOS/deb/rpm/Flatpak | Tauri 打包（前几轮验证过构建）🟡 | 自更新未接入 |
| 21 | **模型后端** | DeepSeek 系默认，可接公司模型 | 可配 provider/model/api_key（models.rs）✅ | 对等，pi 不绑死厂商 |
| 22 | **安全/权限** | 危险命令拦截、白名单市场、lifecycle 审查 | 扩展文件名白名单、工具白名单、`.pi/` 隔离 ✅ | 对等 |

---

## 3. 以 Pi 为核心的下步收敛优先级

> ⚠️ **勘误（2026-10-05）**：本节初稿把 #5/#15/#18 标为「缺口」、#12 标为「无视觉模块」，
> 经交叉核对 `src/` 真实代码后发现**与事实不符**——`LibraryPanel`/`library.rs`、
> `PluginsView`/`extensions.rs`、`useOfficePreview`（docx-preview / SheetJS）均已实现并接真实 IPC。
> 已据实修正 §2 表格。下面只列**经代码核实仍真实缺失**的项。

按「DSH 已有、pi-workbench 经核实仍缺、且价值高」排序：

1. 🔴 **会话导入/迁移（#17）**：DSH 有 `dsh-chat-import`（16+ 工具全导入）。
   pi-workbench 此前**无任何会话/对话的导出或跨机迁移**命令与 UI——这是初稿唯一被核实确缺的「功能级」能力。
   **已于 2026-10-05 补齐**：`conversation.rs`（`conversation_export`/`conversation_import`）+ `useConversationIO.ts`
   （版本化 JSON 序列化 + 严格校验）+ ChatView 导出/导入按钮 + 6 条 vitest 往返测试，全闸门通过。
2. ✅ **多模态输入侧（#12 输入）—— 已于 2026-10-05 接通**：DSH 明确「附件继续用 Harness 原生能力」。
   pi 内核 `pi --mode rpc` 的 `prompt.message` 当前**只接受字符串**（实证：传 content 数组报
   `text.startsWith is not a function`），故采用**引用路径绕行**：ChatView 回形针选图/文件 →
   `attachment_add` 复制进 `app_config_dir/attachments` → 缩略图预览 → 发送时把路径引用块
   （`- image: <path>` / `- file: <path>`）追加进 prompt 文本交给 Pi。
   **真·视觉理解**（VL embedding 式图像理解）需等 Pi 内核支持多模态 content block 后再翻，属内核侧能力而非工作端缺口。
   含 `buildPrompt` 纯函数单测 + `useConversationIO` 附件往返单测 + 会话迁移携带附件。
3. 🟡 **专家做成市场级（#7）**：RoleSwitcher/role-inject 是轻量角色注入，未成「可发布/可检索」的专家市场。
4. ✅ **MCP UI 选择（#8）—— 初稿误判，实际已完成**：`ConnectorPanel.vue` 提供连接器列表/启停、
   **按会话选择**（`connectorsSelection`/`connectorsSetSelection`/`connectorsApplyScope`）、
   「应用到内核白名单」注入，以及**孤儿 MCP 工具**勾选写内核白名单（`toolsActivate`）。
   这正是「明确勾选启用哪个 MCP 能力」，故从缺口移除。
5. 🟡 **浏览器 DOM 注入（#13）**：`agent-browser-session` 开真实浏览器+状态，缺 dsh-browser 式的 DOM 序列化注入。
6. ⚪ **自更新（#20）/ 桌宠（#19）**：低优先级，可后置或社区贡献。

**pi-workbench 已建立的相对优势（应保持/放大）**：
- 代码库索引 `agent-codebase`（实测建库成功，DSH 公开生态未见对等物）；
- 人面/agent 面共享状态的干净模型（`agent_ops.rs` + extension 共根 `<app_config_dir>/.pi`）；
- 主线程冻结防护的源码级回归测试（`blocking_commands_must_be_declared_async`）；
- 过程可见性（ComposerStatus）直接回应「有没有在跑、查没查」。

---

## 4. 验证现状（pi-workbench 已过的闸门）

> 数字为撰写时快照，**当前一律以闸门输出为准**；复现：
> `pnpm typecheck` · `pnpm build` · `pnpm test` · `node scripts/visual-check.mjs` · `cd src-tauri && cargo check && cargo test`

- `cargo test` 全绿 ✅（含 `attachments` sanitize/uniquify、pi 可执行文件探测/子进程 PATH 单测；通过数以闸门输出为准）
- `pnpm typecheck`（vue-tsc --noEmit）✅ · `pnpm build`（vite build）✅
- `pnpm test`（vitest）全绿 ✅（含 `buildPrompt` 路径引用单测 + `useConversationIO` 附件往返单测）· `node scripts/visual-check.mjs`（verify:ui）全绿 ✅
  （含「内核不可用：错误落进消息流」断言，锁住「点了没反应」不再复现）
- 真实建库实测：`codebase-memory-mcp index_repository` → 3130 节点 / 8836 边（当次实测快照，重复执行以输出为准）✅
- `graphify update`（节点/边数以当次输出为准）

### 内核启动的硬约束（实证，非推测）

桌面进程（macOS GUI）的 PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，而 `pi` 装在
`~/.workbuddy/binaries/node/versions/*/bin` 之类的目录里，且是 `#!/usr/bin/env node` 包装：

| 场景 | 实测结果 |
|---|---|
| 用 GUI 那份 PATH 直接跑 pi | `env: node: No such file or directory` |
| 注入 pi 目录 + Node 目录后 | pi 正常启动（输出 usage） |

因此 `pi_start` 必须做两件事：`resolve_pi_bin` 按绝对路径探测（设置 → `PI_BIN` → 常见目录 → PATH），
以及 `pi_path_env` 把 Node 目录注入子进程 PATH。只修其一仍会静默失败。

---

## 5. 对话页显示形态对齐 dsh（2026-10-31）

> 参照物：`/tmp/dsh-ui` 编译产物 + `/tmp/workdsh-src/assets/desktop-chat-zh.png`。
> 本节只记 **UI 形态**对齐；§1–§2 的 harness/功能对照不受影响。
> `docs/alignments/` 是归档目录（只描述当时的中间状态），故本轮记录写在这里。

### 5.1 已对齐

| dsh 形态 | 本仓落地 | 文件 |
|---|---|---|
| 一轮回复 = 一个 turn 聚合块（Think 行 → 正文 → 工具行 → 文件改动 → 统计），无逐条消息头像 | `rows` computed 把连续 assistant 消息并成一个块；旧的 `cont` 负 margin 拼接 hack 随之删除 | `src/components/chat/MessageList.vue` |
| Think 单行折叠条：图标 + `Think` + `·` + 一行摘要（dsh `ReasoningRow`：运行中 = `latestLine`，落定 = `firstLine`） | `CollapsibleRow`（Think 行与工具行共用）+ `latestLine()`（trimEnd 后取最后一个 `\n` 之后）+ `firstLine()`；摘要由 `thinkSummary()` 按两档选 | `CollapsibleRow.vue` / `MessageList.vue` |
| 工具单行折叠条：图标 + 工具名 + `·` + 参数摘要，展开看参数/结果 | `PiMsg.toolArgs` / `toolResult` / `toolError`，按 callId 回填，找不到占位 chip 就静默跳过 | `piEvents.ts` |
| 用户消息右对齐气泡 + 气泡外一个小复制图标 | `.msg-row.user` + `copyMsg()`（clipboard，回显「已复制」1.5s） | `MessageList.vue` / `MessageList.css` |
| 「本轮文件改动」汇总行 + 文件名列表（逐文件展开 diff 保留） | turn 尾部 `.msg-files`，「bash 产生的变更不跟踪」说明保留 | 同上 |
| composer 下一行灰字统计：`{turns} 轮 · {steps} 步` / `输入 X tok · 输出 Y tok` / `缓存命中 Z%` / 费用，段间 ` \| ` 分隔、缺数据的段不渲染 | `statsSegments()` 纯函数，文案照抄 dsh i18n；turns/steps 由 ChatView 以 props 传入 | `piEvents.ts` + `ComposerStatus.vue` / `ComposerStatus.css` |

### 5.2 数据层实证（内核 `@earendil-works/pi-coding-agent` 实装 0.87.1）

| 结论 | 出处 |
|---|---|
| **`tool_execution_end` 真实存在**，带 `{toolCallId, toolName, result, isError}` → 工具结果文本已落 `toolResult` | `dist/core/extensions/types.d.ts:689-695` |
| **thinking 流真实存在**：provider 转换器把 `thinking_start/delta/end` 原样透传进 `assistantMessageEvent`，文本累积成 `{type:"thinking",thinking}` 内容块 | `dist/bundle/chunks/pi-messages-*.js`（`case"thinking_delta"`）、`chunk-OJP47DM6.js` |
| RPC 模式**全事件透传**，Rust 桥只做 response/事件二分，故上述两类事件确实到达 `pi://event` | `dist/modes/rpc/rpc-mode.js:266` `output(toJsonEvent(event))` |
| ⚠️ 与仓库旧注释分歧：0.87.1 把 `toolcall_start` 改写为顶层 `{...deltaEvent, id, toolName}`，即 **start 已带工具名**；「start 普遍无名」只适用于旧版 | `dist/modes/json-event.js` |

据此 `piEvents.ts` 同时接受两种形状：取名先看 `toolCall.name` 再看顶层 `toolName`，并**无条件记录 `toolCallId`**——参数/结果回填只按 id 精确命中，兜底路径仅认仍是占位名的 chip，避免给已完成的 chip 错挂下一轮的参数。

### 5.3 未对齐 / 留待后续

> **状态勘误（2026-11-23，§5.14 核对）**：本表撰写于 10-31，四项中三项的状态已变化，按当前代码修正如下；表保留原文语义，标注以 §5.14 为准。

| 项 | 原因 | 当前状态 |
|---|---|---|
| dsh 统计行的 `LLM {duration}` / `首 token 平均 {duration}` / `{throughput} tok/s` | 内核 `Usage` 只有 token/cost 字段，**没有逐轮时间戳**；拿不到就不编。要做得补 `turn_start/end` 计时或前端自计时间 | **部分已落地**：桥侧 `pi_run` 已给每条事件打 `pi_ts` + run/span 信封，RunGraph 逐节点画环节耗时（model 段 = LLM 耗时），头部画全程耗时——撰写时「没有时间戳」的前提已失效。**仍缺**：首 token 到达时刻与逐轮 token 速率内核不给事件，无数据源，继续不编 |
| 回复末尾反馈行（赞/踩、复制全文） | 复制已在 §5.6 落地；赞/踩经实证 dsh 也无此图标，且本仓无反馈落库 → 不做 | 不变 |
| Session log 导出为可读文本 | 现有 `conversation_export` 是迁移用 JSON，非 dsh 那种逐轮日志 | **已收口（§5.14）**：顶栏「转写」键 → `formatConversationLog` 纯函数 + `exportConversationLog`，落 `.txt` 走同一个 `conversation_export` |
| todo 投影卡（计划卡之外的待办清单） | 现只有 G5 计划卡，内核 todo 事件未接 | **已落地**：`todoList.ts` 从 assistant 回复的 markdown 复选框解析任务，`WorkflowPanel` 接进轨迹抽屉「工作流」页签——设计上不依赖内核 todo 事件（内核没有这种事件），直接读模型已写出来的清单 |

### 5.4 本轮显示细化（2026-10-31 第二轮，取值来自 `/tmp/dsh-ui` 编译 CSS）

| 用户可见问题 | 修法 | dsh 编译包实证 |
|---|---|---|
| 工具行过重：行高大、参数等宽字体占满整行、长工具名把摘要挤出容器（整列横向滚动条） | `.crow-head` 收成 24px 细行、`title` 改可收缩 + ellipsis、摘要用正文字体、图标/文字压到 `--text-faint`、分隔符改为画出来的 2×2px 圆点 | `.o3BgMG_summary{line-height:24px;font-size:14px;text-overflow:ellipsis;min-width:0}`、`.o3BgMG_title{font-weight:400}`、`.o3BgMG_sep{width:2px;height:2px;border-radius:1px;margin:0 8px}` |
| 展开体撑破父级 | `.crow-body` 改 label/内容两列 grid（`max-content` + `minmax(0,1fr)`）、260px 限高滚动；`pre` 走 `break-word` + 列内 `overflow-x:auto` | `.o3BgMG_ioSection{grid-template-columns:max-content 1fr;column-gap:14px;padding:12px 16px}`、`.o3BgMG_bodyScroll{max-height:260px}` |
| 正文排版：标题与段落粘连、markdown 样式整体失效 | `.md` 补 14px/1.7 与 h1–h4 间距阶梯；**修 scoped 死代码**——v-html 注入的 HTML 不带 scope 属性，`.md code` 之类永不命中，全部改走 `:deep()`；code/pre/table 限宽在列内自持滚动 | `.hWmORq_root{font-size:14px;line-height:24px}`、`.o3BgMG_ioText{word-break:break-word;min-width:0}` |
| 过程行与正文的间距节奏 | 块内 4px、正文前后 10/14px，`.msgs` 块间距 20→16px | `.EvIC1a_flowItem{min-width:0}` + `--dsh-chat-flow-gap:8px/16px` |
| 文件改动块 / usage 行 / 空状态偏重 | 弱背景 + `--border-soft` 描边、`.files-head`/`.plan-head` 去底色、`.msg-usage` 去 pill、`.empty-icon` 去描边 | `.o3BgMG_ioCard{background:var(--dsw-alias-markdown-code-block)}`、`.Q51KRG_trigger{background:0 0;border:none;tabular-nums}` |
| composer 与统计行 | `.input-wrap` 圆角 16→20px、阴影改主题令牌（原手写 rgba 在浅色主题几乎不可见）；统计行 11→12px/20px、去 mono、竖线两侧留白 | `.uV2eYG_card{border-radius:22px;box-shadow:var(--dsw-shadow-lv2)}`、`.FJxK0a_root{font-size:12px;line-height:20px}`、`.FJxK0a_sep{margin:0 10px}` |
| 顶栏三枚按钮是同一视觉族的三份拷贝（铁律：零重复） | `.trace-toggle` / `.plan-toggle` / `.io-btn` 合并为一组选择器，高度 30→28px | `.Q51KRG_trigger{height:28px;padding:6px 8px;border-radius:28px}` |
| 上一轮 turn 聚合把「回到此处」按钮类名从 `rewind-btn` 改成 `ghost-btn`，`verify:ui` G3 断言超时（51/95 后失败） | 恢复语义钩子：按钮类名写成 `ghost-btn rewind-btn`（样式仍由 `.ghost-btn` 负责，`rewind-btn` 只作测试锚点）→ 95/95 全绿 | — |

> 复现要点：`verify:ui` 渲染的是 `dist` 产物，改完 `src/` 必须先 `pnpm build` 再跑，否则断言跑的是旧包。

留待后续：dsh 的工具摘要做过语义化（`SUMMARY_KEYS` 按工具挑 `description/path/query` 等字段 + `relativizeToCwd` 剥工作区前缀 + `firstLine()`），本仓 `oneLine()` 仍是原始 JSON 首行——属呈现层逻辑改动，本轮只动样式。**→ 已在 §5.5 落地。**

### 5.5 第三轮：工具行语义摘要 1:1 + 左栏记录倒序（2026-10-31）

**实证出处**：`/tmp/dsh-ui/deepseek-ai-dsh-client-ui-tool-0.0.1-rc.1/package/lib/client.js`（单行压缩产物，逐段提取）。dsh 工具行是「图标 + 标题 · 摘要」，摘要算法四件套：

| dsh 符号 | 实际内容（原样） |
|---|---|
| `TOOL_VARIANTS` | `bash/pwsh→bash`、`read/web_fetch/cordis_inspect→read`、`web_search/grep/glob→search`、`write→write`、`edit→edit`、`run_code/cordis_mount→code`、`cordis_unmount→others` |
| `VARIANT_TITLES` | `search:"Search"` `read:"Read"` `bash:"Bash"` `write:"Write"` `edit:"Edit"` `code:"Code"` `others:"Tool call"`（设计字面量，不翻译） |
| `TOOL_TITLES` | `cordis_inspect:"Inspect"`、`cordis_mount:"Mount temporary Plugin"`、`cordis_unmount:"Unmount temporary Plugin"`、`pwsh:"Pwsh"` |
| `SUMMARY_KEYS` | `bash:["description","command"]` `read:["path","file_path","url"]` `search:["query","pattern","url"]` `write:["path","file_path"]` `edit:["path","file_path"]` `code:["description"]` `others:[]` |
| `relativizeToCwd(text,cwd)` | `root=cwd.replace(/[/\\]+$/,"")`；仅当 `text` 以 `root+"/"` 或 `root+"\\"` 开头才 `slice(root.length+1)`，否则整串原样 |
| `deriveSummary(variant,argsRaw)` | 解析失败/非对象 → `firstLine(argsRaw)`；否则按 `SUMMARY_KEYS[variant]` 取第一个非空字符串 → `firstLine`；都取不到 → 遍历 values 取第一个非空字符串；再不行 → 原始参数首行 |
| `toolRowModel(...)` | `title = TOOL_TITLES[tool] ?? VARIANT_TITLES[variant]`；**只有** `variant==="others" && TOOL_TITLES[tool]===undefined` 时才把 wire 工具名前置成 `` `${toolName} · ${base}` ``；body 由 `deriveBody` 做 `JSON.stringify(parsed,null,2)` |

**分组折叠实证结论：dsh 没有这一层。** `ToolCallTree` 只在父子调用间缩进嵌套（`block.subCalls` → `.ztWv_q_subCalls{margin:4px 0 2px 22px;padding-left:8px;border-left:1px solid}`），同级调用各占一行；tool 包内 `ToolGroup` / `groupTool` / `steps` / `consecutive` / `batch` 命中数均为 0，`collapse*` 全部属于 terminal card 的展开收起，i18n key 集合里也没有 `tool.group` / `tool.steps`。→ 按「若无就不造」，本仓 `rows` 的 turn 聚合保持原样，未新增组折叠层。

**本仓落地**（`src/utils/toolSummary.ts` 纯函数模块，逐条照搬上表，另加 `VARIANT_ICONS` 就近映射到现有 AppIcon 图标名、`SUMMARY_MAX=240` 兜底长度）：

| 改动 | 文件 |
|---|---|
| `summarizeToolCall(tool,argsJson,root)` / `classifyTool` / `relativizeToCwd` / `deriveSummary` / `formatToolBody` | `src/utils/toolSummary.ts`（新） |
| 工具行不再显示参数 JSON：改绑 `:icon/:title/:summary`，摘要按 `tool+args+root` 做 Map 缓存（流式每条 `message_update` 都会重跑模板函数，不缓存就是重解析全部历史工具行）；展开体参数改 `formatToolBody()` 缩进 2 格（= dsh `deriveBody`） | `src/components/chat/MessageList.vue` |
| 左栏记录倒序：删掉 `listRunHistory` 里多余的 `.reverse()`（后端 `pi_bridge.rs` 的 `pi_journal_sessions` 已按 `pinned desc → index desc` 排好，前端再 reverse 把整列翻成「旧→新」，即截图里的现象），改为数据层显式排序 `pinned desc → (endedAtMs ?? startedAtMs) desc → index desc`；缺时间戳统一给 `-1` 参与比较，避免「小整数段号」和「毫秒时间戳」混在一个数值轴上 | `src/composables/useReplay.ts` |
| 行尾相对时间与排序同口径（取结束时间优先），否则长会话会顶着「13天前」插在最新行里像排序坏了；列表行高压到 30px、圆角 `--r`、hover 用 `--bg-hover` + `--border-soft`、「N 轮」降为低对比 pill、时间右对齐 `tabular-nums` | `src/components/chat/RunHistory.vue` / `RunHistory.css` |
| 对拍用例：`SUMMARY_KEYS` 原表断言 + 每个变体取字段优先级 + `relativizeToCwd` 五类边界（root 内 / root 外 / 同名前缀 `repo2` / 尾斜杠 / 反斜杠 / 无 root）+ 回落链 + 多行取首行 + 240 截断；`listRunHistory` 排序回归 6 例（倒序、置顶优先、段号≠时间、无时间戳兜底、过滤、includeArchived 透传、后端失败降级）；另加 MessageList 真实挂载 3 例（折叠行只有「标题 · 摘要」、整列不含参数 JSON、展开体是缩进 JSON + 结果、失败行带 `is-error`） | `tests/toolSummary.spec.ts`（新 23 例）/ `tests/replayQuery.spec.ts`（+6 例）/ `tests/messageListToolRow.spec.ts`（新 3 例） |

侧栏项目列表（`Sidebar.vue` 的 `sortedProjects`）本来就是 `(b.updated_at ?? 0) - (a.updated_at ?? 0)` 倒序，未动。

### 5.6 第四轮：工具行状态机 / 文件改动汇总 / turn 操作行 / 流式占位（2026-11-01）

**实证源**：`/tmp/dsh-ui/{c,v,t}/package/lib/client.js`（经 npm cacache 复原的单行压缩产物）——
`c` = `@deepseek-ai/dsh-client-ui-chat@0.1.2-alpha.2`、`v` = `dsh-client-ui-conversation@0.0.1-rc.1`、
`t` = `dsh-client-ui-tool@0.0.1-rc.1`。任务书给的基准截图 `desktop-chat-zh.png` 与 `projection.ts`
在本机已不可得，故本轮全部结论只来自编译产物字面量，逐条标出符号名 / CSS 类前缀可复查。

#### ① 工具行状态机（running / error / ok）

| dsh 实证出处（原样） | 本仓落地 |
|---|---|
| `t` 包状态机：`const state = !done ? "running" : block.error?.code === "interrupted" ? "stopped" : block.isError ? "error" : "ok"` | `toolRowState(m)`（`src/utils/toolSummary.ts`）保留同判定顺序：**失败优先于结果**，无结果且本轮未落定才 `running`，落定后兜底 `ok`。Pi 内核的 `tool_execution_end` 只带 `isError`、**没有 `error.code`**（`piEvents.ts` 实证形状 `{toolCallId, toolName, result, isError}`），所以 `stopped` 档没有数据源，只做三态——不为拿不到的状态造视觉（会话级「中断」相位另有 `useActivity.ts`，不在工具行） |
| `leadingFor$1(state, icon)`：`case "error": StateDot{state:"error"}` / `case "stopped": StateDot{state:"warning"}` / `default: icon` —— 即 running **不换图标**，只有失败/中断把行首图标换成状态点 | `CollapsibleRow.vue` 的 `state` prop：error 渲染 `<span class="crow-icon crow-dot">`（保留 `crow-icon` 供既有断言命中），running 仍显示原工具图标 |
| 扫光是 running 的唯一视觉信号：`width:300px;position:absolute;top:0;bottom:0;left:0;pointer-events:none;animation:2.6s ease-out infinite o3BgMG_dsh-tool-row-sweep`，渐变 `linear-gradient(90deg,transparent 0%, color-mix(in srgb, var(--dsw-alias-bg-base) 60%, transparent) 55%, transparent 100%)`，`@keyframes{0%{left:-300px}90%,to{left:100%}}`；bash 卡另有同款 `dsh-bash-row-sweep` | `CollapsibleRow.css` 的 `[data-state='running'] .crow-head::after`，按原式搬 300px / 2.6s ease-out / `color-mix(... var(--bg) 60%, transparent) 55%` / keyframes `-300px → 100%`；spinner 与弱色推导**未采用**（dsh 无此形态） |
| `stateStatus$1` 注释原文：`Visually hidden run-state label: the StateDot and the CSS sweep are both aria-hidden / colour-only, so assistive technology needs this text to know a row is running, failed, or interrupted. null in the ok state` | `STATE_TEXT` 映射 + `.crow-sr`（clip 式隐藏）输出「运行中 / 已失败」，`ok` 映射空串 → 不产出文本（同 dsh 的 `null in the ok state`） |

#### ② 「本轮文件改动」汇总行 + 文件 chip（选择行内展开，未做右面板）

| dsh 实证出处 | 结论 / 本仓落地 |
|---|---|
| `本轮文件改动`、文件 chip、`+x −y` 合计在三个包里 **0 命中**；dsh 的 turn 尾部内容走 `turnTail` slot（`c`/`v` 各 4 命中）注入，tool 包只在摘要位提供 `.o3BgMG_fileLink`（`text-overflow:ellipsis;font:inherit;color:label-tertiary`，hover 升 `label-primary` + 下划线）点开该文件 | 这一层 dsh 没有可直接抄的形态，任务书的「右面板预览 vs 行内展开」二选一里，**实证不支持右面板**：本仓 `ChatView` 也没有 ActivityPanel/ArtifactPreview 挂载点（预览入口在 `TraceDrawer` 抽屉内），接右面板要新开一条跨组件状态通道 → 按「改动最小」取**行内展开** |
| — | 汇总行 `.files-head`：`file-diff` 图标 + `本轮文件改动 · N` + `.files-sum`（`+added −deleted`）；chip 行 `.file-chips > .file-chip`（图标 + `fileName(path)` 末端名 + `.chip-delta`），点击只把该 id 加进 `openFiles`，展开的 `.file-diff-block` 用 `relativizeToCwd(c.path, root)` 显示工作区相对路径 |
| 合计与展开必须同口径，否则 `+3 −1` 和展开后数出来的行数对不上 | `changeDelta()` 与 `diffLines()` 共用同一摊平结果；`turnTotals()` 逐条走 `deltaCache`（`Map<PiFileChange, delta>`），流式每条 `message_update` 不重算历史 diff；`fileChanges.ts` 里旧的 `changeTotals` 已删（零重复） |

#### ③ turn 底部操作行（复制 + 时刻）

| dsh 实证出处（原样） | 本仓落地 |
|---|---|
| `c` 包组件注释：`Copy / branch (/ clock) IconActions row shared by user and assistant chrome.`，签名 `MessageIconActions({ text, time, clock, onBranch, branchUnavailable = false, className, extraActions, usageAction, t })`，内部只有 `copied` 一个回显态 | `.turn-actions` 只放**复制本轮全部正文**（`row.text` 在 `rows` 里累积，只收回复文本，工具 chip 参数/结果与计划卡排除）；`:disabled="!row.text"`。分支/用量在 Pi 侧无对应数据面 → 不编 |
| `thumbsUp` / `thumbs` 在三包 **0 命中**；`feedback` 在 `v` 包唯一命中是注释 `/** Persistent, turn-positioned feedback for a terminal failure. */`；`retry` 命中 124/125 次但**全部属于错误重试行**（`.gdEzaW_retryRow` / `.retryText` / `.retrySummary` / `.retryDetails` + `@keyframes gdEzaW_retry-shimmer`），不是消息操作位 | 赞/踩不做（dsh 无、本仓无反馈落库）；重试不做（dsh 的重试在错误行，与本轮操作行不同层） |
| `data-actions-reveal` 挂在操作行自身，父级 hover 显现：`@media (hover:hover){[data-actions-reveal=hover] .xzv4MW_actions{opacity:0;transition:opacity 80ms}` + 父级 `:hover` / `:focus-within` → `opacity:1}` | `.turn-actions` 上 `:data-actions-reveal`，最新一轮 `always`、历史轮 `hover`；CSS 选择器 `.msg-row:hover .turn-actions[data-actions-reveal='hover']` 加 `:focus-within` 一并命中，键盘可达 |
| `.p-xYUq_action{width:28px;height:28px;color:var(--dsw-alias-label-tertiary);background:0 0;border:none;border-radius:28px;padding:6px}`、`:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}`、`[data-unavailable]{cursor:default;opacity:.4}` | `.ta-btn` 同规格（28px 圆、`padding:6px`、`--text-faint` → hover `--text-dim` + `--bg-hover`、`:disabled` opacity .4）；复制成功回显沿用既有 `copyMsg()` 的 `copied` 态 |
| `Clock({ value: e.messageAt })` 与 `MessageIconActions` 的 `time` / `clock` 参数：dsh 每条消息都带时刻（批 2 已实证字段名） | 批 5 补上：`PiMsg.ts`（本地 `Date.now()`）→ turn 操作行 `.ta-clock`（`turnClock()` 取本轮最后一条有 `ts` 的消息）+ 用户气泡 `.u-clock`；三档格式化在 `src/utils/timeAgo.ts` 的 `fmtClock()`（同日 `HH:mm` / 当年跨日 `M月D日` / 跨年 `YYYY年`）。journal 回放没有本地时刻 → `ts` 缺失就不画时钟（见 §5.7 第 4 项） |

#### ④ 流式期占位与光标

| dsh 实证出处 | 结论 |
|---|---|
| `v` 包 `caret` 16 次 / `typing` 18 次命中，逐条看上下文**全是 composer 草稿逻辑**（`invalidatePaste`、`typingRun`、`revealCaret`、`track(draft, caret)`）；流式正文侧 `blink` / `cursor` 类 0 命中 | dsh 流式期**没有文本光标/闪烁占位**，占位信号只有 TurnStatus 一行 + 工具行扫光 → 本仓原来的 `.wait-line` + 三点 `@keyframes dot-bounce` 属自造，已删 |
| `.Md3f7G_turnStatus{height:26px;font:var(--dsw-font-s-strong-14);white-space:nowrap;background:linear-gradient(90deg,var(--dsw-static-deepseek-500) 0%,… 40%,var(--dsw-static-deepseek-200) 50%,… 60%,… 100%);-webkit-text-fill-color:transparent;background-position:100% 0;background-size:250% 100%;background-clip:text;align-self:flex-start;animation:1.8s linear infinite dsh-turn-status-shimmer}`，`@keyframes{to{background-position:0 0}}`；`.Md3f7G_turnStatusClock{font:var(--dsw-font-xs-13);font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption);margin-left:8px}`；JS：`setInterval(tick, 1e3)`、`const showClock = elapsedMs >= 15e3`、`role="status" aria-live="polite"`、文案字面量 `"Deep diving..."` | `.turn-status` = `role="status" aria-live="polite"` 的 `.ts-text`（品牌色 `background-clip:text` 扫过：`--accent` → `color-mix(--accent 50%, --text)`，`background-position:100% 0` → `0 0`，`size:250% 100%`，`1.8s linear infinite`）+ ≥15s 才出现的 `.ts-clock`（`tabular-nums`）；`prefers-reduced-motion` 下按 dsh 写法铺开静态（`background-position:0 0;background-size:100% 100%;animation:none`），非直接停动画 |
| 流式 markdown | dsh 流式与落定走同一条 markdown 管线；本仓「流式不解析 markdown、落定才渲染」**保持不变**（`mdCache` + 逐 token 重解析在大段输出上是主线程成本），属刻意性能设计，非显示差异 |

#### ⑤ 长输出展开体细节

| dsh 实证出处（原样） | 本仓落地 |
|---|---|
| `t` 包分块上限：`TerminalBlock{maxLines: Infinity}`、`DiffBlock{maxLines: 8}`、`ReadBlock{maxLines: 8}`、`SearchBlock{maxLines: 8}` | `clipLines(text, max = 8)`（`toolSummary.ts`）默认 8 行并返回 `hidden` 计数；`fullBody`（`Set<id>`）命中时传 `Infinity` 全量 |
| 展开文案是带行数的函数：`expand: (hidden) => t("terminal.expandRest", { n: hidden })`，另有 `collapse` / `expandAria` / `collapseAria` | `.crow-out` 尾部按钮文案 `展开剩余 N 行` |
| 结果区限高：`.o3BgMG_ioSection`（150px）/ `.o3BgMG_bodyScroll{max-height:260px}`、`.o3BgMG_ioLabel` sticky | 展开体两列 grid：`.crow-aside`（`grid-column:1;position:sticky;top:0`，label + 该条结果的复制按钮 `.crow-btn`）/ `.crow-out`（`grid-column:2;min-width:0`，`pre` + 展开按钮），沿用上一轮已对齐的 260px 限高 |

#### 本轮闸门与用例

- `pnpm typecheck` 0 错 · `pnpm build` ✓ · `pnpm test` **400 passed / 35 files**（上轮 386 → +14）。
- 新增对拍用例：`toolRowState` 3 例（失败优先 / ok 与 running / 落定兜底）、`firstLine`+`clipLines` 4 例（首行、默认 8 行报 hidden 2、未超限与空串、`Infinity`）、`changeDelta` 2 例（与 `diffLines` 同口径、write 全新增）、`fileName` 2 例（`/` 与 `\`、裸名与 `'///'`）、`messageListToolRow.spec.ts` 真实挂载 3 例（running/error 状态 + `.turn-status`、落定后操作行与 `disabled`、chip 只显末端名且点开才出该文件 diff）。
- 样式仍全部在 `MessageList.css` / `CollapsibleRow.css`，无内联样式；`scripts/visual-check.mjs` 的 `.rewind-btn` 锚点未受影响。

### 5.7 第五轮：taste skill 视觉改版（2026-11-01，redesign-preserve）

依据 `design-taste-frontend` 反 slop 原则，按 **排版→间距→色彩→动效** 优先级纯视觉刷新，逻辑/模板/类名零改动（400 用例锚点全保留）。Open WebUI 侧只取公认形态（居中窄栏、柔和气泡、弱边框），不虚构细节。

- **Token 层**（`base.css`）：新增字号阶梯 `--fs-xs..--fs-2xl`、字重 `--fw-*`、行高 `--lh-tight/body/code`、圆角体系 `--r-bubble:16 / --r-2xl:22`（Shape Lock 三档：细行 `--r-sm`、卡片 `--r-lg`、气泡/大容器）、缓动 `--ease: cubic-bezier(.22,1,.36,1)` + `--dur-fast:120ms / --dur:180ms`、窄栏宽 `--chat-col:760px`、阴影 `--sh-card / --sh-mascot`（明暗成对）。light 块中性色与暗色统一冷暖。
- **排版**：`MessageList/CollapsibleRow/ComposerStatus/ChatHero/RunHistory/ChatView` 六处散乱字号（10/11/12/12.5/13px 等）全部归入阶梯；正文 `--fs-md + --lh-body(1.65)`；工具名 `--mono`；字重层级 600/500/400。
- **间距**：消息区 `padding-inline: max(--sp-4, (100% - --chat-col)/2)` 实现 Open WebUI 式居中窄栏（模板零改动）；turn 间走 `--sp-*`，块内收紧一档；ChatView 输入列与消息列共用 `--chat-col`，永不错位。
- **色彩**：单强调色锁定——装饰性 accent（头像、ghost-btn、hover 蓝边、hero 竖向渐变 + teal 第二色 + 两团径向光、置顶 `--warn`）全部降为中性 `--bg-elev/--border/--text-dim/--text-faint`；状态色只留在真状态语义（running 扫光、error 点、索引失败、当前选中、发送钮）；`rgba(255,255,255,.22)` → `color-mix(var(--accent-ink))`。
- **动效**：hover/展开 transition 统一 `--dur*/--ease`；删常驻 `mascot-float` 循环动画；真状态动画（`crow-sweep`、`ts-shimmer`、spinner、cursor blink）刻意保留；全局 `prefers-reduced-motion` 兜底不变。
- **闸门**：typecheck 0 错 · **400 passed / 35 files** · build ✓ · `graphify update` 已跑（纯样式，拓扑无变化）。

### 5.8 第六轮：对话页骨架改版（2026-11-01，批 1）

上一轮 token 级刷新后观感仍乱，根因在布局骨架。本轮改模板结构与 class，功能接线零改动（`@interrupt→abort()`、ApprovalDialog 内联、pinned 贴底、`abortTurn()` 回落、`piEvents.ts` 折算全不动）。取值对标 skill 参考实现 `relay-agent-console`（rail 步 + `.ic` + 1.6s opacity-only 心跳 + 失败步默认展开）。

- **对齐（F2）**：`base.css` 新增 `--chat-pad: max(var(--sp-4), calc((100% - var(--chat-col)) / 2))`，`chat-header / msgs / step-strip / composer` 四条线共用同一个 token，替换此前各抄一份公式 + `max-width + margin auto` 两套列宽机制；自定义属性里的 `100%` 在使用点按包含块解析，因此三条线天然重合。**5.7 记录的 `--chat-col:760px` 已改为 720px，消息区内衬公式由「就地重抄」改为 `--chat-pad`。**
- **turn 栅格（F3）**：新增 `--rail: 26px` 与 `--turn-grid: var(--rail) minmax(0,1fr) auto`；assistant 头像移进 `.msg-body` 作首行第一格（留在 `.msg-row` flex 里时栅格与竖线参照系不同，线整体右偏 38px），`.msg-body` 改 grid，正文落第二列，`.crow` / `.turn-status` 占 `1 / -1`；`CollapsibleRow.css` 的 `.crow-head` 由 flex 改同一栅格并**内衬归零**，新增 rail 节点 `.crow-ic`（`position:relative` + `background:var(--bg)` 遮线，hover 成对覆盖 `--bg-hover`）与 `.crow-main`。
- **等待态（F5）**：`.msg-row.assistant.waiting` 自渲染行删除，等待/执行中统一为 turn rail 尾部的 live 步——新增 `.ts-ic` 心跳环（`@keyframes ts-beat`，1.6s，只改 opacity）+ 一行状态文字；`TurnStatus` 文案、≥15s 计时、`role=status aria-live=polite`、`.turn-status/.ts-text/.ts-clock` 全部保留。
- **step-strip（F6）**：一排重复 `⚡bash` chip 聚合为 `bash ×3 · 共 9 步 · 42.6s`（新增 `.step-groups/.step-count/.step-times/.step-dur`，删 `.step-head`）；数据源是消息流里已有的 `PiEventRow.at`，无新增状态通道；strip 去卡化（带 border 的卡片与 `padding-inline` 内衬互斥，否则边框外沿 ≠ 文字左缘）。
- **用户气泡（F7）**：右对齐保留，删 `flex-direction:row-reverse` 与 `text-align:right`，改 `align-self:flex-end` + 内容右靠；气泡底 `--bg-elev` + hairline 边框 + `--sh-1`，`max-width: min(72ch,100%)`；每条头像**彻底去掉**（二选一取后者）。
- **工具行（F8）**：失败行 `watch(() => props.state)` 自动展开；**单行 duration 跳过**——耗时需要的是一条工具的 start/end 一对时刻，消息级 `ts`（批 5 起才有，且只有落定时刻一个）给不了，补它仍要给 MessageList 新开 events prop 做消息↔事件相关，属编造，禁令优先。
- **动效（F11）**：删 `uc-pulse`（UsageCard）、`step-spin`（ChatView）、`composer-spin`（ComposerStatus）、`avatar-pulse`（MessageList）；对话列持续动画只剩 live 步心跳 + `crow-sweep` + turn-status shimmer；`.cursor` 的 blink 是流式正文插入位，随 `m.streaming` 生命周期存在，刻意保留。
- **跨文件栅格（F20）**：`.crow-label / .crow-pre / .crow-aside / .crow-out / .crow-btn` 从 `MessageList.css` 收回 `CollapsibleRow.css`（scoped 编译为 `.crow-body[data-v-x] .crow-label`，后代不要求带属性，`:deep()` 可达 slot 内容，已在 dist 产物实测）。
- **已知偏离**：rail 竖线是容器级连续段 + 尾部 `--rail` 渐隐，做不到「error 行单独不画」（需逐行伪元素），代码内以 `ponytail:` 注释标明升级路径。
- **闸门**：typecheck 0 错 · **400 passed / 35 files** · build ✓ · `graphify update` 已跑（3332 nodes / 6733 edges）。

### 5.9 第七轮：右列与轨迹面板（2026-11-01，批 2）

> 补记：批 2 落地时未写文档，本节按代码内 `F1 / ai-console.md` 注释与现存实现回推。

- **对话壳两轨（F1，ai-console.md §8）**：`base.css` 新增 `--chat-aside: clamp(320px, 26vw, 380px)`；`ChatView.css` 的 `.chat` 改 grid，`.chat.aside-open { grid-template-columns: minmax(0,1fr) var(--chat-aside) }`；`TraceDrawer` 收起时 `display:none` 整块不占位，窗宽 <1180px 转 overlay（与 `ChatView.css` 同一个断点，窄窗不为右列留轨）。
- **run stream 行解剖（`ActivityPanel.css`，ai-console.md §2）**：事件行统一为 `[26px 图标列][主文 + 一行结果][时间/时长 + chevron]`。
- **per-run receipt（`MessageList.vue/.css` 的 `.msg-usage`，ai-console.md §6）**：跑完一轮钉一行 quiet mono 收据（步数 + 成本，完整 token 口径 hover 可查）；本轮时长要的是「本轮起点→落定」的差值，`PiMsg.ts`（批 5 起有）只是每条消息的落定时刻，turn 聚合里并没有与用户提问配对的起点引用，算出来会是猜测，继续不编。
- **事件分类契约**：`utils/piEventKind.ts` 的 `classifyEvent` 收敛为纯函数，`tests/piEvents.spec.ts` / `tests/piEventKind.spec.ts` 锚定，UI 侧不再各自 if-else 猜事件类型。
- **F18**：unified 单栏 diff 加图例头（先说明 ± 的含义，再给增删计数），不强行双栏。
- **闸门**：typecheck 0 错 · **407 passed / 35 files** · build ✓。

### 5.10 第八轮：收尾批——KPI 解剖 / 统计搬家 / light 基底 / 字号归档 / 左栏节奏（2026-11-01，批 3）

批 1 改骨架、批 2 改右列，本轮清三类残留：数字没有解剖、统计放错位置、light 主题基底倒置。全部是样式与显示位置改动，事件名 / invoke 名 / props 语义零改动。

- **F9 KPI tile 解剖（`UsageCard.css`）**：`.uc-grid` 由 `1fr 1fr` 两列等宽改为 `auto 1fr` + `align-items:baseline`，配 `.uc-cell{display:contents}` 让四行的 label/数值直接落进同一对轨道 → 数值右缘对齐到一条线上（2×2 等宽做不到）。label `--fs-xs` + `--text-faint`；数值 `--fs-base` + 700 + `letter-spacing:-.02em` + `font-variant-numeric:tabular-nums` + 右对齐。Σ 总计 `.uc-v.strong` 由 `--accent` 改回 `--text`（accent 只留给 delta 与状态）。`display:contents` 的代价以 `ponytail:` 注释标明（`.uc-cell` 不再是盒子）。
- **F10 统计搬家（`ComposerStatus` → `ActivityPanel`）**：composer 行只留 附件 / steer / 停止 / 发送 四件，`.composer-status` 本体保留但只剩 running 态与快捷键 hint。`statsSegments` 统计段与代码库索引行迁入轨迹面板 context 区（新增 `.ctx-zone/.ctx-line/.ctx-text/.ctx-act`，沿用其 `.usage-zone` 外壳类名体系）；props 走 `ChatView → TraceDrawer → ActivityPanel` 三层同名透传（`usage/turns/steps/projectId`），`project_index_codebase`、`interrupt` 不变；批 1 删掉的 `composer-spin` 未复活。
- **F14 light 基底（`base.css` `[data-theme='light']`）**：旧值把页面底设成近纯白、把浮层设成比页面更暗的灰 → 「白页 + 灰气泡 + 白卡片」层级倒置、边界互吃。新阶 page < panel < elev 逐级变亮，边界改冷灰蓝 rgba，弱化墨提到过 AA；accent `#2563eb`、`--text/--text-dim`、四档 tinted 阴影全部保持，主令牌零重命名，暗色 `:root` 未动。grep 全仓 CSS：对话区（气泡 / 顶栏 / composer）无硬编码 `rgba(0,0,0)` / `#fff` 塌陷点，残留只在 modal scrim 与 `var(--danger, #…)` 冗余 fallback。

  | token | 旧 | 新 |
  | --- | --- | --- |
  | `--bg` | `#f6f7f9` | `#eceff3` |
  | `--bg-panel` | `#ffffff` | `#f6f8fa` |
  | `--bg-elev` | `#f2f4f7` | `#ffffff` |
  | `--bg-hover` | `#e9edf2` | `#e4e8ee` |
  | `--bg-active` | `#dfe4ea` | `#dae0e8` |
  | `--border` | `#e2e6ec` | `rgba(35,39,47,.10)` |
  | `--border-strong` | `#cdd4dd` | `rgba(35,39,47,.18)` |
  | `--border-soft` | `#f0f2f5` | `rgba(35,39,47,.06)` |
  | `--text-faint` | `#8b9199` | `#6b7280`（对白底约 4.8:1） |

- **F16 字号归档**：`TraceDrawer / RunHistory / ChatHero / SessionTree / ActivityPanel` 五个 CSS 的裸字号（10 / 10.5 / 11 / 11.5 / 12 / 12.5 / 13 / 13.5 / 14 / 15px）全部归入 `--fs-xs/sm/base/md/lg`，中间档清零（`font-size:[0-9]` grep 无匹配）。
- **F17+F19 左栏节奏（`Sidebar.css/.vue`、`RunHistory.css`）**：行解剖只给可点行——选择器改 `.ws-list li:not(.ws-runs)`，`.ws-runs` 的三条 `!important`（display / cursor / padding）与 `.ws-empty` 的 `cursor !important` 全部删除，缩进仍取 14px（UI-14 记录值不变）；`.ws-list li` 字号 `12.5px` → `--fs-sm`，`.ws-title` / `.nav-item` / `.settings` 归 `--fs-xs` / `--fs-base`。选中态 two-tone：`--bg-active` 弱底 + `box-shadow: inset 2px 0 0 var(--accent)`，`.rh-item.checked` 同款（并显式合并 `:focus-visible` 的焦点环，两条 box-shadow 不互相吃掉）。项目行时间戳改用共享 `@/utils/timeAgo`（删掉本地 `relativeTime` 的第二套格式），`.ws-time` 统一 `--fs-xs` + `--text-faint` + tabular-nums。
- **闸门重基线（`scripts/visual-check.mjs`，批 1/2 遗留）**：两条断言与批 1/2 的既定设计脱节，本批纠正——① `.chat-hero` 的 `backgroundImage` 含 `rgb(18,26,34)`：批 1 F8 已把装饰渐变撤成纯 `--bg`，改量 `backgroundColor` 的暗度（守的还是「切深色首页要变暗、不露白底方块」）；② 「header 单行 ≤64px」：批 1 F1 右列占轨后，抽屉展开时中栏只剩 720 列，`flex-wrap` 兜底必然换行，改为「pill ≤44 + 控制组 ≤44 + header ≤104（最多两行）」。均为重基线，未放宽成 no-op。
- **未尽**：右列展开时 `.chat-header` 占两行（要回单行得合并 轨迹/计划/压缩/导出/导入 控制组）；`Sidebar.css` 仍有 `15 / 13.5 / 12.5px` 三档共 6 处（`.bname`、`.new-chat`、`.ws-dialog-row` / `.ws-dialog-row > span` / `.ws-dialog-text`、`.ws-btn`、`.about`），改动会牵动品牌字与新会话 pill 的视觉尺寸，未纳入本批（F17 只点名 L226 那一处 `12.5px`）。
- **闸门**：typecheck 0 错 · **407 passed / 35 files** · build ✓ · visual-check **96/96 通过** · `graphify update`（3355 nodes / 6777 edges / 170 communities）。

### 5.11 第九轮：噪声层清理（2026-11-01，批 4）

批 1 改骨架、批 2 改右列、批 3 改数字解剖，用户看新截图仍反馈「没有实质提升」——剩下的差距全在噪声层：轨迹面板被生命周期事件刷屏、中栏一条裸系统文本占半屏、工具展开体是 JSON dump、KPI 是三个并列方框、气泡工具条常驻、header 占两行。本批只修这六项，批 1-3 的 token（`--chat-col/--chat-pad/--rail/--turn-grid/--chat-aside`、light 色阶）与锚点类名（`.crow*/.turn-status/.ts-*/.rewind-btn/.ta-btn/.rh-title/.event-*`）零回退。方法论取 `finesse-ui/references/ai-console.md` 的 run-stream 语义化与 anti-cheap 约束。

- **P0-1 lifecycle 事件与聚合行（`piEventKind.ts` / `ActivityPanel.vue/.css`）**：`PiEventKind` 在 `exit` 后新增 `'lifecycle'`（icon `clock`、label `系统`），`TYPE_KIND` 用 `normType` 归一键收 10 个事件：`message_start / message_end / agent_start / agent_end / entry_appended / auto_retry_start / auto_retry_end / session_open / queue_update / kernel_restarted`；既有 kind 行为不变，`other` 兜底保留。列表行模型从「一条事件一行」改为 `ListRow{…StreamRow, agg: StreamRow[] | null}`——**连续** lifecycle 装进 bucket，`bucket.length > 1` 才折成一条 quiet 聚合行 `系统事件 ×N` + 首时间戳 + caret，展开是 `.evt-agg-body` 里逐条 `语义名 + mono 事件名 + 时间`（不是隐藏信息，只是不再刷屏）。判别联合走 `agg` 单字段，模板零 `as` 断言。
- **P0-1c 主文案（新导出 `eventDisplayLabel`）**：`lifecycle` 查 `LIFECYCLE_LABEL`（消息开始 / 消息结束 / 内核开始 / 内核结束 / 写入记录 / 自动重试 / 重试结束 / 打开会话 / 队列更新 / 内核重启），落空原样显示事件名；`other` 显示事件名。原始事件名退化为 `.evt-type-tag`（`--mono --fs-xs --text-faint`），且 `showTypeTag()` 只留给 `lifecycle` / `other`——工具行主文已是人话，再贴 `tool_call` 是重复。**冲突处理**：`classifyEvent` 的 `未识别事件 ${raw} · ${fieldsCount} 字段` 被 `tests/piEventKind.spec.ts` 锁死且规格要求「可加不得删」，故字符串原样保留，「未识别事件」在界面主文案里靠渲染层组装绕开。
- **P0-2 系统 notice 行（`MessageList.vue/.css`）**：`SystemRow` 从 `{kind,msg,first}` 改为 `{kind,msg,tone,icon,long}`，`sysNotice()` 按文案分四档（`自动重试` → muted + refresh；`失败/错误/未响应/中断` → error + alert-triangle；`未解析/无法/注意` → warn + alert-triangle；其余 muted + info）。渲染走 `--turn-grid`：`.sys-ic` 占第一格（col1 状态图标），`.sys-note` 占第二格的 tinted 容器（`--bg-elev` + `--border-soft`，error/warn 档换 `--danger-soft / --warn-soft` 底 + `color-mix(... , var(--border))` 边，明暗双主题各有一份 rgba）。>160 字符默认 2 行 `-webkit-line-clamp` + 「展开/收起」小按钮（`title` 兜底）。旧的 `.sys-line / .sys-pi / .sys-first` 整段删除，visual-check 加了「已下线」断言。
- **P0-3 展开体结构化（`toolSummary.ts` 纯函数 + `MessageList.vue` / `CollapsibleRow.css`）**：新增 `toolArgsBlocks(tool, argsRaw, root)` → `ToolArgBlock{label,text,code}[]`：bash/code 类取 `command` 出一块 shell 代码；read/write/edit 取 `path`（`relativizeToCwd` 削工作区前缀）一行 + `内容 / 替换前 / 替换后`；**取不到已知字段才** `JSON.stringify(parsed, null, 2)` 回落（dsh deriveBody 兜底不丢）。`formatToolBody` 契约不动，结构化只在渲染层做。结果块：`splitExitCode()` 先摘行尾退出码成独立 mono 行，错误块左侧 `2px solid var(--danger)` 边条；复制按钮 `.crow-copy` 绝对定位到块右上角、`@media (hover: hover)` 内 opacity + visibility 收起。`.crow-body` 的 label 列由 `max-content` 改固定 `40px`，参数/错误 label 与内容列 grid 对齐。`.crow-aside` 整段规则删除（label 列不再挂操作）。
- **P0-4 KPI segmented bar（`ActivityPanel.vue/.css`）**：`.stat-row`（三个独立框）→ 单容器 `.stat-bar[role=group][aria-label=本会话事件统计]`，三格等宽 `<span class="stat"><b>数值</b><i>label</i></span>` 纵排，外框一条 + `.stat + .stat{border-left:1px solid var(--border-soft)}` 内分隔；数值 `--fs-md` 700 `tabular-nums`，label `--fs-xs --text-faint`。
- **P1-5 气泡工具条 hover 化（`MessageList.css`）**：`.user-actions` 默认 `opacity:0`，`.msg-row.user:hover` 与 `.user-actions:focus-within` 显示，整段包在 `@media (hover: hover)` 内（触屏无 hover，不能收起即失效）。只用 opacity——visual-check 会真点 `.rewind-btn`，`display:none` / `pointer-events:none` 会打断。`rewind-btn` / `ta-btn` 类名保留。
- **P1-6 header 单行（`ChatView.css`）**：`.chat-header` 的 `flex-wrap: wrap` → `nowrap`（wrap 就是两行的直接来源），`gap: 10px` → `var(--sp-2)`；`.header-pill` 内衬 `4px 10px` → `2px 10px`（内部 trigger 28px + 2 + 2 边框 = 34px ≤ 36），选择器组左置、`.chat-controls` `margin-left:auto` 右置；窄窗 ≤1180px 时 `轨迹/计划/压缩/导出/导入` 只 `> span` 隐藏成图标（`.trace-badge` 是 `<i>`，不受影响）。**批 3 记录的两行重基线（pill ≤44 / controls ≤44 / header ≤104）收紧为 pill ≤36 / controls ≤36 / header ≤64 + 新增「选择器组与控制组中心线重合」几何断言**（中心线差 ≤1px），断言总数 96 → **99**。
- **单测同步**：`piEventKind.spec.ts` 追加 4 条（lifecycle kind 全集 / `eventDisplayLabel` 语义 / `other` 保留事件名 / 既有 kind 不变，24 passed）；`toolSummary.spec.ts` 追加 2 describes 7 条（`toolArgsBlocks` 分工具形态 + JSON 回落、`splitExitCode` 多写法与锚定，38 passed）；`messageListToolRow.spec.ts` 中「展开体按缩进 JSON 给出」一条与 P0-3a 直接冲突，改写为新形态断言（labels `['命令','结果']`、正文不含 `"command"`、复制钮在 `.crow-out` 内），并另加「未知工具才回落 JSON」与「系统文本渲染成 notice 行」两条锁住兜底与四档 tone。
- **未尽**：退出码文案（`exited with code N`）在本仓 `src/` 与桥侧均无实证，`splitExitCode` 用行尾锚定正则做多写法候选，已以 `ponytail:` 注释标明升级路径（读内核 `exitCode` 字段）；lifecycle 聚合只按「连续」折，跨工具调用的同类事件不合并（合并会打乱时间线，与 run-stream 语义冲突）。
- **闸门**：typecheck 0 错 · **421 passed / 35 files** · build ✓ · visual-check **99/99 通过** · `graphify update`（3372 nodes / 6808 edges / 172 communities，`eventDisplayLabel` / `toolArgsBlocks` / `splitExitCode` 三个新节点的 imports/calls 边均可查）。

### 5.12 第十轮：对话页显示逻辑细化（2026-11-01，批 5）

批 1-4 把骨架、右列、数字、噪声层都收完了，剩下的差距在**落定语义**这一层：中断的那轮看起来像凭空消失、Think 行落定后还在滚最后一行、dsh 每条消息都带的时钟本仓一个都没有。本批只补这四项，锚点类名与 token 零回退。

- **中断落定（`usePi.ts` 的 `abortTurn()`）**：`finally` 里除了 `streaming.value = false`，把 `messages` 中所有 `m.streaming === true` 一并置 false。依据是 dsh「abort 给 running root 合成落定」——abort 后内核不再发 `message_end`，流式消息会永远停在 `streaming=true`，UI 挂着流式光标、既不出收据也不出操作行。
- **时刻数据面（`usePi.ts` / `piEvents.ts`）**：`PiMsg` 新增可选 `ts?: number`，`pushUser()` 与 4 处新建 assistant 消息（文件改动壳、流式壳、toolcall chip、旧版 `tool*` 兜底）一律以 `Date.now()` 真实填充。字段注释写明：journal 回放的消息没有本地时刻，消费方必须判空，缺就隐藏时钟，不许拿 id 或落盘时间编一个假时间（数据诚实）。
- **时钟展示（`MessageList.vue/.css` + `src/utils/timeAgo.ts`）**：新导出纯函数 `fmtClock(ts, now = Date.now())` 三档——同日 `HH:mm`（时分补零）、当年跨日 `M月D日`、跨年 `YYYY年`；turn 操作行复制钮后接 `.ta-clock`（`turnClock()` 取本轮最后一条有 `ts` 的消息，全无则不渲染），用户气泡操作行末尾接 `.u-clock`（仅 `row.msg.ts` 存在时）。dsh `MessageIconActions` 的密度策略是「时间 hover 显、按钮常驻」，本仓 `.user-actions` 整组已是 hover 浮现（批 4 P1-5），时钟挂末尾自动同频，不再另做一套显隐。
- **中断回执（`MessageList.vue/.css`）**：收据区在用量之后新增 `v-else-if="row.stopped"` 一档，`.msg-usage msg-stopped` 用 `var(--warn)`，`title` 说明「最后一段输出可能不完整」——用量没上报时至少留一行可读的落定说明。
- **Think 摘要两档（`thinkSummary()`）**：改成 dsh `ReasoningRow` 实证口径 `running ? latestLine : firstLine`——只有「正在流的最后一条」滚最新行，落定后回到首行，历史 Think 不再拖着半句话。
- **偏离清单的三处决定**（均在代码注释里写明原因）：
  1. `fmtClock` 落点：清单要求写在 MessageList 的 script 里并导出，而 `<script setup>` 禁 ES module exports；落到既有的共享时钟格式模块 `src/utils/timeAgo.ts`，与同文件 `timeAgo(ts, now)` 保持同一个 `now` 注入签名（零新文件、可单测）。
  2. `stopped` 判据：清单给的 `props.streaming && props.interrupted === true` 在真实 abort 后恒为 false（`abortTurn` 的 `finally` 已把 streaming 落定），会写成死代码；改为照 `live` 的 post-loop 写法 `if (cur && props.interrupted) cur.stopped = true`——中断只可能落在末尾那一轮，ChatView 在下轮流式开始时清零标记。
  3. `abortTurn` 的 per-msg 清理没有单测：函数首行 `if (!IN_TAURI) return`，jsdom 下没有 `__TAURI_INTERNALS__`，要测就得 mock 整套 IPC。`tests/messageListDisplay.spec.ts` 头部以 `ponytail:` 注释记录该限制与升级路径（抽成可导出的纯函数），未造空壳测试。
- **新增测试**：`tests/messageListDisplay.spec.ts`（jsdom 真实挂载，9 条）——`fmtClock` 三档 + 补零 + 无 `ts` 返回空串；Think 落定显首行 / 流式末尾显最新行；`.msg-stopped` 只落在末尾 turn、未中断不渲染；`.ta-clock` 有 `ts` 才显、回放整体隐藏；`.u-clock` 仅在有时刻的气泡上出现。
- **闸门**：typecheck 0 错 · **430 passed / 36 files** · build ✓（239 modules）· visual-check **99/99 通过**（截图里时钟已渲染）· `graphify update`（3380 nodes / 6823 edges / 174 communities，`fmtClock` / `turnClock` / `thinkSummary` 新节点的 imports/calls 边均可查）。

### 5.13 第十一轮：对话列宽口径改判——消息流与输入框等宽（2026-11-22）

用户原话「对话宽度应该跟输入框宽度一样宽才对」。此前口径经历三段漂移：5.7 定 `--chat-col:760px` 且「输入列与消息列共用，永不错位」→ 5.8 收窄为 720px → 后来用户反馈「输入框太宽」，消息列被放到 `100%` 铺满、composer 单独抽 `--composer-col: clamp(480px,56vw,760px)` 收窄居中——两条对齐线正式分家。本轮把口径拉回 5.7 的原始原则：**一条列宽令牌，消息流 / 步骤行 / notice / composer 全部等宽**。

- **Token 层**（`base.css`）：删 `--composer-col`；`--chat-col` 从 `100%` 改回 `clamp(480px, 56vw, 760px)`——宽窗封顶 760 居中（56vw 让中屏平滑过渡，480 兜窄屏下限），窄窗自然铺满。`--chat-pad` 公式不变，`--chat-col` 封顶后内衬自动变厚，四条对齐线天然重合。
- **接线**（`ChatView.css`）：`.composer` 内衬从「就地重抄的 `--composer-col` 公式」改回 `var(--chat-pad)`——这正是 5.8 反对过的「各抄一份公式」反模式的重演，`--composer-col` 引入时用「独立于消息列」的理由绕过了统一 token，本轮废除。
- **`--hero-col` 保留**：落地页 hero 不是消息流，WorkBuddy 式居中窄卡形态独立成立，不与 composer 对齐（既有断言「hero ≤760px」不受影响）。
- **header 维持整栏内衬**（D-09 口径不变）：顶栏横跨 `.center` 全宽，工作区名要有呼吸位；对齐线只约束「内容层」（msgs / step-strip / notice / nokernel / io-note / composer）。
- **行长兜底不动**：`.txt` 的 `max-width: min(96ch, 100%)` 继续兜住超宽列；`--chat-col` 封顶 760 后 96ch 基本不触发，属双保险。
- **断言反转**（`visual-check.mjs`）：旧两条「消息列全宽（≥92% 中栏）」与「composer 比消息列窄（<0.9×）」废弃，换成「输入框与消息列等宽（内容边线 ≤2px）」+「步骤行与消息列同对齐线」。测量取内容边线（msgs 的 padding 内侧 vs shell 外缘），并扣掉滚动容器 clientRect 含滚动条的宽度差——1440 视口实测三线全部 470→1230，误差 0px。
- **页面壳定律（同批，用户「一个页面一个页面的样式也要修正」）**：宽屏逐页审查发现内容页壳封顶宽三种口径并存——ui-kit `.page-inner` 用 `--page-max` 1280、agent-ops 家族硬编码 1100、能力中心/收件箱/插件/资料库/项目工作台**完全不封顶**铺满窗口。统一为：所有内容页壳 `max-width: var(--page-max); margin: 0 auto`（`.wd-market` / `.inbox-view` / `.wd-community` / `.wd-library` / `.pw` / `.agent-ops`），`.wd-p-center` 与 `.page-inner` 本就合规。agent-ops 的嵌入式豁免（`max-width: none`，宿主已封顶）不变。新增 1800 宽视口断言两条：七页统一封顶 + 边线同线（实测全部 390→1670，误差 0px）。
- **资料库 master-detail 空态**（同批发现）：未选中文件时 `.lib-body` 只剩 280px 目录树，右侧整片裸底——补 `v-else` 占位节（`.lib-preview.lib-preview-empty`，与骨架态同构复用 `.preview-binary` 形态），宽屏实测右栏 920px 填满。
- **闸门**：visual-check 330/330 · vitest 555 · verify:pages 84 张无缺陷 · typecheck 0 错 · build ✓。

### 5.14 第十二轮：本文档未尽项逐条核对与收口（2026-11-23，#98）

用户问「之前的 md 里面的改造是否全面完成」。本轮把 §2/§3/§5.3/§5.4/§5.10/§5.11 的全部「未尽 / 未对齐 / 留待后续」标记逐条对到当前代码，结论分三类：

**一、已落地但文档未回写（勘误，零代码改动）**

| 标记 | 核实结果 |
|---|---|
| §5.3 todo 投影卡 | `todoList.ts` + `WorkflowPanel` 已接轨迹抽屉「工作流」页签（解析 markdown 复选框，不依赖内核 todo 事件） |
| §5.3 LLM 耗时 | 桥侧 `pi_run` 已给每条事件打 `pi_ts` + run/span 信封；RunGraph 逐节点画环节耗时、头部画全程耗时——「没有逐轮时间戳」的前提已失效。首 token / tok/s 内核仍无数据源，继续不编 |
| §5.10 右列 header 两行 | 批 4 P1-6 已 `nowrap` 收单行，并有「pill ≤36 / 控制组 ≤36 / header ≤64 + 中心线重合」几何断言锁定 |
| §5.10 Sidebar 裸字号 | `layout/Sidebar.css` grep `15px/13.5px/12.5px` 0 命中 |
| §2 #7 专家 / #11 记忆 / #18 插件 | 能力中心专家市场（列表+编辑+导入+头像+发布+市场池）、LanceDB 语义检索（B5）、Pi 托管包透传（V18）均已落地——表格三行已勘误 |

**二、本轮收口的真缺口**

1. **Session log 可读导出（§5.3）**：顶栏 io 组新增「转写」键（`doc` 图标），`src/utils/conversationLog.ts` 纯函数 `formatConversationLog`（头行元信息 + 逐条「角色 · 时刻 + 缩进正文 + 工具/附件行」，缺 `at` 不画时间——与 `.ta-clock` 同口径的数据诚实），`useConversationIO.exportConversationLog` 走 `plugin-dialog save(.txt)` → 同一个 `conversation_export` 落盘（后端透传不猜格式，零新命令）。浏览器模式回落剪贴板，与 JSON 导出对称。顺带修 `toConv` 漏映射 `ts → at`（§5.12 起消息带本地时刻，JSON/转写都该有）+ 导入回填 `ts`（导出/导入往返对称）。
2. **`splitExitCode` 漏内核实证写法（§5.11 升级路径收口）**：内核 0.87.x 失败输出实为 `\n\nCommand exited with code ${exitCode}`（`chunk-OJP47DM6.js` 实证），旧正则的 `\s*` 吃不掉行首 `Command ` 前缀——唯一实证写法反而接不住。正则补 `(?:command\s+)?exited with code` 与 `command failed with exit code` 两候选；结构化 `exitCode` 只进 journal 的 bashExecution 记录、不进 RPC 事件流，文本锚定就是唯一口径（注释已写明）。stub 同步改用内核真实文案（带正文 + 空行 + 退出码），让桩走实证路径。

**三、确认边界不动的项**

- §3 #6 自更新 / 桌宠：低优先级维持后置；#13 浏览器 DOM 注入属 pi 生态包（`pi-web-access` 已可一键装），不在本仓重建（V18 透传铁律）；#12 真·视觉理解等内核 content block，属内核侧。
- §5.4 工具摘要语义化 / §5.6-§5.12 各轮：全部已在代码与断言里，无回退。

**闸门**：typecheck 0 错 · vitest **617/617**（+8：转写 7 + 退出码对拍 1）· visual-check **416/416**（+2：转写键就位 + 点击落 `.txt` 内容断言）· cargo **315/315**（本轮未触 Rust）· flow **99/99**（stub 改动波及，复跑通过）· i18n strict 过（新词条 8 条；发现并绕开门禁坑——抽取器只认含 `[\u4e00-\u9fff]` 的 key，纯符号模板串 `↳ {0}：{1}` 不算 CJK 会漏网，词条改为含汉字的 `  ↳ 附件 {0}：{1}（{2}）`）· build ✓。

---

> 注：DSH 生态的功能描述来自 2026-10 公开文章与 dsh.so 工件页，属社区公开资料；
> 具体 dsh 内部 API 细节以官方仓库为准。pi-workbench 侧均来自本仓库实际代码。
