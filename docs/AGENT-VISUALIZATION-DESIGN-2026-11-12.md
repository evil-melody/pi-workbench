# 专家（agent）运行可视化设计

> 目标：把「每个 agent 怎么跑」从黑盒变成可读的分道时间轴。设计必须能落在现有 journal 与扩展事件上，缺什么就明写缺什么。

## 1. 目标与非目标

目标：

- 一眼看出这一轮**谁在跑、跑到哪、卡在哪、花了多久**。
- 工具调用、返回、失败、重试、确认，按 agent 分道。
- 多 agent 时能看到**交接**（谁把什么交给谁），而不是一坨最终文本。

非目标（第一版不做）：

- 不做全量 trace 存储与跨会话检索。
- 不做 token 计费/成本归因（内核事件暂未提供 usage）。
- 不伪造成员级工具调用；拿不到就不画。

## 2. 统一事件模型

所有可视化只读一种结构，来源可以是 journal、扩展运行日志、或将来的 RPC 流：

```json
{
  "schema": "agent-event/1",
  "seq": 41,
  "ts": 1762900000123,
  "runId": "r-8f3a1c",
  "agent": { "id": "main", "name": "主理人", "role": "code-review-expert", "parentId": null },
  "lane": "main",
  "turn": 3,
  "kind": "tool",
  "span": { "id": "call_abc", "parentId": "turn-3" },
  "tool": { "name": "bash", "callId": "call_abc" },
  "status": "ok",
  "durationMs": 1840,
  "summary": "pnpm typecheck",
  "error": null,
  "artifacts": []
}
```

字段约定：

| 字段 | 含义 | 现状 |
| --- | --- | --- |
| `runId` | 一次用户请求的运行 id | **缺**，需 Rust 侧盖章 |
| `agent.id` | 唯一 agent 身份 | **缺**，全部事件都属主理人 |
| `agent.parentId` | 谁派生的 | **缺**，团队无此关系 |
| `lane` | 界面分道 key | 由 `agent.id` 派生 |
| `turn` | 内核轮次 | 有 `turn_start` / `turn_end`，可计数 |
| `span.id` | 工具/模型/轮次片段 | 工具有 `toolCallId`；模型/轮次需合成 |
| `kind` | `turn` / `model` / `tool` / `handoff` / `approval` / `retry` / `error` | 现有事件可映射子集 |
| `status` | `running` / `ok` / `failed` / `blocked` / `cancelled` | 工具只有 `isError` |
| `durationMs` | 耗时 | **缺**，用起止事件差值 |
| `summary` | 一行摘要 | 工具名 + 参数摘要可得 |
| `artifacts` | 产出文件/片段 | 团队产出是整段文本 |

## 3. 采集点与补齐方式

### 3.1 主理人（现在就能做）

- 轮次：`turn_start` → `turn_end`。
- 模型调用：`message_start` → `message_end`；`message_update` 只做流式文本，不单独建 span。
- 工具：`tool_execution_start` → `tool_execution_end`，按 `toolCallId` 配对；`isError` 定状态。
- 重试：`auto_retry_start` → `auto_retry_end`；`errorMessage` / `finalError` 进 `error`。
- 失败收尾：`process_exit` 关闭当前轮并标红。

落点：`AgentLanes.vue` 直接消费现有事件流，不改内核。

### 3.2 Rust 侧需要补的字段

在 [pi_bridge.rs](file:///Users/tatsuma/Documents/GIT/pi-workbench/src-tauri/src/pi_bridge.rs) 的事件转发处补三样，成本最低：

1. `runId`：`pi_send` 时生成，`session_open` 与后续事件全部带上。
2. `agent`：固定 `{id:"main", name:"主理人", parentId:null}`；将来子 agent 用真实值。
3. `seq`：已有 `pi_seq`，保持单调即可。

这三样不改内核行为，只是给现有事件加信封，重启后生效。

### 3.3 团队成员（数据上限在这里）

现状：成员是 `pi --mode chat` 子进程，只有 stdout 文本。要让成员也进分道，两条路：

| 方案 | 做法 | 代价 | 判定 |
| --- | --- | --- | --- |
| A. 结构化运行日志（第一步） | 在 `dispatch` 里记录 `member_start` / `member_end`（含 at、ok、output 摘要、round） | 小，今天就能做 | **先做这个** |
| B. 成员走 RPC | 成员改为 `pi --mode rpc --no-session`，扩展逐行解析 stdout，把 `tool_execution_*` 转成统一事件写进同一个 run log | 中，要处理握手、错误、超时 | 二期 |

`--mode rpc` 的逐行 JSON 形状未在本仓验证，属于**未确认**，二期开工前先用一个最小脚本验证，不靠印象。

### 3.4 handoff / 黑板

现在黑板是文本拼接，没有「谁交给谁」的记录。补法：每次 `writeBoard` 同时写一条：

```json
{ "runId": "...", "kind": "handoff", "from": "成员A", "to": "成员B", "round": 1, "artifact": "...", "at": 1762900000123 }
```

界面才有箭头可画；在此之前，交接区显示「黑板已更新（无结构化交接记录）」。

### 3.5 审批

`agent-tool-gate` 的确认发生在扩展内，目前不写 journal。补法：扩展旁路写 `<app_config_dir>/.pi/gate/audit.jsonl`：

```json
{ "runId": "...", "tool": "write", "risk": "write", "decision": "approved", "scope": "...", "at": 1762900000123 }
```

界面按 agent + 时间并入对应分道。

## 4. 界面呈现

### 4.1 布局（第一版，已落地）

轨迹抽屉新增「智能体」页签：

```
┌ 智能体分道                       运行中 ┐
├ 主理人                        3 轮       ┤
│  ● 第 3 轮   1.2s  14:22:08   ⌄        │
│    └ ⚡ Read src/App.vue       120ms     │
│    └ ⚡ Bash pnpm typecheck    1.1s      │
│    └ ⚠ 自动重试 1/2                     │
│    └ ✓ Write src/App.vue       80ms     │
├ 团队分道                    2 支团队     ┤
│  [团队选择 ▾]                    ↻      │
│  #8f3a1c  顺序  14:20:11               │
│    ● 架构师   产出   ...                │
│    ● 实现者   未跑通 ...                │
└ 粒度说明：成员只有起止与产出 …          ┘
```

- 纵向时间轴：抽屉宽度有限（320–440px），纵向比横向甘特更省空间；宽屏将来可切换横向泳道。
- 轮次默认折叠，**最新一轮自动展开**；手动折叠后不因新事件强制弹开。
- 工具行显示：图标 + 名称摘要 + 参数/结果摘要 + 耗时 + 时间。
- 失败：行标红、图标换警告、错误摘要可 hover 全文。
- 重试：轮次头部出 `重试 N` 徽标，轮内出 `自动重试 a/b` 行。

### 4.2 多 agent 形态

- 每个 agent 一条泳道（团队区按 runId 分卡片，卡片内按成员分行）。
- 交接：泳道之间用「→ 对象：产物摘要」连接；无数据时降级为文字说明。
- 并发：`parallel` 成员的起点相同，按时间戳排序，不伪造先后。
- 失败与重试：成员失败标红并保留错误输出；重试需二期有重跑记录后才能画。

### 4.3 降级规则

| 级别 | 条件 | 界面 |
| --- | --- | --- |
| L0 | 只有主理人事件 | 单道轮次时间轴 + 底部粒度说明 |
| L1 | 有团队运行日志 | 增加成员分道（起止 + 产出），交接区标注「未采集」 |
| L2 | 成员 RPC + handoff + 审批齐备 | 完整分道、交接箭头、审批节点、重试链 |

**不降级成假数据**：缺的字段显示「未采集」，不用 0 或占位时间填充。

### 4.4 状态与可访问性

- 六态：折叠/展开、hover、focus-visible、running、failed、disabled（日志读取中）。
- `aria-expanded` 标在轮次按钮上；刷新按钮有 `aria-label`。
- 颜色只表达状态，文案同时给出「产出 / 未跑通 / 重试」。
- 390px：单列，时间与耗时右对齐，长输出换行不横向溢出。

## 5. 第一版范围（已实现）

- 新增 `AgentLanes.vue` / `AgentLanes.css`，挂在轨迹抽屉「智能体」页签。
- 主理人：轮次、工具起止耗时、失败、重试、消息文本行。
- 团队：读取 `.pi/teams/<id>.jsonl`，按 `runId` 归并，成员分道显示状态与产出，可展开全文。
- 新增 Rust 命令 `agent_team_runs(team_id)`，只读日志，不写任何状态。
- 明确展示数据缺口，不补假数据。

## 6. 二期清单（按依赖排序）

1. Rust 事件信封：`runId` + `agent`。
2. 团队运行日志补 `member_start` / `member_end`（含耗时、round）。
3. 黑板写入记 `handoff`。
4. 工具门审批旁路审计。
5. 成员 RPC 化，接工具级事件。
6. 横向泳道视图与跨轮筛选。

## 7. 验收

- 单轮对话：能看到至少 1 轮、每个工具一行、耗时非零、失败标红。
- 团队调度：能看到每个成员的起止顺序与产出，`ok:false` 标红。
- 无数据：空态文案准确，不出现「0 个 agent」之类的误导。
- 1440 / 1024 / 768 / 390 四视口无横向溢出；深浅色均使用令牌。

## 8. 运行链路图形化（2026-11-12 修订）

- 链路只在过程抽屉「轨迹」页签里以节点图呈现（`RunGraph.vue` / `RunGraph.css`）：
  请求进入 → 内核 → 模型 → 工具 → 工具门 → 扩展 → 回写 → 结束。
- 图用 SVG 手绘（无图库）：左侧独立时间轴 `RAIL_X=12` + 右侧节点卡 `NODE_X=30`，
  连线只走节点左侧轨道，任何宽度都不会穿过节点；节点按 `agentId` 分道，
  跨道处画虚线轨 + 「交接：A → B」。树形顺序固定为「请求进入 → 内核」，
  span 之间按开始时间排序。
- 实时：`pi://event` 到达即重算；未收口节点 1s 刷新耗时，>10s 加虚线描边与「已耗时」。
  六态（进行中/完成/失败/被拒/超时/已中断）各有独立颜色与文案，点节点展开输入、输出、失败与原始事件。
- 窄屏：文字用 canvas 实测宽度截断（mono 文案单独量）；390 下由
  `scripts/lib/preview.mjs` 的 `inspectRunGraph` 断言节点不重叠、连线不穿节点、文字不被裁。
- 消息气泡只保留一行「运行链路」入口，点击展开抽屉并滚到本轮；不再在气泡下重复整张图。
- 中断收口：整轮 `cancelled` 时，所有未收口环节一并落成「已中断」，不再停在进行中；
  被下一次请求顶掉的旧 run 同样处理。
