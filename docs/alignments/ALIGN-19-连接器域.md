# 连接器域完整化（C 轮）—— 实例 CRUD / 运行时健康 / 会话级作用域

对齐目标：`外部参考实现` → `packages/plugins/connectors/*`（`connectorSchema` / `connectorSelectionSchema` / 实例持久化）。
内核仍是 `pi-coding-agent 0.87.1`，本轮把「连接器」从「已连接 MCP 的只读列表」升级为**可管理的实例域**，
并补上之前缺失的**会话级选择 → 内核白名单**这条链路。

---

## 一、完成度清单

### 1.1 后端

| # | 能力 | 实现要点 | 位置 | 状态 |
|---|------|----------|------|------|
| 1 | 领域模型 | `ConnectorDefinition` / `Summary` / `ConfigView` / `Input` / `ConnectorStore` | `connectors.rs` | ✅ |
| 2 | 传输枚举 | `stdio` / `streamable-http`（kebab-case 序列化），`Default = stdio` | 同上 | ✅ |
| 3 | 运行时状态 | `discovering` / `ready` / `offline` / `disabled` + 诊断文案 | 同上 | ✅ |
| 4 | 持久化 | `connectors.json`（定义）+ `connector-selections.json`（会话选择） | 同上 | ✅ |
| 5 | 旧数据迁移 | 早期 `mcp.json` 裸数组迁移，避免升级后已配服务凭空消失 | 同上 | ✅ |
| 6 | 服务标识净化 | 只留 `[A-Za-z0-9_-]`，空格转 `-`，首尾分隔符裁掉 | 同上 | ✅ |
| 7 | 输入校验 | 名称 / 描述 / 命令 / 参数 / URL 上限，serverName 唯一性 | 同上 | ✅ |
| 8 | 凭据只写 | `authorization_token` 只进不回，读接口只返回「是否已配置」 | 同上 | ✅ |
| 9 | 启停 | `set_enabled`：停用即断连，并从所有会话选择里摘掉 | 同上 | ✅ |
| 10 | 删除 | 删定义 + 摘选择 + 杀进程，三件事一起做 | 同上 | ✅ |
| 11 | 握手复用 | `spawn_and_register` 与 `mcp_connect` 走同一条子进程握手路径 | `mcp.rs` | ✅ |
| 12 | 查询原语 | `server_tools` / `servers_detail` 改为接收 `&McpState`，便于复用与测试 | 同上 | ✅ |
| 13 | 白名单写入 | `write_active`：整体替换 `settings.json` 的 `defaultTools` | `tools.rs` | ✅ |
| 14 | 会话作用域 | `tool_scope_for` / `connectors_apply_scope`：选择 → 内核白名单 | `connectors.rs` | ✅ |
| 15 | 启动恢复 | `restore()`：应用重启后把已启用的连接器重新握手 | 同上 | ✅ |
| 16 | 命令注册 | 9 条 `connectors_*` 全部注册进 `lib.rs` 的 `invoke_handler` | `lib.rs` | ✅ |
| 17 | Rust 测试 15 条 | 净化 / 校验 / 重名 / 解码兼容 / 去重上限 / 作用域语义，全绿 | `connectors.rs` | ✅ |
| 18 | `tools.rs` 测试 2 条 | 排序去重口径、增删合并语义 | `tools.rs` | ✅ |
| 19 | 编译零告警 | `cargo check --all-targets` 0 error 0 warning | — | ✅ |

### 1.2 前端

| # | 能力 | 位置 | 状态 |
|---|------|------|------|
| 1 | 命令封装 + 错误码翻译 + 服务标识校验 + 状态文案 | `composables/useConnectors.ts` | ✅ |
| 2 | 连接器管理面板（搜索 / 列表 / 启停 / 删除两步确认 / 详情 / 工具清单） | `components/connectors/ConnectorPanel.vue` | ✅ |
| 3 | 新建 / 编辑弹窗（传输切换、命令行、参数一行一个、凭据只写） | `components/connectors/ConnectorEditorDialog.vue` | ✅ |
| 4 | 会话级选择：chips 多选 + 「应用到内核白名单」+ 注入结果回显 | 同上（面板下半部分） | ✅ |
| 5 | 孤儿工具白名单（不属于任何连接器的 `mcp__*`）保留手动勾选 | 同上 | ✅ |
| 6 | 能力中心「连接器」tab 换掉旧的 `mcp_list` 只读卡片 | `views/CapabilitiesView.vue` | ✅ |
| 7 | 对话页左侧新增「连接器」tab（`sessionId = PI_SESSION_ID`） | `views/ChatView.vue` | ✅ |
| 8 | Vitest 12 条 | `tests/connectorDomain.spec.ts` | ✅ |

### 1.3 本轮修掉的 9 个真实缺陷

| # | 缺陷 | 根因 | 修复 |
|---|------|------|------|
| 1 | `mcp.rs` `spawn_and_han外部参考ake` 里 `disconnect_inner` 被调用两次 | 重构传输层时误粘贴 | 保留一次并补注释（重连前先卸旧进程） |
| 2 | `spawn_and_register` 漏传 `app` 参数 | 重构时签名变更未同步调用点 | `apply_definition` 补传 `app` |
| 3 | `mcp::server_tools` / `servers_detail` 收 `&State<McpState>`，连接器域拿不到 | `State<T>` 只能由 Tauri 注入 | 改为收 `&McpState`，调用点靠 Deref 自动转换 |
| 4 | `ConnectorTransport` 缺 `Debug` / `Default` | `ConnectorDefinition` 派生 Debug、字段带 `#[serde(default)]` | 补 derive，`#[default]` 落在 `Stdio` |
| 5 | 老 `connectors.json` 无 `transport` 字段 → 整条定义被静默丢弃 | `transport` 是非 Option 必填字段 | 加 `#[serde(default)]`，缺省按 stdio |
| 6 | `sanitize_server_name` 把空格直接吞掉，"GitHub MCP" → "GitHubMCP" | 过滤时无替换规则 | 空格 → `-`，兼顾安全与可读 |
| 7 | `summary_of` 里 `tool_names` move 后又 `.len()` | 结构体字段先于计数移交所有权 | 先算 `tool_count` 再组装结构体 |
| 8 | 前端模板 `t.fqn` 报 TS2339 | `orphans` 的元素类型被 `raw: any` 污染 | 显式标注类型并新增 `fqnOf()` 统一拼全名 |
| 9 | `ConnectorInput` 的可选字段导致 `v-model` 类型报错 | 表单双向绑定不接受 `string \| undefined` | 表单入参改必填原始字符串，空串即「没填」 |

---

## 二、后端实现逻辑

### 2.1 三层职责边界

```
connectors.rs（定义 / 健康 / 选择）        mcp.rs（传输层）          Pi 内核
┌─────────────────────────────┐      ┌────────────────────┐
│ ConnectorDefinition（落盘） │      │ 子进程 stdio        │
│ ConnectorState（内存）      │ --→  │ initialize         │ --→ defaultTools
│ selections（落盘，按会话）  │      │ tools/list         │      （settings.json）
└─────────────────────────────┘      └────────────────────┘
```

关键点：**连接器实例是持久化的定义，内核侧长驻进程是运行时，两者生命周期独立**。
所以「删了定义」不等于「进程立刻消失的服务还能被调」，反之「进程还在」也不代表这个连接器合法。

### 2.2 状态迁移

```
                  ┌────────────────────────── 修改 / 编辑 ──────────────────────┐
                  ↓                                                            │
 create ──→ Discovering ──spawn_and_register 成功──→ Ready ────────────────────┘
                    │                                 │
                    └─ 失败 ──→ Offline(diagnostic)    └─ 停用心智：
                                streamable-http 恒为 Offline          set_enabled(false) → Disabled
                                                                     并从所有会话选择里摘掉
```

只有 `Ready` 的连接器可以被会话选中（判定入口 `ConnectorState::selectable`）。
握手成功但 `tools/list` 拿不到工具的，也不算 Ready —— 否则内核第一轮就会拿到一批叫不出名字的工具。

### 2.3 会话作用域：选择如何变成内核白名单

```
connectors_selection(sessionId)          → 该会话选中的 id 列表（内存 + 落盘）
connectors_set_selection(sessionId, ids) → 去重 → 判上限(32) → 校验 enabled/ready
                                            → 写入 selections
connectors_apply_scope(sessionId)        → tool_scope_for()：
                                              base = tools::active_tools()（settings.json）
                                              摘掉「属于「已启用但未选中」连接器」的工具
                                              补进「已选中」连接器的在线工具全名
                                            → tools::write_active(scope) 整体替换 defaultTools
```

三条不能牺牲的规则：

1. **孤儿工具必须保留**。不属于任何连接器定义的 `mcp__*` 是用户手动勾选的，不能被作用域计算吃掉。
2. **服务标识变了 = 换了命名空间**。`update` 时若 `server_name` 变化，旧进程必须先 `disconnect_inner`，
   否则旧工具名还留在内核白名单里，会调到一个已经不存在的服务。
3. **删除 / 停用必须同时摘选择**。只删定义不摘选择，会话会残留一个指向不存在 id 的引用，
   下次打开会话就是一个静默失效的悬空项。

### 2.4 为什么 `write_active` 与 `tools_activate` 要分开

| 函数 | 语义 | 使用场景 |
|------|------|----------|
| `tools_activate(tools, enable)` | 在现有集合上增删 | 用户手动勾工具 |
| `write_active(tools)` | 整体替换并排序去重 | 会话作用域（作用域就是一个完整集合） |

两者写同一份 `settings.json` 的 `defaultTools`，共用「其它字段原样保留」的写入纪律，
也共用同一道闸门（能力清单 `tools.injectable = false` 时直接拒绝写入）。

### 2.5 启动恢复

`lib.rs` 的 `setup` 里依次做三件事：读 `connectors.json` → `restore()` → 对每个已启用的定义重新握手。
不恢复的话，重启应用后所有连接器都停在 `Disabled`，列表明明在却一个都选不了。

---

## 三、与 Pi 融合改造方案

| # | 事项 | 现状 | 与 Pi 的融合方式 | 优先级 |
|---|------|------|------------------|--------|
| 1 | 内核如何看到白名单 | 写 `settings.json` 的 `defaultTools`，**需重启 `pi_start`** | 与 `tools_activate` 保持同一通道，不额外发明配置源 | 现网可用 |
| 2 | 会话作用域下发 | `connectors_apply_scope` 落盘后靠重启生效 | 后续可在 `pi_start` 之前先行写入，减少一次重启 | P1 |
| 3 | 工具调用路由 | `mcp_call(server, tool, …)` 已存在，按服务名直接 RPC | 前端只暴露 `mcp__<server>__<tool>` 全名，避免两处拼前缀 | P1 |
| 4 | `streamable-http` | 已存定义但恒为 `Offline`（诊断文案说明） | 等确定内核侧 HTTP 传输实现后再接，不假装连上 | P2 |
| 5 | 凭据传递 | 令牌只存内存 `ConnectorInput`，不落 `connectors.json` | 待接内核时改用环境变量注入子进程，不写磁盘 | P2 |
| 6 | 会话模型 | 当前用固定 `PI_SESSION_ID = 'pi-workbench:default'` | 多会话并行时把选择器接到真实 session id | P2 |

---

## 四、验证基线（全部通过）

| 命令 | 结果 |
|------|------|
| `pnpm typecheck`（`vue-tsc --noEmit`） | 通过，0 error |
| `pnpm build` | 通过，156 modules |
| `pnpm vitest run` | 102 passed（新增 12 条连接器域） |
| `pnpm check:matrix` | 通过（技能 / 扩展 / 插件校验） |
| `cargo check --all-targets`（`src-tauri`） | 0 error 0 warning |
| `cargo test --lib`（`src-tauri`） | 121 passed，0 failed |
| `pnpm app:preflight` | Node 22.22.2 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲 |

> 说明：`cargo fmt --check` 对项目内既有文件（artifacts / experts / projects 等）本就存在格式差异，
> 本轮未做全仓 `cargo fmt`，避免在无功能收益的前提下制造大量无关 diff。
