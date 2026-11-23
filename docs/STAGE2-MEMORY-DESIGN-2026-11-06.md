# 阶段 2：记忆个性化 · 设计稿

> 状态：**已按定稿口径实施（2026-11-06）**。定稿：向量后置只交评测基线；画像用最小四字段；纠错 append-only + 失效态；召回注入统一 `before_agent_start`；主动任务单轮写入上限 3 条。
> 实施落点：`memory_store.rs`（物化 / 撤销 / 立即永久删除 / 画像折叠）、`agent-memory.ts`（`before_agent_start` 注入 + update/forget 工具 + 主动任务限流）、`MemoryView.vue`（检索 / 更正 / 永久删除 / 画像面板）、`eval/memory-recall-100.jsonl`。
> 范围：记忆检索 / 用户画像 / 纠错遗忘 / 主动任务接入。**不含**商业化、多租户、计费。
> 基线：阶段 1 已完成（scheduler + inbox + 预授权 + 后台驻留）。
> 设计目标不是把 `PRODUCT-AUDIT` 的每一行都做完，而是先补「完全缺失」的三件事：纠错、遗忘、画像；召回质量用可度量的方式推进，不靠上向量库蒙。

---

## 0. 一句话结论

**结构化检索优先，向量本轮不打通；画像从记忆的保留标签折叠生成，不另开档案；纠错走 append-only 事件流 + 失效态，物理行不删；召回与写入统一挂在 Pi 扩展的 `before_agent_start`，对话页和主动任务走同一条路。**

---

## 1. 现状（哪一种是「哪种」）

| 能力 | 现状 | 证据 |
|---|---|---|
| 存储 | 全局单文件 `<config>/.pi/memory/memory.jsonl`，追加写，字段只有 `ts/text/tags` | `src-tauri/extensions/agent-memory.ts` 的 `MemEntry` / `memoryFile()` |
| 召回 | 词面评分：中文 bigram + 标签 ×2 + 覆盖率归一 + 7 天半衰期微加分；无 id、无状态、无过滤 | 同文件 `queryTerms` / `scoreOf` |
| 人面读取 | Rust 直读 JSONL 前 200 行原样返回，与 agent 侧评分逻辑各写各的 | `src-tauri/src/agent_ops.rs` 的 `agent_memory_list` |
| 向量层 | Rust 侧 LanceDB（`memory_vec_*`），表 schema 有 id，但**只有外壳能查**，Pi 进程加载不了 native，agent 够不到 | `src-tauri/src/memory_vec.rs` 文件头 + `entry_id` / `search_at` |
| 画像 | 不存在。无 schema、无注入、设置页只有模型与主题 | 全仓无 `profile` 相关读写 |
| 纠错/遗忘 | 不存在。UI 只有列表 + 新增；工具只有 `memory_store` / `memory_recall` | `MemoryView.vue`、`agent-memory.ts` |
| 主动链路 | `proactive::execute` 把 `job.prompt` 原样下发，前后不读不写记忆 | `src-tauri/src/proactive.rs` 的 `execute` |
| 注入点 | 已有先例：`role-inject.ts` 在 `before_agent_start` 往 `appendSystemPrompt` 追加，保留 Pi 自带段 | `src-tauri/extensions/role-inject.ts` |

关键事实（有两处和 `PRODUCT-AUDIT` 的乐观描述不同）：

1. `before_agent_start` 的上下文**带原始用户输入** `prompt`（Pi 0.87.1 `dist/core/extensions/types.d.ts` 的 `BeforeAgentStartEvent`）。所以「召回注入」可以只写一处，对话页与主动任务都覆盖，不需要在 Rust 里再写一份评分。
2. 本机 `127.0.0.1:11434` 实测不可达（Ollama 未安装/未启动）；`memory_vec.rs` 里的真实语义 A/B（`EMBED_REAL=1 cargo test ab_recall`）**从未跑过真实模型**，只有离线概念词表代理。向量召回在当前机器上无法验收。

---

## 2. 四个问题的回答

### 2.1 向量召回，还是先做结构化检索？

**现状**：词面召回能跑，但没有 id、没有状态、没有失效、没有过滤；同义改写漏召回。向量层存在但 agent 够不到。

**改成**：**本轮只做结构化**，向量不打通。

- 记录加 `id`（与 Rust `entry_id(ts,text)` 同一算法：`{ts}-{sha256 前 8 hex}`），两边 id 天然对齐；
- 记录加 `op`（`add/update/forget`）、`state`、`source`、`job_id`、`rev`；
- `memory_recall` 返回 `id`，支持 `tags` 过滤，只返回 `state=active`；
- 去重：同 id 覆盖为 update；文本归一化后完全相同的直接合并；
- 评分公式不变（现有多信号评分经过 harness 单测），只加过滤与 tie-break，不重写。

**为什么不上向量（取舍理由）**：

| 维度 | 打通向量 | 结构化优先（选它） |
|---|---|---|
| 可行性 | 扩展进程只能 `node:` 内置模块，LanceDB 用不了；要在 TS 侧重写 embedding 客户端 + 向量文件 + 暴力余弦（约 150 行） | 现有 JSONL 加字段，TS/Rust 各改一处读侧 |
| 运行依赖 | 依赖本机 embedding 服务；当前机器没有，失败即降级，用户无感劣化 | 无外部依赖，离线可用 |
| 可验证性 | 真实 A/B 从未跑过，`≥80%` 无基线可对 | 每个能力都能写确定性单测 |
| 收益 | 只优化「召回命中率」一个子项 | 补上纠错、遗忘、画像三项**完全缺失**能力 |
| 风险 | 向量行与 JSONL 的一致性、删除后残留召回 | append-only 事件流，无跨进程写冲突 |

**代价（诚实列出）**：

- 同义改写仍然召不回。`PRODUCT-AUDIT` 阶段 2 的「同义改写 Top5 命中率 ≥80%」**本轮不会达成**，改为「交付固定 100 条评测集 + 词面基线实测值」。这是本设计唯一一处**主动降低验收口径**的地方，需要你确认（见 §8）。
- 结构化只提升「可纠正、可遗忘、可过滤」，不提升语义覆盖。

**升级路径（写死，不留悬念）**：评测集落地后若缺口 > 20 个百分点，按 `docs/WORKDSH-ALIGN-26-harness-gap-analysis.md` §7.3 方案 A 在扩展侧做 `vectors.json` + 暴力余弦 + RRF，与词面分融合；**不引入 LanceDB**（Rust 侧那份保留给外壳用，不并入 agent 路径）。改造点是 `agent-memory.ts` 一个文件 + 一个 `memory_vec.json` 开关，默认关。

---

### 2.2 用户画像怎么从记忆里长出来

**现状**：不存在。审计文档建议新增 `profile.json` 并在设置页手工编辑——那会变成第二份需要人维护的档案，必然和记忆打架。

**改成**：约定**保留标签族**，画像 = 记忆的折叠视图，不是独立录入表。

- 写入约定（工具描述里写清，模型按需使用）：
  - `profile:name=<称呼>`、`profile:lang=<语言>`、`profile:tz=<时区>`、`profile:tone=<汇报风格>`、`profile:hours=<工作时段>`
  - `taboo:<约束>`（多条并存，例如「不要用感叹号」「不要自动提交 git」）
- 推导（**Rust 单一实现**，不重复写两份）：按 key 取最新一条为当前值，`evidence` 记录所有支撑条目 id，`confidence` 用证据条数（不引模型打分）。
- 产物：`<config>/.pi/memory/profile.json`（tmp + rename 原子写），只读消费。
- 注入：`agent-memory.ts` 的 `before_agent_start` 读 `profile.json`，追加到 `appendSystemPrompt`：
  ```
  ## 用户画像（由记忆推导，N 条证据）
  - 称呼 / 语言 / 时区 / 汇报风格 / 工作时段
  - 禁忌：…
  ```
  上限 500 字、只注入有证据的字段，避免 token 膨胀。
- UI：`MemoryView` 顶部「画像」面板，只读展示值 + 证据条数 + 更新时间；「修改」= 往记忆里写一条新的 `profile:*`（来源标记 `ui`），**没有独立表单**。删掉支撑记忆，画像自动消失。
- 刷新时机：写记忆后、应用启动时、以及 `proactive` 每 10s tick 检查 `memory.jsonl` mtime 变化时重推。最坏陈旧 10s。

**代价**：

- 画像质量取决于模型是否按约定打标签。第一版接受「宁缺毋滥」：没标签就不进画像，不做从闲聊里猜。
- 每轮多注入 ≤500 字，属于固定开销；对短对话是净成本。

**明确不做**：从对话原文自动推断性格/情绪/习惯（需要二次模型标注，误差不可控）；画像的版本历史与 A/B 开关。

---

### 2.3 纠错与遗忘（当前完全缺失）

**现状**：只有追加写。用户说错了、过时了、要删了，无入口、无工具、无状态位；一旦写进 JSONL 就永久参与召回。

**改成**：**append-only 事件流 + 物化**（不原文件改写，避免 TS / Rust 两个写者互相覆盖）。

- 定位：
  - 工具侧：`memory_recall` 现在返回 `id`，模型先召回再操作；
  - 人面：`MemoryView` 搜索框按文本/标签做本地 substring 过滤（**不引第二套评分**），卡片上暴露 id 与操作。
- 修改：`memory_update(id, text?, tags?)` → 追加一条 `{op:'update', id, ts, rev+1}`。旧行保留作审计，物化时以最高 rev 为准。
- 遗忘：`memory_forget(id)` → 追加墓碑 `{op:'forget', id, ts}`；同时 best-effort 删除 LanceDB 对应向量行。
- 「保证不再被召回」三道闸：
  1. 读侧物化时过滤 `state=active`（`agent-memory.ts` 与 `agent_ops.rs` 都要过滤）；
  2. 向量检索结果按 active id 集合过滤（`memory_vec_search` 出口）；
  3. 向量行尽力删除；删失败也有闸 2 兜底。
- 「1 秒内不可见」怎么保证：`loadAll()` 每次调用都读盘，**进程内没有缓存**，所以写入即生效；这点是现状就满足的，不需要额外机制。审计文档里担心的「与 Pi 进程内缓存一致性」不成立，本设计不引入缓存。

**代价**：

- JSONL 从「条目流」变成「事件流」，两个读侧都要改物化逻辑；老数据（无 `op`）按 `add` 处理，`id` 现算，向后兼容。
- 文件会累积历史行；本轮不压缩、不做回收站 UI，超量后需要人工或后续阶段补压缩。
- 回滚风险：若退回旧版本读侧，`forget` 行会被当成普通条目解析失败丢弃（旧版只认 `ts/text/tags`），被遗忘的记忆在旧版里**会复活**。升级后不建议回退。

**明确不做**：回收站/撤销 UI、批量合并工具、按时间自动过期（用户说「过时了」等价于更新或遗忘，不额外造 TTL）。

---

### 2.4 挂到主动任务链路

**现状**：`proactive::execute` 只下发 `job.prompt`，任务执行前后都不碰记忆；记忆只在对话页由模型自行调用。

**改成**：**读走扩展、写走工具**，不新增进程、不新增内核、不改账本。

- 召回（统一入口）：`agent-memory.ts` 的 `before_agent_start` 用 `ctx.prompt` 当查询词，召回 ≤5 条、命中分低于阈值不注入，追加到 `appendSystemPrompt`。对话页和主动任务**自动都走这条路**，因为两者都是同一次 `send_prompt`。
- 写入：
  - `proactive::execute` 在 `job.prompt` 前加一行头部：`【主动任务 <job_id>】<title>` + 一句「如产生可复用的长期结论，用 memory_store 写入」；
  - 扩展识别该头部，在本轮给 `memory_store` 自动补 `source=proactive`、`job_id`、标签 `proactive`，并把单轮写入上限压到 3 条，防刷；
  - 任务头在 `before_agent_start` 里重置计数，不跨轮泄漏。
- Inbox：**不改**。任务结果照旧进收件箱；记忆条目在 `MemoryView` 可按 `proactive` 标签筛出来。

**代价**：

- 每次主动任务 prompt 多约 60 字，召回注入最多 500 字；
- 召回注入会改变系统提示内容，同一会话里每轮都不同，**可能削弱 provider 侧的前缀缓存**（每轮重新计费的 prompt 段变长）。这是本设计最实际的隐性成本。
- 主动任务可能写出低质量记忆；靠「≤3 条 + 带 job_id 可追溯」控制，不做自动清洗。

**明确不做**：主动任务结果自动整段写记忆（噪声大）、inbox 展示记忆关联、按任务维度做记忆隔离。

---

## 3. 数据模型（增量，向后兼容）

```jsonl
{"ts":1730000000000,"text":"…","tags":["偏好"],"id":"1730000000000-1a2b3c4d","source":"chat","rev":1}
{"op":"update","id":"1730000000000-1a2b3c4d","ts":1730000100000,"text":"…","tags":["偏好"],"rev":2}
{"op":"forget","id":"1730000000000-1a2b3c4d","ts":1730000200000}
```

- 缺 `op` → `add`；缺 `id` → 按 `{ts}-{sha256(ts||text) 前 8 hex}` 现算；缺 `rev` → 1。
- 物化规则：按行序重放，`update` 覆盖同 id 的 `text/tags/rev`，`forget` 置 `state=deleted`；输出只保留 `active`。
- 上限：读侧统一 500 条（现状 Rust 200 / TS 无上限，本轮对齐），超出不自动归档。

---

## 4. 改动面（实施时按此清单，不扩散）

| 文件 | 改动 |
|---|---|
| `src-tauri/extensions/agent-memory.ts` | id/事件流物化、状态过滤、`memory_update`/`memory_forget`、召回注入、画像注入、主动任务打标与限流 |
| `src-tauri/src/agent_ops.rs` | `agent_memory_list` 改物化语义；新增 `agent_memory_update` / `agent_memory_forget` / `agent_profile_get` |
| `src-tauri/src/memory_vec.rs` | 检索出口按 active id 过滤；遗忘时删向量行；reindex 只吃 active |
| `src-tauri/src/proactive.rs` | `execute` 拼任务头；tick 里加记忆 mtime → 画像重推 |
| `src-tauri/src/lib.rs` | 注册新命令 |
| `src/composables/useAgentOps.ts` | 类型 + 新命令封装 |
| `src/views/MemoryView.vue` + `MemoryView.css` | 画像面板、搜索、编辑/遗忘入口、失效默认隐藏 |
| `scripts/test-harness-p3.ts` | 物化 / 更新 / 遗忘 / 画像折叠 / 主动头解析的单测 |
| `docs/PRODUCT-AUDIT-2026-11-06.md`、`README.md` | 阶段 2 实现状态与口径修正 |

**不动**：DojoAgents 框架层、`proactive` 账本结构、inbox、预授权策略、内核启停逻辑。

---

## 5. 本次做 / 明确不做

**本次做**

1. 记忆记录加 id / op / state / source / job_id / rev，append-only 物化。
2. `memory_recall` 返回 id、支持 tags 过滤、只返 active。
3. 新增 `memory_update` / `memory_forget` 工具与对应 Rust 命令；向量层同步过滤与删除。
4. `MemoryView` 增加搜索、编辑、遗忘（确认弹窗）、失效默认隐藏。
5. 画像：保留标签族 → Rust 折叠 → `profile.json` → 系统提示注入 → UI 只读 + 改写入记忆。
6. 召回注入统一走 `before_agent_start`，覆盖对话与主动任务。
7. 主动任务：prompt 头 + 自动打标 + 单轮写入上限 3 条。
8. 100 条固定评测集 + 词面基线实测值（只记录，不阻塞）。

**明确不做**

- 打通向量召回 / 在扩展侧实现 embedding / 引入任何向量库（本轮）。
- 自动从对话推断画像、画像版本历史、画像 A/B。
- 回收站、撤销、批量合并、日志压缩、自动过期。
- inbox 与记忆的关联展示、按项目隔离记忆。
- 多语言 i18n、时区换算引擎（画像只记录时区字段，不改变现有时间显示）。
- 商业化 / 多租户 / 计费（沿用既定边界）。

---

## 6. 验收口径

**单测（确定性）**

- 物化：add → update → forget 后 active 集合正确；老格式（无 op/id）能读。
- id 稳定：同 `ts+text` 在 TS 与 Rust 两侧算出同一 id。
- 遗忘：`memory_forget` 后 `memory_recall` 与 `memory_vec_search` 都不再返回该条。
- 画像：`profile:tone` 两条取最新；删掉证据后画像字段消失；无标签时 `profile.json` 为空且不注入。
- 主动头：`【主动任务 job-x】` 能被扩展识别，写入自动带 `job_id`，单轮超 3 条被拒。

**回归**

- `cargo test`、`pnpm test`、`pnpm typecheck`、`pnpm build`、`check:extensions` 全绿；
- `graphify update .` 一次，新增符号可在图中查到。

**评测**

- 交付 `eval/memory-recall-100.jsonl`（100 条查询 + 期望命中 id）与一次词面 Top5 命中率实测值；
- **本轮不承诺 ≥80%**，理由见 §2.1；是否在下一轮把向量纳入，用这次基线决定。

**手动清单（真机）**

1. 记忆页搜索「偏好」，编辑一条，再在对话里 `memory_recall` 验证返回新文本。
2. 遗忘一条，1 秒内再召回确认消失；向量检索面板也搜不到。
3. 说「记住我偏好电报体」，查画像面板出现 `tone`，下轮对话系统提示里能看到。
4. 建一个 1 分钟周期的主动任务，跑完后记忆页出现带 `proactive` 标签的条目。

---

## 7. 风险与回滚

| 风险 | 处置 |
|---|---|
| 两个写者并发写 JSONL | 只追加不改写；物化在读侧完成，无需锁 |
| 事件流文件膨胀 | 读侧 500 条上限 + 明确不做压缩；后续阶段补压缩 |
| 系统提示膨胀 / 前缀缓存失效 | 画像 ≤500 字、召回 ≤5 条且设阈值，均可关 |
| 画像陈旧 | 启动 / 写记忆 / 10s tick 三处刷新，最坏 10s |
| 主动任务刷记忆 | 单轮 ≤3 条 + job_id 可追溯 |
| 回退旧版 | 旧读侧会把 forget 当无效行丢弃，被遗忘记忆复活；回退需先清理 JSONL |

---

## 8. 需要你确认的四点

1. **接受「本轮不打通向量，改为交付 100 条评测基线」吗？** 不接受的话，本轮要加扩展侧 embedding 客户端，且验收依赖本机 Ollama（当前不可用）。
2. 画像字段集 `name / lang / tz / tone / hours / taboo` 是否够用？
3. 遗忘是硬失效、不做回收站与撤销，可以吗？
4. 主动任务自动打标 + 单轮最多写 3 条记忆，可以吗？

确认后按 §4 清单实施，先做数据模型与工具（可单测），再改 UI，最后挂主动任务。
