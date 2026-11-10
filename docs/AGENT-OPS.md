# Pi Workbench · 智能体运行层（agent-ops）

> 对象：本仓（Tauri 2 + Vite + Vue 3 + Pi 0.87.1 内核）
> 术语：文中「参考基线」指立项时对照的外部产品能力清单（仅作取舍讨论用），本仓不搬运其代码。
> 与 [ARCHITECTURE.md](./ARCHITECTURE.md) 的关系：本文管「团队 / 记忆 / 技能池 / 浏览器会话如何落到内核上」，后者管「产品结构如何组织」。两者内核都是 Pi，落点都走 Pi extension。
> 铁律（对齐 ARCHITECTURE.md §0）：**外部参考是异构栈（Python/React），本仓是 Rust/Vue/Pi，不搬运代码；只把可迁移能力对象化为 Pi extension + Rust 后端 + Vue 面板，内核仍是 Pi。**

---

## §0 结论（先行）

1. **能力吸收，内核不换。** 「多智能体团队 / 分层记忆 / 知识库 RAG / 技能市场 / 连接器 / 浏览器自动化」全是可对象化的产品能力。取法：这些能力对象在本仓是一等公民，以 **Pi extension** 形式挂载，既有 agent 工具面（模型可调用），也有 **Rust 后端 + Vue 面板** 面（人可管理）。
2. **三层融合模型**：
   - **Agent 面**：Pi extension 注册 `registerTool`，模型在对话里直接调用（记忆存取、团队调度、技能发布、浏览器操作）。
   - **后端面**：Rust `agent_ops.rs` 读同一份磁盘状态（`.pi/<kind>/`），供面板查询。
   - **表现面**：4 个 Vue 视图，沿用既有 UI Kit 与主题变量，补齐空/加载/错误态。
3. **单一真源**：扩展清单改由 `pi-manifest.json#extensions` 声明，`pi_bridge::find_extensions` 读取清单（不再硬编码文件名），与 `capabilities.rs` 对齐。（Pi 清单与 Tauri ACL `capabilities/default.json` 职责分离，互不混写。）
4. **本轮已落地**：4 个 Pi extension（工具 + 斜杠命令）、Rust 后端 4 个查询命令、4 个美化视图、router/sidebar 接线、能力清单驱动加载。
5. **待办**：端到端内核加载与多智能体真实调度需人工在 `pnpm tauri dev` 中验证（见 §7 未验证清单）。

---

## §1 参考实现 能力 → Pi Workbench 落点

| # | 参考实现 能力 | 本仓现状 | 落点（extension + 后端 + 视图） |
|---|---|---|---|
| O1 | 多智能体团队 AgentTeams（协调器调度多专家） | 仅单专家角色（roles.rs） | `agent-teams.ts`（`team_create`/`team_dispatch`/`team_status`）+ `agent_teams_list` + `TeamsView` |
| O2 | 分层记忆 agent-memory（召回 + 全文检索） | 无记忆层 | `agent-memory.ts`（`memory_store`/`memory_recall`）+ `agent_memory_list` + `MemoryView` |
| O3 | 知识库 RAG（私有语料 grounding） | LibraryPanel 仅 fs，无检索 grounding | 复用 Library 检索（`library_search`）；本轮回填「记忆 + 资料」闭环，RAG grounding 列为 B 期 |
| O4 | 技能池 / 市场（共享、发布技能） | skills 面板静态 | `agent-skill-pool.ts`（`skill_publish`/`skill_pool_list`/`skill_pool_install`）+ `agent_skillpool_list` + `SkillPoolView` |
| O5 | 连接器生态（腾讯文档/会议等 OAuth + MCP 网关） | 已有 mcp.rs 网关 | 已有；本轮回填「技能市场」与连接器并列入口，不重做网关 |
| O6 | 浏览器自动化（CDP 无头、截图、远程浏览） | AgentBrowserPane + `browser::browser_open` | `agent-browser-session.ts`（`browser_open`/`browser_fetch`/`browser_screenshot`）+ `BrowserView` |
| O7 | ACP 协议 / MBTI 人格 / 桌面客户端 | 部分（角色=专家） | 超出本轮范围，记入 C 期 |

> 边界：本仓**不引入 Python/React**。参考实现 的 `agent-harness`/`agent-gateway`/`agent-browser-session` 子项目只作架构参考，不复制其实现；浏览器自动化的重 CDP 渲染复用本仓既有 Tauri `browser` 模块，Pi extension 只负责「意图 + 能力探测 + 状态」。

---

## §2 融合后的目标结构

```
┌ L5 表现层  Vue3：对话 / 会话树 / 文件 / 终端 / 团队 / 记忆 / 技能市场 / 浏览器 / 资料 / 连接器 / 成果
├ L4 编排层  Tauri commands + 事件总线（pi://event）
├ L3 能力层  Pi RPC 桥 · MCP Gateway · 能力清单解析 · 运行层后端（读 .pi/<kind>）
├ L2 插件层  Pi extension（每能力一个文件，以下新增）：
│             sandbox-env.ts   沙盒执行面（既有）
│             role-inject.ts    专家角色注入（既有）
│             agent-teams.ts    多智能体团队
│             agent-memory.ts   分层记忆
│             agent-skill-pool.ts  技能池/市场
│             agent-browser-session.ts  浏览器自动化
└ L1 内核层  Pi 0.87.1 原生：会话树 · 工具 · 模型 · 压缩 · cost
```

磁盘状态布局（extension 写、Rust 读，统一根 = `PI_CODING_AGENT_DIR` 或 cwd 下的 `.pi/`）：

```
<base>/.pi/
├── teams/<team_id>.json        # 团队定义（成员、协调策略）
├── teams/<team_id>.jsonl       # 调度运行日志（每轮成员产出）
├── memory/memory.jsonl         # 记忆条目（ts / text / tags）
├── skills-pool/<name>/SKILL.md # 技能市场共享池
└── browser/session.json        # 浏览器会话状态（devtools 端点等）
```

合并原则（对齐 §0）：
- **L1 不重复实现**：会话树、工具集、压缩、token 计数全部走 Pi。
- **L2 一个能力一个 extension**，同名能力不跨文件重复注册。
- **状态单一真源**：extension 与 Rust 后端都读写 `.pi/<kind>/`，agent 面与人面一致。
- **凭证不入库**：provider key 一律由 Pi 自身管理，本仓不存、不读、不打印。

---

## §3 分阶段路线

### A 期 · 参考实现 能力对象化（本轮，✅ 已落地）

| 项 | 动作 | 落点 | 状态 |
|---|---|---|---|
| A1 | 4 个 Pi extension：工具注册 + 斜杠命令 + 状态落盘 | `src-tauri/extensions/agent-*.ts` | ✅ |
| A2 | Rust 后端读 `.pi/<kind>/` | `src-tauri/src/agent_ops.rs` + `lib.rs` | ✅ |
| A3 | 4 个美化视图（空/加载/错误态） | `src/views/{Teams,Memory,SkillPool,Browser}View.vue` + `.css` | ✅ |
| A4 | 能力清单驱动扩展加载 | `pi-manifest.json#extensions` + `pi_bridge::find_extensions` | ✅ |
| A5 | router + sidebar 接线 | `router/index.ts` + `Sidebar.vue` | ✅ |

**验收（见 §7 诚实标注）**：`cargo check` / `vue-tsc` / `vite build` 全量通过；扩展文件语法对齐 `sandbox-env.ts` 范式；Rust 在缺目录时返回空数组不崩。

### B 期 · 知识库 RAG grounding

| 项 | 动作 |
|---|---|
| B1 | 记忆召回接入对话系统提示（每次 prompt 前注入相关记忆） |
| B2 | Library 检索结果作为 grounding 上下文注入（取代纯 fs 预览） |
| B3 | 团队调度走真实 Pi 多轮（sub-agent 或 `pi` 子进程），补齐流式回填 |

### C 期 · 协议与人格

| 项 | 动作 |
|---|---|
| C1 | ACP 入站/出站桥接（委派外部编码智能体） |
| C2 | MBTI 人格模板接入专家角色 |
| C3 | 端到端内核加载验证 + Vitest 覆盖 `agent_*` 命令 |

---

## §4 风险与取舍

| 决策 | 取 | 舍 | 风险 |
|---|---|---|---|
| 参考实现 能力以 Pi extension 吸收，不搬 Python | 内核单一、栈统一、可组合 | 失去 参考实现 现成实现 | 低（仅借鉴设计） |
| 团队调度首轮用 `pi` 子进程或返回计划，未接真实 sub-agent | 不阻塞、可验证骨架 | 多智能体真实并发未端到端 | 中（B 期补） |
| 浏览器自动化复用 Tauri `browser` 模块，extension 只做意图+探测 | 不重造 CDP | 截图/求值需本仓既有浏览器面板配合 | 低 |
| 状态落 `.pi/<kind>/`，extension 与 Rust 共根 | agent 面与人面一致 | 需约定根目录（PI_CODING_AGENT_DIR） | 低 |

---

## §5 已落地的变更

### §5.1 第一轮：能力层落地（Pi extension + Rust + 视图）

| 文件 | 变更 |
|---|---|
| `docs/AGENT-OPS.md` | 新增：本文 |
| `src-tauri/extensions/agent-teams.ts` | 新增：团队创建/调度/状态工具 + `/team` 命令 |
| `src-tauri/extensions/agent-memory.ts` | 新增：记忆存取工具 + `/memory` 命令 |
| `src-tauri/extensions/agent-skill-pool.ts` | 新增：技能发布/列举/安装工具 + `/skills-market` 命令 |
| `src-tauri/extensions/agent-browser-session.ts` | 新增：浏览器打开/抓取/截图工具 + `/browser` 命令 |
| `src-tauri/src/agent_ops.rs` | 新增：读/写 `.pi/<kind>/` 的 8 个命令（4 查询 `agent_teams_list`/`agent_memory_list`/`agent_skillpool_list`/`agent_browser_status` + 4 写 `agent_team_create`/`agent_memory_store`/`agent_skill_publish`/`agent_browser_open`）；缺目录返回空不 panic |
| `src-tauri/src/lib.rs` | `mod agent_ops;` + 注册全部 8 个 `agent_*` 命令 |
| `src-tauri/pi-manifest.json` | `extensions` 数组加入 4 个新扩展 |
| `src-tauri/src/pi_bridge.rs` | `find_extensions` 改读 `crate::capabilities::CapabilityManifest`（单一真源），保留硬编码兜底 |
| `src/styles/agent-ops.css` | 新增：4 视图共享布局（容器/页头/工具栏/空态/对话框栅格），统一引用 base.css 令牌 |
| `src/styles/buttons.css` + `src/main.ts` | 新增全局按钮变体 `.btn.primary/.danger/.tiny`，并在入口引入 `agent-ops.css` |
| `src/views/TeamsView.vue` + `.css` | 新增：多智能体团队视图 |
| `src/views/MemoryView.vue` + `.css` | 新增：分层记忆视图 |
| `src/views/SkillPoolView.vue` + `.css` | 新增：技能市场视图 |
| `src/views/BrowserView.vue` + `.css` | 新增：浏览器自动化视图 |
| `src/router/index.ts` | 注册 4 个新路由 `/agent-ops/teams` `/agent-ops/memory` `/agent-ops/skills` `/agent-ops/browser` |
| `src/components/layout/Sidebar.vue` | 主导航新增「融合 · 参考实现」分组（团队/记忆/技能/浏览器），含收起态入口 |

> ⚠️ 第一轮的「独立分组 + 独立路由」在第二轮被判定为**不是融合**（用户反馈），已重构，见 §5.2。

### §5.2 第二轮：导航融合与样式修复

| 文件 | 变更 |
|---|---|
| `src/components/layout/Sidebar.vue` + `.css` | 移除「融合 · 参考实现」分组与 `.nav-sep` / `.nav-item` 样式；主导航恢复 4 项 |
| `src/router/index.ts` | 删除 4 个独立路由；改为**兼容重定向**：`/agent-ops/teams → /capabilities?tab=team`、`/agent-ops/skills → /capabilities?tab=market`、`/agent-ops/browser → /capabilities?tab=browser`、`/agent-ops/memory → /library?view=memory` |
| `src/views/CapabilitiesView.vue` + `.css` | Tab 由 3 个扩为 6 个（专家/技能/连接器/**团队**/**市场池**/**浏览器**）；内嵌 `TeamsView`/`SkillPoolView`/`BrowserView`；新增 `isEmbeddedTab` 控制外层标题与工具栏去重；支持 `?tab=` 直达；新增 `.agent-embedded-shell` |
| `src/components/panels/LibraryPanel.vue` + `.css` | 新增「记忆」tab，内嵌 `MemoryView`；支持 `?view=` 直达；新增 `.lib-memory-shell` |
| `src/views/{Teams,SkillPool,Memory,Browser}View.vue` | 新增 `embedded` prop；`embedded` 时容器降级（`height:auto; padding:0; max-width:none`），避免与父级 padding 叠加 |
| `src/views/TeamsView.vue` + `.css` | 对话框内原生 `<input>`/`<select>` 换成 `AppInput`/`AppSelect`（原生控件此前无样式）；删除 `.app-select-native`、`.member-custom` |
| `src/components/ui/AppSelect.css` | **修复菜单被压竖排**：`min-width:100%; width:max-content; max-width:320px` + `white-space:nowrap`；`min-width:140px` 改为仅未显式传 width 时生效 |
| `src/styles/agent-ops.css` | 新增 `embedded` 变体的空态与标题字号规则 |
| `src/components/chat/ChatHero.vue` + `.css` | 首页两张卡片收进**输入框底部操作条**（左：附件/工作空间/目录/权限；右：思考深度/语音/发送）；删除 `.hero-footer`/`.footer-card`/`.dir-btn` 等；目录选择改为本地 `await`，`pick-directory` 事件改带 `dir` 参数 |
| `src/components/layout/RoleSwitcher.vue` | 新增 `width` prop（对话头 180px，首页输入框内 128px） |
| `src/views/ChatView.vue` + `.css` | 轨迹 tab 新增工具调用计数徽标；头部新增当前工作目录 chip；`onPickDirectory(dir)` 改为接收父级已选路径 |
| `src/components/chat/ActivityPanel.vue` + `.css` | 新增事件计数徽标；事件列表自动贴底滚动（用户手动上滚即暂停跟随） |
| `docs/PAGE-FUNCTION-AUDIT.md` | 重写：按新导航结构逐页逐功能点审计 |

### §5.3 第三轮：去外部命名 + 模型连通性根因

**去外部命名**（本仓是独立项目，代码/文件/路由/文档一律不带外部平台痕迹）：

> 具体的「旧名 → 新名」对照表已删除：把外部平台的名字留在文档里，等于这个项目还在引用它。
> 判断标准只有一条 —— 全仓（含文档、脚本、构建产物）不再出现任何外部平台命名。
> 校验命令：在仓库根执行
> `rg -in "<外部平台名>" src src-tauri/src src-tauri/extensions docs scripts README.md package.json`
> 应当**零命中**。

实际落点：Rust 模块与 8 个命令前缀 → `agent_*`；Pi extension 文件名 → `agent-*.ts` / `sandbox-env.ts`；
composable → `useAgentOps.ts`；样式表与类前缀 → `agent-ops.css`（`.agent-ops` / `.aops-*`）；
运行时提示组件 → `components/runtime/RuntimeNote.vue`；路由 → `/agent-ops/*`；
文档 → `ARCHITECTURE.md` / `AGENT-OPS.md` / `docs/alignments/ALIGN-*.md`。

连带的配置同步：`src-tauri/pi-manifest.json#extensions`、`pi_bridge.rs` 兜底清单、`capabilities.rs` 单测夹具、
`main.ts` 引入、`router/index.ts`、`scripts/visual-check.mjs` 路由断言、`README.md` 全篇。
另外清掉了历史构建产物与 app 配置目录里遗留的旧名扩展副本（内核按清单加载，这些副本不会被加载，但会污染插件页列表）。

### §5.4 第六轮：Tauri 命令线程模型（写后端命令前必读）

Tauri v2 官方文档明确写着：

> Commands without the *async* keyword are executed on the **main thread** unless defined with `#[tauri::command(async)]`.

**规则**：命令体里只要出现**阻塞等待**（等待子进程 / 内核响应、`recv_timeout`、`wait()`、长时间 IO），
就必须声明 `#[tauri::command(async)]`，让它跑在异步运行时上。否则冻结的是**整个窗口**——
不只是这一个按钮，连原生对话框都弹不出来。

踩过的实例（详见 [PAGE-FUNCTION-AUDIT.md §0⁗](./PAGE-FUNCTION-AUDIT.md)）：

| 命令 | 阻塞点 | 表现 |
|---|---|---|
| `pi_call` | `recv_timeout(120s)` | 换目录 → `set_thinking_level` 命中，窗口最长冻 2 分钟 |
| `skills_list` | 内核 `get_commands`（10s） | 打开技能面板即卡 |
| `mcp_call` | MCP `tools/call`（20s） | 点一次 MCP 工具即卡 |

**回归守卫**：`src-tauri/src/pi_bridge.rs` 单测 `blocking_commands_must_be_declared_async` 会扫描源码，
逐条检查 `pi_call` / `mcp_call` / `skills_list` 的声明形式。新增阻塞式命令时，把名字加进该测试的
`WATCHED` 数组即可——这类 bug 类型检查、构建、渲染回归全都抓不到，只能靠源码级守卫。

**前端侧同理**：任何「等待外部弹窗返回」的交互都必须带**超时复位**与**取消出口**。
共享实现见 `src/composables/useDirPicker.ts` 的 `pickDirectoryGuarded()`（120s 超时 + 代际丢弃），
两处入口（`WorkspacePicker`、首页「先选目录再发送」）共用，单测见 `tests/dirPicker.spec.ts`。

**模型连通性 P0 根因**（详见 [PAGE-FUNCTION-AUDIT.md §0.5](./PAGE-FUNCTION-AUDIT.md)）：

`Cargo.toml` 里 `reqwest` 用 `default-features = false, features = ["json"]` 连带关掉了 TLS，
依赖树中 TLS crate 数为 0 → **全仓所有 https 出网请求都不可能完成**（模型测试连接、远端技能/扩展安装）。
修复：`features = ["json", "rustls", "system-proxy", "http2"]`；并修正 `settings_test_model` 的成功文案，
明确「仅探测 Base URL，未校验 API Key 与模型名」。

**另修**：`SettingsView` 的 `loadTools()` 未接住 IPC reject，导致浏览器预览下 `/settings` 抛未处理的
`Cannot read properties of undefined (reading 'invoke')`；改为统一走 `describeIpcError()`（`useRuntime.ts` 新增），
并给 `inputMap[m.id]` 加不变量保证 + 模板 `v-if` 兜底，避免缺条目时整页失活。

---

## §6 与既有扩展层的关系

`sandbox-env.ts` 是「声明式沙箱 + 企业能力接缝」的落点。本次新增的 4 个 `agent-*` extension 与之同级，同属「渐进式 Agent」插件层：

- 沙箱 / 记忆 / 团队彼此正交，可同时激活。
- 团队调度可调用沙箱工具：多专家在各自环境内执行，由 `team_dispatch` 编排。
- 记忆可在任意工具调用前后被存取，成为跨能力的「长期上下文」。

> 一句话：**沙箱扩展管「执行面与护栏」，`agent-*` 管「认知与协作面」，二者在 Pi 内核上并列，共同构成渐进式 Agent。**

---

## §8 取舍表：吸取什么、丢弃什么

两个外部参考平台都读过，**只取与本仓内核（Pi）契合的做法，其余明确丢弃**——这是「单独一个项目」的边界。

| 维度 | 吸取（保留为能力） | 丢弃（附理由） |
|---|---|---|
| 团队协作 | 团队 = 成员 + 协调策略（顺序 / 并行 / 辩论）的显式定义；调度日志可追溯 | 不引入常驻协调器服务与 Python 运行时：编排落到 `agent-teams.ts`，调度靠 `pi` 子进程按需起停 |
| 记忆 | 分层记忆 + 可按标签召回，写读同一份 append-only 事件流（add/update/delete/restore/purge）；召回注入统一在 `before_agent_start`，对话与主动任务共用；画像由保留标签折叠 | 不引入向量库与独立记忆服务：本轮以词面召回为主，语义向量用 `eval/memory-recall-100.jsonl` 作下轮判断依据 |
| 技能复用 | 技能池 = 「发布 SKILL.md → 他人一键安装」，与既有 `skills.rs` 扫描口径一致 | 不自建市场服务端：安装是直链/本地复制，避免引入需要运维的 catalog API |
| 浏览器 | agent 可打开页面、抓正文、截图，并把会话状态落盘可查 | 不重造 CDP：重渲染复用本仓 Tauri `browser` 模块与既有浏览器面板，扩展只做能力探测与轻量操作 |
| 扩展机制 | 一切都做成 extension，工具按需激活（`setActiveTools`），不常驻 | 不做「平台自带插件市场」那套清单服务：本仓以 `pi-manifest.json#extensions` 为唯一真源 |
| 页面结构 | 一页一类事实、能力平铺为 tab，人面与 agent 面共享同一状态 | 不为每个能力单开一级导航：能力归入语义所属的既有菜单（能力中心 / 资料库），见 `PAGE-FUNCTION-AUDIT.md` §0.1 |
| 技术栈 | Pi（唯一内核）+ Rust 后端 + Vue 面板 | 不搬运异构栈代码（外部参考为 Python/React），不引入第二内核 |

---

## §7 未验证清单（诚实标注）

1. 本机无 `pi` 在 PATH 时，extension 的工具逻辑无法端到端跑（团队调度依赖 `pi` 子进程；无 pi 时返回计划、不报错）。
2. 多智能体团队的真实多轮调度、流式回填、sub-agent 隔离，需在 `pnpm tauri dev` 中人工验证。
3. 浏览器截图/求值依赖本仓既有 Tauri `browser` 模块或本机 chromium 二进制；无 chromium 时 `browser_screenshot` 如实报能力不可用。
4. 记忆召回为词面多信号匹配，非语义向量检索；100 条评测基线已固化（`pnpm eval:memory`），向量召回按下轮评测结果决定。
5. Rust `agent_*` 命令仅在本机开发态与单测中验证；`agent_memory_purge` 的审计文件写入未在真实配置目录做端到端断言。
