# ALIGN-24：Token 计数真实接入

对应反馈：「这些 token 计数啥的也要加进来吧。接入真实的吧」——会话与单条消息显示 token 用量，数据必须是内核真实上报，禁止估算/演示数据。

---

## 一、完成度清单

| # | 项 | 状态 | 落地位置 |
|---|---|:--:|---|
| 1 | 会话累计用量条（输入/输出/合计/费用） | ✅ | `src/views/ChatView.vue` composer hint 行 |
| 2 | 单条 assistant 消息的真实用量徽标 | ✅ | `src/components/chat/MessageList.vue` |
| 3 | 内核 usage 事件解析（会话累计 + 单条） | ✅ | `src/composables/piEvents.ts` |
| 4 | `PiMsg.usage` / `UsageState` 类型与状态管道 | ✅ | `src/composables/usePi.ts` |
| 5 | 格式化（`fmtTokens` / `fmtCost`） | ✅ | `piEvents.ts` |
| 6 | 单测 8 条新用例（23 passed） | ✅ | `tests/piEvents.spec.ts` |

---

## 二、数据来源（真实，非估算）

对 Pi 内核 0.87.1 RPC 协议源码（`dist/modes/json-event.d.ts`、`@earendil-works/pi-ai/dist/types.d.ts`）交叉验证后的两条链路：

| 事件 | 字段 | 语义 |
|---|---|---|
| `message_update` | 顶层 `usage: Usage` | **会话累计**（内核维护，每条流式事件都刷新；内核重启自动归零） |
| `message_end` | `message.usage: Usage`（`AssistantMessage.usage`） | **该条 assistant 消息自身**的用量（provider 原始上报） |

`Usage = { input, output, cacheRead, cacheWrite, reasoning?, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`

**不累加、只镜像**：会话累计由内核维护，前端直接镜像 `message_update.usage`，避免与 per-message 差值重复计算导致口径漂移。

## 三、折算逻辑（`piEvents.ts`）

- `extractUsage(value)`：字段校验（`input`/`output`/`totalTokens` 必须是 number），`cost`/`cacheRead`/`cacheWrite` 缺失按 0 补齐；形状不合法整条拒绝（不产生半残数据）。
- `applyEvent`：
  - `message_update` → `extractUsage(rec.usage)` 成功则 `ctx.usage.last = cumulative`；
  - `message_end` → `message.role === 'assistant'` 且 usage 合法时，挂到**最后一条 assistant 消息**（`[...messages].reverse().find(...)`，因为消息列表里工具占位行会插在中间）。
- `emptyUsageState()`：`{ last: null }`。

## 四、展示

1. **会话累计条**（composer 下方 hint 行，仅在有真实数据后出现）：
   `↑{input+cacheRead+cacheWrite} ↓{output} Σ{totalTokens} · ${cost.total}`，等宽字体 + tabular-nums，hover title 标注「内核真实上报」。
2. **单条消息徽标**（assistant 消息落定后显示）：
   `↑in ↓out Σtotal $cost`，hover title 展开完整明细（含 cacheRead/cacheWrite）。
3. 数字格式：`999 → 999`、`1234 → 1.2k`、`2.5M → 2.50M`；费用 `< $0.01` 显示 4 位小数，其余 2 位。

## 五、与 Pi 的融合

- 桥（`src-tauri`）**零改动**：`pi_events::enrich` 本就原样透传未知形状，`usage` 字段随事件直达前端。
- 口径与内核 TUI footer 一致（`footer-data-provider.d.ts`：ctx.getContextUsage() + sessionManager.getEntries()）。
- 后续可扩展：`reasoning` tokens 单列、按模型分桶成本（内核 `getUsageCostBreakdown` 已有此能力，RPC 未暴露，待内核加命令后接入）。

## 六、验证

```
pnpm typecheck              No errors found
pnpm vitest run             119 passed（11 files；piEvents.spec 23 passed，含 8 条新 token 用例）
pnpm build                  ✓ 162 modules（CSS 120.51 kB / JS 293.04 kB）
```

## 七、遗留

- `reasoning` tokens 尚未单独展示（数据已在 `PiUsage.reasoning`，待 UI 需求明确）。
- 轨迹面板（ActivityPanel）尚未显示每轮用量；下一轮可把 `usage.last` 同步进轨迹头部。
