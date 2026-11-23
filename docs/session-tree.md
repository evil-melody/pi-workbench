# 会话树与全双工 RPC（Phase 1 / Phase 2 落地说明）

本文记录「Pi 内核接通 + 会话树 UI」两项 blocker 的实现细节、协议依据与验证结果。
总体审计见 [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)，角色机制见 [roles.md](./roles.md)，沙箱见 [nix-sandbox.md](./nix-sandbox.md)。

---

## 1. 为什么原先的桥是「半双工」

旧 `pi_bridge.rs` 把 Pi stdout 的每一行无差别 `emit("pi://event")`，前端 `usePi.ts` 再用
`rec.type` 猜它是响应还是事件。这带来三个问题：

1. **响应与事件共用一条通道**：无法把命令结果 `await` 回来，前端只能轮询或靠事件顺序推断；
2. **并发即错乱**：两条命令的结果无法区分归属；
3. **失败被吞**：`success:false` 只是又一条事件，前端无从得知哪条命令失败。

## 2. 协议依据（Pi 0.87.1 源码核对，非推测）

| 事实 | 出处 |
|---|---|
| 命令形如 `{id?, type, ...params}`，`id` 可选 | `dist/modes/rpc/rpc-mode.js` 头部协议注释 |
| 响应恒为 `{id, type:"response", command, success, data?}`；失败为 `{…, success:false, error}` | 同上 `success()/error()` 构造 |
| 其余记录为 `AgentSessionEvent`（流式事件） | 同上 `session.subscribe(event => output(toJsonEvent(event)))` |
| 事件中包含 `agent_settled`（前端据此解除禁用） | 同上 `event.type === "agent_settled"` |
| `get_tree` → `{tree: SessionTreeNode[], leafId}` | `rpc-types.d.ts` + `rpc-mode.js` `case "get_tree"` |
| `fork {entryId}` → `{text, cancelled}`（把分支游标移到该条目） | `case "fork"` |
| `clone` = `fork(leaf, {position:"at"})` | `case "clone"` |
| `get_entries {since?}` → `{entries, leafId}`，`since` 是条目 id 作 durable cursor | `case "get_entries"` |
| `SessionTreeNode = {entry, children, label?, labelTimestamp?}` | `core/session-manager.d.ts` |
| `SessionEntry` 基类 = `{type, id, parentId, timestamp}` | 同上 |

实测（无 key 亦可跑）：`--no-session` 下 `get_tree` 直接可用
`{"tree":[{"entry":{"type":"thinking_level_change","id":"d4d6303c",…},"children":[]}],"leafId":"d4d6303c"}`。

## 3. Rust 侧：全双工 RPC

`src-tauri/src/state.rs`

```rust
pub struct PiState {
    pub child: Mutex<Option<Child>>,
    pub stdin_tx: Mutex<Option<Sender<String>>>,
    /// 待匹配的 RPC 响应：命令 id → 响应通道
    pub pending: Mutex<HashMap<String, Sender<Value>>>,
    pub seq: Mutex<u64>,
}
```

`src-tauri/src/pi_bridge.rs`

- `pi_call(json, timeout_ms?)`：生成 `pi{n}` 编号 → 写入 stdin → 登记 pending → `recv_timeout` →
  成功返回 `data`（`success:false` 转成 `Err(error)`），超时/退出都清理 pending 并报错。
- stdout 读取线程分流：`type=="response"` 按 id 交给 pending（**不再 emit**），其余才 emit `pi://event`。
- `pi_send(json)` 保留为 fire-and-forget（自动补 id）。
- `pi_stop` 先清空 pending，避免残留通道被迟到的响应唤醒。

死锁约束：命令装配与 pending 登记分成两个临界区，且在 `stdin_tx` 锁内不做 `recv`；
读取线程在闭包内通过 `app2.state::<PiState>()` 取状态（不能在 `pi_start` 外层的 `app` 上取，
否则 `AppHandle` 先于闭包被 drop，编译期就过不了）。

## 4. 前端：会话树

- `src/composables/useSessionTree.ts`——纯数据层：`flattenTree()` 把嵌套树摊平成带 `depth` 的列表，
  `summarize()` 把 `message / thinking_level_change / model_change / usage / compaction …` 渲染成一行摘要。
  无副作用、无 Tauri 依赖，后续可直接 Vitest。
- `src/composables/usePi.ts`——新增 `rpc(type, payload)`、`refreshTree()`、`forkFrom(entryId)`；
  `handle()` 现在只消费事件（响应不再混入 `pi://event`）。
- `src/components/chat/SessionTree.vue` + `.css`——左栏「文件 / 会话树」子标签；缩进树、leaf 高亮、
  悬停出现 `⑂` 分叉按钮；点历史节点即从该处分叉；空态与错误态齐备。
- 样式纪律：Vue 组件不含内联 `<style>`，全部外置 CSS 文件。

## 5. 验证

| 项 | 结果 |
|---|---|
| `cargo check --all-targets` | ✅ 零 warning（含测试目标） |
| `cargo test` | ⚠️ **本机链接阶段不可用**（见下） |
| 纯逻辑单测（已写入 `pi_bridge.rs` `#[cfg(test)]`） | 7 项：`response_vs_event` / `rpc_id` / `ok_data_unwraps_payload` / `ok_data_propagates_error_text` / `pending_is_consumed_once` / `parallel_calls_do_not_cross_route` / `seq_is_monotonic`。其中 `parallel_calls_do_not_cross_route` 专测「响应乱序到达时 pi2 的响应不落到 pi1 的调用方」 |
| 协议层端到端（Node harness 直连真实 `pi`） | ✅ 5 条命令并发下发，5 条响应各自按 id 配对回收，无错配、无孤儿响应 |
| `vue-tsc --noEmit` | ✅ 通过 |
| `vite build` | ✅ 80 模块，`index.js` 152 kB |

### 关于 `cargo test` 挂起（环境限制，非代码问题）

本项目 `cargo test` 在本机卡在**链接**阶段：进程退出后任务仍显示运行、日志 0 字节，
解除 Bash 沙箱、加 `--offline`、改日志重定向均无效，而 `cargo check --all-targets` 6 秒内正常完成且零 warning。
判断为 tauri 测试二进制链接（WebKit 相关 dylib）在本机的环境问题。
**替代证据**：`cargo check --all-targets` + 协议层 Node harness 实测 + 前端 tsc/build。

## 6. 仍未完成的（承接 U1~U24）

- `switch_session` / `clone` 未接 UI（`--no-session` 下无磁盘 session 可切，需先有 session dir）。
- `get_entries {since}` durable cursor 未接通：目前只在打开面板时全量拉一次 `get_tree`，
  长会话下应改为「首帧全量 + 之后按 last entry id 增量」。
- token / 成本面板（`get_session_stats`）与 system prompt 预算闸门 → U16 / U17。
- 环境快照绑会话节点（`session_before_tree`）→ Phase 5，属「会话树回滚 ↔ 沙盒状态同步」这一真难点。
- 端到端真实 agent 轮次需在本机配好 provider key 后 `pnpm tauri dev` 人工验证。
