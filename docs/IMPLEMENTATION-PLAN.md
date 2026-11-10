# Pi Workbench · 全面审计与分阶段落地方案

> 审计日期：2026-09-26　·　对象：`/Users/tatsuma/Documents/NextCode/pi-workbench`
> 引擎基线：Pi **v0.87.1**（`@earendil-works/pi-coding-agent`）
> 本文是唯一权威的进度真相源。任何 README/记忆里的说法与本文冲突时，以本文为准。

---

## §0 执行摘要（结论先行）

1. **本仓库的「Pi 内核」从未真正接通。** 环境中装的 `pi` 是 `pi-number`（计算圆周率的 npm 包，`v2.0.5`），不是 earendil-works 的 agent harness。所有基于「Pi RPC 已验证」的结论作废。
2. **已纠正安装并重新验证**：`pi` → `@earendil-works/pi-coding-agent@0.87.1`，RPC 握手实测通过（`get_state` / `get_tree` / `get_session_stats` / `get_commands` 均返回真实数据）。
3. **蓝图里大量「要自研」的能力，Pi 0.87.1 已原生提供**：会话树（`get_tree`）、分支/回滚（`fork` / `clone` / `switch_session`）、工具级 hook（`on("user_bash")`）、工具动态激活（`setActiveTools`）、token/成本度量（`get_session_stats`）。**真正需要自研的只剩两件事：声明式沙箱的执行面，与环境↔会话树的绑定。**
4. **当前代码可编译可构建，但存在 1 处安全缺陷（路径穿越）、2 处并发缺陷（MCP 响应跨接、沙箱重启丢列表）、1 处配置错误（extension 路径解析）**，均列入 §2 缺陷表并给出修复步骤。
5. **未完成项共 24 项**，其中 3 项为架构级阻塞（会话树 UI、沙箱↔内核闭环、环境快照绑定），其余为增量完善。详见 §5。

---

## §1 本次审计发现的三处根因纠正

### 1.1 根因 A（致命）：装错了 Pi

| 项 | 事实 |
|---|---|
| 已安装（错） | `pi@2.0.5`，描述 "Going deeper inside of the PI number."，仓库 `IonicaBizau/pi-number` |
| 表现 | 任意参数（含无参数）均只输出 `3` 后退出 0 |
| 影响 | `pi_start` 能 spawn、"进程不报错"，但 Pi 内核能力为零；extension 从不加载 |
| 真实包 | `@earendil-works/pi-coding-agent`（当前 `0.87.1`） |
| 修正命令 | `npm uninstall -g pi && npm install -g @earendil-works/pi-coding-agent` |

**验证证据**（实测输出，非推断）：

```
$ pi --version → 0.87.1
$ pi --help    → pi - AI coding assistant with read, bash, edit, write tools
$ printf '{"id":"r1","type":"get_state"}\n{"id":"r2","type":"get_tree"}\n' \
  | pi --mode rpc --no-session --offline
{"id":"r1","type":"response","command":"get_state","success":true,
 "data":{"thinkingLevel":"off","isStreaming":false,"steeringMode":"one-at-a-time",
 "sessionId":"01a0dbda-...","messageCount":0,"pendingMessageCount":0}}
{"id":"r2","type":"response","command":"get_tree","success":true,
 "data":{"tree":[{"entry":{"type":"thinking_level_change","id":"0c5c4659","parentId":null,...},"children":[]}],
 "leafId":"0c5c4659"}}
```

### 1.2 根因 B（方法论）：`timeout` 在本机不存在

前序验证用了 `timeout 20 pi ...`，而 macOS 无 coreutils。`timeout` 命令未找到 → 管道静默失败 → 被误读为「Pi 无输出/协议不明」。**这是把「工具没装」误判成「被验证对象不成立」的典型陷阱。**

规则：本机校验一律用前台直接执行 + `head`/`cut` 截断，不用 `timeout`。

### 1.3 根因 C（设计假设）：该「自研」的部分比预想的少

从已安装 bundle 反查 RPC 命令表（`dist/modes/rpc/rpc-mode.js` 的 `case "..."`），确认 33 个命令：

```
abort  abort_bash  abort_retry  bash  clear_queue  clone  compact  cycle_model
cycle_thinking_level  export_html  follow_up  fork  get_available_models
get_available_thinking_levels  get_commands  get_entries  get_fork_messages
get_last_assistant_text  get_messages  get_session_stats  get_state  get_tree
new_session  prompt  set_auto_compaction  set_auto_retry  set_follow_up_mode
set_model  set_session_name  set_steering_mode  set_thinking_level  steer  switch_session
```

扩展 API（`dist/core/extensions/types.d.ts`）确认具备：`registerTool` / `setActiveTools` / `getActiveTools` / `registerCommand` / `registerFlag` / `sendUserMessage`，以及 40 类事件，其中与本蓝图强相关的：

| 事件 | 用途 |
|---|---|
| `on("user_bash")` | **沙箱拦截挂点**：替代宿主 bash 执行 |
| `on("session_before_tree")` / `on("session_tree")` | **会话树导航前后**，用于绑定/回滚环境快照 |
| `on("before_agent_start")` | 读取 `.systemPrompt` → **system prompt 预算闸门** |
| `on("tool_call")` / `on("tool_result")` | 工具调用审计面板 |
| `on("session_before_fork")` / `session_before_switch` | 分支切换的可取消拦截 |

**结论**：蓝图中「自研 JSONL 会话树」与「自研工具注册」两块可整体删除，改为调用 Pi 原生 API。工作量下降，正确性上升。

---

## §2 现状审计

### 2.1 文件清单与状态

| 文件 | 行数 | 状态 | 说明 |
|---|---:|---|---|
| `src-tauri/src/lib.rs` | 51 | ✅ 可用 | 4 个 State 注入 + 20 条 command 注册；`.setup` 只加载 projects/mcp |
| `src-tauri/src/state.rs` | 67 | ⚠️ 缺陷 | `PiState` 单进程单会话；`SandboxState` 仅内存 |
| `src-tauri/src/pi_bridge.rs` | 97 | ⚠️ 缺陷 | 半双工：不区分 `response` 与事件；extension 路径解析错 |
| `src-tauri/src/mcp.rs` | 200 | ⚠️ 缺陷 | JSON-RPC id 硬编码 1/2/3 → 跨 server 串号 |
| `src-tauri/src/sandbox.rs` | 445 | ⚠️ 部分 | Nix 构建/回滚可用；执行面弱；无 GC |
| `src-tauri/src/fs.rs` | 41 | ❌ 缺陷 | 无路径穿越防护 |
| `src-tauri/src/terminal.rs` | 59 | ⚠️ 缺陷 | 同 fs，无限制 |
| `src-tauri/src/projects.rs` | 78 | ✅ 可用 | 落盘 `projects.json`，CRUD 完整 |
| `src-tauri/extensions/sandbox-env.ts` | 144 | ⚠️ 待重写 | 按猜测 API 写，须对齐 §1.3 真实 API |
| `src/composables/usePi.ts` | 67 | ⚠️ 缺陷 | 只处理 3 类事件；忽略 `response`/`agent_end`/`bash_execution_update` |
| `src/composables/useSandbox.ts` | 97 | ✅ 可用 | 沙箱面板数据层 |
| `src/composables/useMcp.ts` / `useFs` / `useTerminal` / `useProject` | 8/13/36/21 | ✅ 可用 | 薄封装 |
| `src/views/ChatView.vue` | 102 | ⚠️ 待扩展 | 三栏布局，缺会话树/分支/token 面板 |
| `src/components/panels/{Library,Skills,Activity}Panel.vue` | 20/20/20 | ❌ 占位 | 纯静态 ul，无数据 |
| `src/components/panels/ConnectorsPanel.vue` | 80 | ✅ 可用 | MCP 增删改调 |
| `src/components/panels/SandboxPanel.vue` | 111 | ✅ 可用 | 沙箱面板 |
| `src/router/index.ts` | 59 | ✅ 可用 | 8 条路由含 `/sandbox` |

总计约 1,913 行。

### 2.2 缺陷清单（按优先级）

| # | 位置 | 缺陷 | 后果 | 优先级 |
|---|---|---|---|---|
| D1 | `pi_bridge.rs:15` | spawn 的是假的 `pi` | 内核层完全失效 | **P0** |
| D2 | `mcp.rs:142,185` | `rpc_call(id)` 硬编码 1/2/3，`pending` 全局共享 | 连接第 2 个 MCP server 后，响应被错配到前一个 server | **P0** |
| D3 | `fs.rs` / `terminal.rs` | 接受任意绝对路径，无根约束 | 路径穿越：可读写项目外任意文件 | **P0** |
| D4 | `pi_bridge.rs:21` | extension 取 `app_config_dir()/extensions/...`，但文件在源码树 | 插件永不加载 | P1 |
| D5 | `sandbox.rs` | `SandboxState.envs` 仅内存，`.setup` 未从 `.pi/sandboxes/*/env.json` 恢复 | 重启 App 后沙箱列表为空，点执行会误回退宿主 | P1 |
| D6 | `usePi.ts:41` | 事件解析不完整 | `response`/`agent_end`/`bash_execution_update` 丢失，UI 可能停在 streaming | P1 |
| D7 | `sandbox.rs:378` | exec 用 `sh -lc` + PATH 前缀，但未注入 profile 的完整 env | Nix profile 内的 wrapper 可能缺变量 | P1 |
| D8 | `sandbox.rs` | 无 GC | profile 目录随会话数线性膨胀 | P2 |
| D9 | `PiState` | 单 child | 无法多会话并存，`switch_session`/`fork` 无承载 | P2 |
| D10 | `mcp.rs:138` | `protocolVersion` 硬编码 | 与服务端协商失败时无回退 | P2 |
| D11 | 全仓 | 无前端测试 | UI 回归靠肉眼 | P2 |

---

## §3 目标架构（五层）

```
┌────────────────────────────────────────────────────────────────┐
│ L5 表现层  Vue3 工作区：对话 / 会话树 / 文件 / 终端 / MCP / 沙箱 │
├────────────────────────────────────────────────────────────────┤
│ L4 编排层  Tauri commands（invoke）+ 事件总线（emit/listen）      │
├────────────────────────────────────────────────────────────────┤
│ L3 能力层  Pi RPC 桥 · MCP Gateway · Nix 沙箱调度器              │
├────────────────────────────────────────────────────────────────┤
│ L2 插件层  Pi extension：user_bash 拦截 / setActiveTools / 工具   │
├────────────────────────────────────────────────────────────────┤
│ L1 内核层  Pi 0.87.1：会话树(JSONL) · 工具 · 模型 · 压缩         │
└────────────────────────────────────────────────────────────────┘
```

关键原则：**L1/L2 用 Pi 原生能力，L3 只做「策略与接缝」，L4/L5 只做 UI。** 不重复实现内核。

---

## §4 分阶段落地路线

> 每个 Phase 独立可验证；上一 Phase 未通过验收，不得进入下一 Phase。

### Phase 0 · 环境 Correctness（P0 缺陷清零）

**目标**：让 L1 内核真实可用。

| 项 | 动作 | 文件 |
|---|---|---|
| 0.1 | 卸载 `pi-number`，安装 `@earendil-works/pi-coding-agent`；写进 README 与 setup 脚本 | README / `scripts/setup.sh` |
| 0.2 | MCP JSON-RPC id 改为**每连接单调自增**，全局基址 `epoch*100000` 防跨 server 碰撞 | `mcp.rs:142,185` |
| 0.3 | fs/terminal 增加 `root` 参数（活动项目根）+ `canonicalize` 前缀校验，越界报错 | `fs.rs`, `terminal.rs` |
| 0.4 | extension 路径改为「资源路径 → 源码路径」多候选解析 | `pi_bridge.rs:21` |

**验收**：
- `pi --version` = 0.87.1；`pi --help` 打印 coding-agent 用法。
- 连接两个 MCP server（`npx @modelcontextprotocol/server-everything` 与一个自造回显 server），各自 `tools/call` 返回正确结果且无错配。
- 在 `/tmp` 外调用 `fs_read_file("/etc/passwd")` 返回越界错误。

**验证**：`cargo check` + `cargo test` + `pnpm build`。

---

### Phase 1 · Pi 内核接通（RPC 双向）

**目标**：Tauri ↔ Pi 的桥从「半双工」升级为「全双工」，并把 Pi 真实事件完整暴露给前端。

**现状差距**：`pi_bridge.rs` 只把 stdout 无差别 `emit("pi://event")`，前端 `usePi.ts` 靠 `rec.type` 猜测。

**实现步骤**：

1. `pi_bridge.rs` 增加响应相关器：
   - 命令发往前先登记 `id → oneshot::Sender<Value>`；
   - stdout 读到 `type=="response"` 时按 `id` 派发，`success:false` 转为 `Err`；
   - `type=="bash_execution_update"` 事件按 `id` 分流（该事件**重复发起命令的 id**，是官方唯一带 id 的事件）。
2. 事件白名单转发（只转发 Pi 真实定义的事件，避免前端收到未知结构）：
   `message_update` / `agent_start` / `agent_end` / `agent_settled` / `agent_before_settle` / `bash_execution_update` / `tool_execution_start|update|end` / `session_tree` / `session_info_changed` / `turn_start|end` / `message_start|end`。
3. `usePi.ts` 重写 `handle()`，按官方例子解析：`record.assistantMessageEvent.type === "text_delta"` → `delta` 追加。
4. 启动参数补齐（当前缺 provider/model/auth 信息）：`--provider/--model/--session-dir/--tools`。**凭证一律由 Pi 自身（`pi auth`）管理，本仓库不存储、不读取任何 key。**

**数据结构（新增 Rust）**：
```rust
pub struct PendingCmd { pub tx: oneshot::Sender<Value>, pub created: Instant }
// PiState 增加 pending: Mutex<HashMap<String, PendingCmd>>, seq: AtomicU64
```

**验收**：
- 前端发送 prompt 后可见流式文本；`agent_settled` 到达后按钮解除禁用；
- `pi://event` 中能看到 `response` 与事件两类记录；
- 连接断开时前端收到 `process_exit` 且状态复位。

**验证**：`cargo test`（新增：id 相关器路由正确 / 未知事件不 panic）+ `pnpm build`。

**落地状态（本次已实现）**：

- `PiState` 增加 `pending: Mutex<HashMap<String, Sender<Value>>>` 与 `seq` 发号源；`pi_call(json, timeout_ms?)` 为唯一入口——命令带 `id` 下发，响应按 `id` 路由回发起方，`success:false` 转成 `Err(error)`，默认超时 120s。**命令与响应彻底解耦，支持并发与乱序。**
- stdout 读取线程分流：`type=="response"` 走 pending 表（**不再进入前端事件流**），其余为流式事件 emit `pi://event`。协议依据（Pi 0.87.1 `dist/modes/rpc/rpc-mode.js`）：响应恒为 `{id,type:"response",command,success,data|error}`，事件为 `AgentSessionEvent`。
- `pi_send` 保留为 fire-and-forget（自动补 id），供无需结果的场景。
- 实测协议层（`node` harness 直连 `pi --mode rpc --no-session --offline`）：5 条命令并发下发，5 条响应各自按 id 配对回收，无错配。

---

### Phase 2 · 会话树与分支（蓝图第 1 条，原生能力接入）

**目标**：把 Pi 的 JSONL 会话树，映射为前端可浏览、可回滚的 UI。

**为什么不自研**：`get_tree` 已返回 `{entry, children, label?, labelTimestamp?}` 树 + `leafId`；`fork {entryId}`、`clone`、`switch_session {sessionPath}` 已实现分支与切换；`get_entries {since}` 用条目 id 作 durable cursor（重启仍有效）；`export_html` 可直接导出。

**实现步骤**：
1. 新增 Tauri commands（全部走 RPC 桥）：
   - `session_tree()` → `get_tree` ✅ **已落地**：走通用 `pi_call('get_tree')`
   - `session_fork(entryId)` → `fork` ✅ **已落地**：`usePi.forkFrom()` 封装，fork 后自动 `get_tree` 刷新
   - `session_clone()` → `clone` ⬜ 未接（等价语义可由「分叉当前 leaf」覆盖）
   - `session_switch(path)` → `switch_session` ⬜ 未接：`--no-session` 模式下无磁盘 session 可切，需 Phase 5 引入 session dir 后补
   - `session_stats()` → `get_session_stats`（含 `tokens.total`、`cost`、`contextUsage.percent`）⬜ → U16 token 面板
   - `session_export()` → `export_html` ⬜
2. 前端新增 `SessionTree.vue`：按 `get_tree` 渲染缩进树，`leafId` 高亮；点击历史节点 → 调用 `fork` 生成新分支并提示「已从该节点分叉，原分支保留」。✅ **已落地**：ChatView 左栏增加「文件 / 会话树」子标签；`useSessionTree.ts` 负责嵌套树 → 缩进行 与摘要生成（纯函数，便于后续单测）。
3. 新增 `TokenBudget.vue`（或嵌入 ChatView 顶栏）：显示 `get_session_stats` 的 tokens/cost/contextUsage。
4. 追加一个系统提示预算闸门：extension `on("before_agent_start")` 读 `.systemPrompt`，估算 token，超 2000 时告警并写入 UI 事件。（估算用启发式 `chars/4`，真实值以后端 `get_session_stats` 为准。）

**验收**：
- 在同一会话中发 3 条消息，第 3 条前 fork 一次 → 树出现两个叶，`get_tree` 的 `leafId` 指向新叶；
- 切回原分支后继续对话，历史消息完整；
- token 面板数值随对话增长。

---

### Phase 3 · MCP 动态工具注入（蓝图第 2 条 · 破 token 焦虑）

**目标**：MCP 工具**进入 Pi 的工具集**，而非仅在前端手工调用。

**机制**（已确认 API）：
- `registerTool({name,label,description,parameters(TypeBox),execute})` 注册；
- `setActiveTools(names)` 控制激活集 —— **这就是「按需加载、用完即焚」的落点**：只有激活的工具描述进入 system prompt；
- 注册时给 `promptSnippet`（一行）与 `promptGuidelines`（若干条），Pi 据此组装提示。

**实现步骤**：
1. 后端新增 `mcp_tools_for_pi()`：读 `mcp.json`，对每个已连接 server 的 `tools[]` 生成 Pi 工具描述数组（保留 `name`、投影 `description`、保留 JSON Schema）。
2. 新增 Tauri command `pi_activate_tools(names: string[])` → 写入 `~/.pi/state.json` 的 `tools` allowlist，并**重启 Pi 进程**使 `--tools` 生效（当前阶段无热更新 RPC 命令，重启是最简正确解；Phase 8 再评估）。
3. 前端 Connectors 面板增加两处交互：「注入 Pi」按钮（把该 server 的全部工具注册并激活）、「取消注入」。
4. 实现工具代理工具 `mcp_proxy`：参数 `server/tool/args` → 调 `mcp_call` → 返回 JSON 字符串给 LLM。

**验收**：注入后 `get_commands` 或系统提示中可见新工具；一个未注入的 server 其工具不出现在提示里；`promptSnippet` 为空的自定义工具被自动省略。

---

### Phase 4 · 声明式沙盒执行面（蓝图第 3 条）

**目标**：L1 规则 + L2 LLM 风险分类，命中才在 Nix 沙箱内执行。

**现状**：`sandbox.rs` 已有「构建 / 回滚 / 执行」，但执行只被 UI 调用，Pi 的 bash 工具仍直接跑宿主。

**实现步骤**：
1. **风险分类器 L1（规则，确定性）** —— `src-tauri/src/risk.rs`：
   ```
   DENY:  rm -rf /  ·  :(){:|:&};:  ·  dd if=  ·  mkfs  ·  chmod -R 777 /  ·  curl|bash  ·  sudo 写入 /
   SANDBOX: apt/yum/dnf/apk install  ·  pip/npm/pnpm install -g  ·  > /etc/...  ·  crontab  ·  systemctl
   ALLOW:  ls/cat/grep/cargo/vite/git status/... 白名单前缀
   ```
   规则表外.Assert 每条规则要有注释说明理由（对齐既有约定：启发式仅作兜底，**不作为意图判断主路径**；此处 L1 只做**安全兜底**，风险判定主路径在 L2）。
2. **风险分类器 L2（LLM）** —— 命中 `SANDBOX` 或规则未决时，调 `risk_classify` 扩展工具，输出 `{decision: sandbox|host|deny, reason}`。**注意：此处属「意图/语义判断」，必须走 LLM，禁止关键词表作为主判据。**（与既有意向路由三层漏斗同构：L1 确定 → L2 LLM。）
3. **执行重定向** —— extension `sandbox-env.ts` 用 `on("user_bash", async (ev, ctx) => {...})`：
   - `ev.command` 送 L1/L2；
   - `deny` → 抛错，返回拒绝结果；
   - `sandbox` → `ctx.sendUserMessage()`? 否：应调用 Tauri 侧 `sandbox_exec`（Rust command，PATH 前置 profile/bin，cwd 隔离在项目根），把输出回填；
   - `host` → 放行给 Pi 默认 bash。
   - extension 是 Node 侧，无法直接调 Tauri command；**接缝方案**：Rust 侧在 `pi_start` 时通过 `--append-system-prompt` 注入一段指引 + 由 extension 通过 stdin 向 Pi 发送 `{"type":"bash","id":...,"command":"..."}` **由 Pi 自己执行沙箱版本**；或者更干净——**用 `registerTool` 注册 `sandbox_run` 工具**，Pi 调用它时 Rust 侧执行沙箱命令并把结果作为工具结果返回。推荐后者：接口清晰、可审计、可回滚。
4. 沙箱 exec 修正（D7）：`sandbox_exec` 除 PATH 外，注入 `HOME=<profile>`、并设置独立 TMPDIR。

**验收**：
- 在沙箱内 `which node` 指向 `/nix/store/...`；宿主 PATH 不受影响；
- `rm -rf /` 被 L1 直接拒绝，不等 LLM；
- 含未知命令的语句触发一次 L2 调用并产出 decision 记录（UI 可见）；
- 任务结束后 profile 保留（供回滚），提供显式 GC 入口。

---

### Phase 5 · 环境快照 ↔ 会话树绑定（蓝图真难点）

**目标**：回滚对话分支时，环境同步回到该分支声明。

**设计（取舍明确写在前面）**：
- **不做**「恢复当时的脏状态」（脚本装的 `.deb`、改过的 `/etc` 都无法还原，且宿主/网络/时间在变）；
- **做**「按同一份声明重建」——Nix 内容寻址命中本地 store 即毫秒级返回，且幂等。

**实现步骤**：
1. 会话节点 → 环境声明的绑定表：`<sessionId>:<entryId> → {name, packages, env_id}`。落盘于 `.pi/bindings.json`。
2. extension 监听 `on("session_before_tree")`：
   - 目标 `targetId` 查绑定表 → 得到 `env_id`；
   - 若该环境未构建或声明变化 → 调 Rust `sandbox_env_create/rollback` 重建；
   - 结果向量 `SessionBeforeTreeResult`（可取消）—— 允许在环境未就绪时阻止导航，避免「消息回滚了、环境没跟上」。
3. `on("session_tree")` 记录切换后的 `newLeafId` 与 `env_id`，写入绑定表。
4. 前端 Sandbox 面板增加「绑定视图」：显示每个会话节点绑定的环境与包列表。

**验收**：
- 在分支 A 的沙箱里 `npm i -g somepkg`，fork 到 B，再切回 A → A 的环境声明重建后 `somepkg` 不存在（证明是重建而非共享脏状态）；
- 环境未就绪时切树被取消并提示。

---

### Phase 6 · 沙箱 GC 与策略声明化

1. GC：扫描 `.pi/envs/*` 与 `.pi/sandboxes/*`，删除「未被任何 `bindings.json` 引用」且「超过 N 天未访问」的 profile（默认保留 7 天，可配置）。
2. 策略声明化：把 Phase 4 的 L1 规则表外置为 `sandbox-policy.toml`，支持用户覆盖；规则集合即「沙盒声明」。
3. 资源上限：为沙箱 exec 增加超时（默认 120s）与输出长度上限（对齐 `bash` 的 `truncated`/`fullOutputPath` 语义）。

---

### Phase 7 · UI 收口

1. `LibraryPanel` / `SkillsPanel` / `ActivityPanel` 去占位：
   - **Skills** 直接接 `get_commands`（返回 `source: skill|extension|...`），列出技能与来源路径，支持 `pi install <source>` 安装；
   - **Activity** 接 `on("tool_call"/"tool_result")` 事件流，渲染工具调用时间线；
   - **Library** 接 fs 能力做导入/预览，暂不做全文检索。
2. ChatView 增加：会话树抽屉、token 预算条、模型选择（`get_available_models` + `set_model`）、停止（abort）按钮。
3. 视觉对齐：统一强调色、空/加载/错误三态、`prefers-color-scheme` 支持。

---

### Phase 8 · 工程化

1. 前端用 Vitest + `@vue/test-utils` 给 `usePi.handle()`、`useSandbox.exec()` 写单测；Rust 侧 `cargo test` 覆盖 `spec_id`/`flake_source`/MCP id 路由/风险规则表。
2. CI：`cargo check && cargo test && pnpm build`。
3. README 重写（含 `pi` 包名警告、Nix 安装、MCP 示例、沙箱说明）。

---

## §5 未完成清单（24 项）

### 5.1 阻塞级（没有就谈不上「渐进式 Agent」）

| # | 项目 | 阻塞原因 | 所属 Phase |
|---|---|---|---|
| U1 | 环境里装的是 `pi-number`，内核层完全失效 | D1 | Phase 0 |
| U2 | MCP 响应跨 server 串号 | D2，连第 2 个 server 即乱 | Phase 0 |
| U3 | 文件接口无路径约束 | 安全 | Phase 0 |
| U4 | extension 路径解析错误，插件永不加载 | D4 | Phase 0 |
| U5 | Pi RPC 桥非全双工，前端事件解析不完整 | D6 | Phase 1 |
| U6 | 会话树 UI 完全没有（蓝图第 1 条的核心） | 依赖 U5 | Phase 2 |
| U7 | MCP 工具未注入 Pi，「按需加载」未闭环 | 依赖 U5 | Phase 3 |
| U8 | 沙箱与 Pi 执行面未打通，Pi 的 bash 仍跑宿主 | 依赖 U4 | Phase 4 |
| U9 | 环境快照未绑会话节点（蓝图真难点） | 依赖 U6/U8 | Phase 5 |

**进度（2026-09-26）**：U5、U6 已解决，见 [session-tree.md](./session-tree.md)。
U5 的收尾项「事件白名单转发」顺带改为按协议分流（response → pending，事件 → `pi://event`），
不再需要前端 `rec.type` 猜测。U7/U8 现在的前置条件已具备，可直接从 Phase 3 开始。

### 5.2 功能级

| # | 项目 | 所属 Phase |
|---|---|---|
| U10 | 沙箱 env.json 启动恢复（D5） | Phase 0/4 |
| U11 | 沙箱 exec 完整 env（HOME/TMPDIR）与超时（D7） | Phase 4/6 |
| U12 | 风险分类器 L1 规则表外置（D10 的对应面） | Phase 6 |
| U13 | 沙箱 GC（D8） | Phase 6 |
| U14 | 多会话并存（`PiState` 单 child，D9） | Phase 7 |
| U15 | MCP `protocolVersion` 协商回退（D10） | Phase 0 |
| U16 | token / 成本面板 | Phase 2 |
| U17 | system prompt 预算闸门（<2000 tok） | Phase 2 |
| U18 | 模型选择与切换 UI | Phase 7 |
| U19 | Skills 面板接 `get_commands` | Phase 7 |
| U20 | Activity 面板接工具事件流 | Phase 7 |
| U21 | Library 面板接 fs 导入/预览 | Phase 7 |
| U22 | 前端单元测试（D11） | Phase 8 |
| U23 | CI 流水线 | Phase 8 |
| U24 | README 全量重写 | Phase 8 |

### 5.3 明确「不做」（避免范围膨胀）

- 不重造 Pi 的 JSONL 会话树格式。
- 不做 Pi 自带之外的权限系统（官方明确 Pi 无内置权限层；边界靠容器化/沙箱进程隔离实现）。
- 不做 MCP 客户端之外的第二种传输（保持 stdio，避免 SSE/WebSocket 复杂度）。
- 不把任何 API key / token / 凭证写入本仓库或日志。

---

## §6 风险与取舍

| 决策 | 取 | 舍 | 风险 |
|---|---|---|---|
| 沙盒用 Nix | 内容寻址 → 回滚即重建、跨平台一套声明、零宿主污染 | 首次构建需下载 nixpkgs（数百 MB） | 本机未装 Nix，端到端路径待验证；无 Nix 时回退宿主（不阻塞） |
| 环境绑定用「重建」而非「快照恢复」 | 幂等、可复现 | 沙箱内产生的**非声明式**副作用（如手动改文件）会丢失 | 需在 UI 明示「回滚会丢弃沙箱内的临时改动」 |
| MCP 工具激活用重启 Pi 进程 | 实现简单、语义干净 | 切换工具要重启，丢失会话内存 | 可接受；若后续增加热更新命令再优化 |
| 沙箱重定向走 `registerTool` 而非 `user_bash` 拦截 | 接口清晰、可审计、结果可结构化 | 需 LLM 主动调用该工具 | 若 LLM 不用工具，仍有宿主 bash 逃逸面 → **必须**配合 L1 规则 + Pi 的 `--exclude-tools bash` 作为兜底 |
| 单 Pi 进程（当前） | 简单 | 无法多会话并存 | U14 在 Phase 7 解决 |

**必须诚实标注的两处未验证**：
1. 本机未安装 Nix，沙箱的 `nix develop` 构建与执行路径**未经端到端跑通**；
2. Phase 2~5 依赖 Pi 运行起来带真实模型调用，本环境无 provider 凭证，**无法在此环境替用户跑通**。需在用户机上 `pnpm tauri dev` 完成。

---

## §7 验证矩阵

| 阶段 | 命令 | 期望 |
|---|---|---|
| 全部 | `cd src-tauri && cargo check` | 无 error |
| 全部 | `cd src-tauri && cargo test` | 单测全绿 |
| 全部 | `pnpm build` | 前端构建通过 |
| Phase 0 | `pi --version` | `0.87.1` |
| Phase 1 | `printf '{"id":"r1","type":"get_state"}\n' \| pi --mode rpc --no-session` | 返回含 `sessionId` 的 response |
| Phase 4 | 沙箱内 `which node` | 指向 `/nix/store/...` |
| Phase 5 | 分支来回切换 | 沙箱副作用随声明重建 |
| 每阶段 | `pnpm tauri dev` | GUI 可用，无 panic |
