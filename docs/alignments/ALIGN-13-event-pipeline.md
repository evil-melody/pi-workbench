# 13 · 事件管线打通：桥侧合成 + 轨迹面板真实化

> 状态：**已完成（前端消费端 + 桥侧增强均已落地）**
> 上篇：12 · 智能体浏览器接事件流
> 影响面：`src-tauri/src/pi_events.rs`（新）、`pi_bridge.rs`、`ChatView.vue`、`ActivityPanel.vue`、`AgentBrowserPane.vue`、`src/utils/piEventKind.ts`

---

## 1. 问题回顾

12 号把「智能体浏览器」改造成 `pi://event` 的消费端，`classifyEvent()` 已经能识别
`turn_start` / `tool_call` / `tool_result` / `settled` / `exit`。但面板里依然空空如也——
**不是消费端的问题，是没人生产这些数据**。

桥（`pi_bridge.rs`）当时只做一件事：

```rust
// 响应归响应，其余原样 emit
if is_response(&json) { /* 路由给调用方 */ continue; }
let _ = app2.emit("pi://event", json);
```

Pi 内核不发 `tool/call`、`tool/result` 这两类事件时，前端永远拿不到工具调用记录。
继续等内核补协议不现实，改桥是唯一可控的着力点。

---

## 2. 方案：桥侧形状驱动的事件增强

新增 `src-tauri/src/pi_events.rs`，一条纯函数：

```rust
pub fn enrich(raw: &Value, meta: &EventMeta, out: &mut Vec<Value>)
```

只做三件**确定没人在做**的事：

| # | 职责 | 为什么必须做 |
|---|---|---|
| 1 | 补 `pi_ts` / `pi_seq` 元信息 | 长跑会话里 IPC 投递可能乱序，前端排序需要稳定锚点 |
| 2 | 裸字符串 `"process_exit"` → 结构化对象 | 桥原本 emit 裸字符串，消费端要为两种形状各写一套分支 |
| 3 | 从 `message_update` 内层块合成工具事件 | 内核不发工具事件时的唯一来源 |

**合成一律按字段形状推断，不硬编码内核协议。** 内核一旦自己发了独立 `tool_call` 事件，
外层 `type` 就不是 `message_update`，压根进不了合成分支——天然不会重复。

**绝不丢事件**：不认得的形状一律原样透传。

### 2.1 关键取舍

- **不在桥侧合成 `turn/start`**。轮次开始的信号已有（流式状态 → `working` 相位），
  再合成一条会与内核的自有事件打架；工具事件才是真正的空白区。
- **保留原始事件外加合成事件**，而不是替换。原始事件是唯一的事实来源，合成只是派生。
- **合成键名用 `toolArgs`**，自描述且不撞内核的其他写法；消费端键表同步认它。

---

## 3. 前端接线

### 3.1 共享订阅（避免重复消费）

面板分散在左右两栏，各自 `usePiEvents()` 会各自建一条监听，同一事件被消费两次。
改为会话页建一个实例注入下去：

```ts
// ChatView.vue
const piEvents = usePiEvents(300)
provide(PI_EVENTS, piEvents)
```

`AgentBrowserPane` 与 `ActivityPanel` 通过 `usePiEventsInjected()` 取用；
未提供时按空缓冲降级，组件仍可独立挂载（如单测）。

### 3.2 轨迹面板真实化

`ActivityPanel.vue` 从「渲染 6 类事件的静态清单 + 降级说明」改为：

- 顶部统计条：真实工具调用次数 / 轮次 / 进程退出次数
- 中部事件时间线：图标 + 类别 + 标题 + 详情 + 时刻
- 空态提示：尚无事件时说明如何触发
- 底部说明保留，但措辞改为「相位仍走降级推断，细节以本列表为准」

### 3.3 事件时间以桥为准

`classifyEvent()` 现在优先取 `pi_ts`（桥的到达时刻），没有才退回 `Date.now()`。
IPC 投递延迟会让 `Date.now()` 顺序失真，长跑会话里时间线会跳。

---

## 4. 测试

### 4.1 Rust（`cargo test --lib`，9 例全绿）

| 用例 | 断言 |
|---|---|
| `bare_process_exit_is_structured` | 裸字符串 → 结构化 + 带 `pi_seq` / `pi_ts` |
| `bare_other_scalar_passes_through` | 其他标量原样 |
| `non_object_passes_through` | Null / 数字不 panic |
| `object_gets_meta_without_losing_payload` | 加元信息不丢 payload |
| `tool_use_block_synthesizes_tool_call` | 内层 `tool_use` + `args` → `tool_call` |
| `tool_result_block_synthesizes_tool_result` | 内层带 `output` → `tool_result` |
| `text_delta_adds_nothing` | 纯文本不合成 |
| `independent_tool_event_is_not_duplicated` | 内核自带 `tool_call` 不重复合成 |
| `meta_seq_stays_unique_across_events` | `pi_seq` 单调不重复 |

### 4.2 TypeScript（新增 4 例，`vitest` 58 passed）

`tests/piEventKind.spec.ts` 追加：桥合成事件的识别、`pi_ts` 优先、无 `pi_ts` 时退回本地时刻。

> **测试抓到的真实缺陷**：桥合成事件用 `toolArgs`，前端 `ARG_KEYS` / `OUT_KEYS` 都不认它，
> 工具调用详情全部为空。修复：`ARG_KEYS` 加 `toolArgs`，`OUT_KEYS` 加 `toolArgs`（输出侧）。
> 这类「两侧键名不一致」类型检查和构建都发现不了，只有跨端行为测试能抓到。

---

## 5. 完成度

| 项 | 状态 | 说明 |
|---|---|---|
| 事件元信息（`pi_ts` / `pi_seq`） | ✅ | 桥侧打点，前端排序可用 |
| `process_exit` 结构化 | ✅ | 消费端不再区分两种形状 |
| 工具调用事件合成 | ✅ | `tool_call` / `tool_result` |
| 轨迹面板显示真实事件 | ✅ | 统计条 + 时间线 |
| 智能体浏览器共享订阅 | ✅ | 单订阅、单缓冲 |
| 事件时间以桥为准 | ✅ | 长跑会话时间线不跳 |
| 工作流面板接真实 todo | ❌ | 仍需内核或会话层提供任务数据源 |
| `waiting` / `interrupted` 真实信号 | ⚠️ 部分 | `interrupted` 由用户中断产生；`waiting` 等内核事件 |

---

## 6. 下一步

1. **P1** 工作流面板接真实数据源：内核若支持 todo/任务列表命令，接进来替换静态四步。
2. **P1** 产物卡片的 `deliverables/presented` 事件：合成侧同理可做，前端成果卡片目前靠正则抽路径。
3. **P1** `turn/start` 真实信号：轮次开始若内核不发，可在桥侧「首个文本 delta 之前」合成一次，
   需先确认内核在 rpc 模式下是否已有该事件，避免重复。
4. **P2** `pi_seq` 去重：若同一条事件被桥与内核各推一次，可在前端按 `pi_seq` 幂等过滤。

---

## 7. 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm build` | ✅ 6 chunks，CSS 75.81 kB / JS 220.86 kB |
| `pnpm vitest run` | ✅ **58 passed** |
| `pnpm check:matrix` | ✅ 31 技能 + 2 扩展 |
| `cargo test --lib` | ✅ **60 passed**（原 51 + 新增 9） |
| `cargo check` | ✅ 无新增 warning |
| `pnpm app:preflight` | ✅ Node 22.22.2 / pi 0.87.1 / cargo 1.98.1 / 端口空闲 |
