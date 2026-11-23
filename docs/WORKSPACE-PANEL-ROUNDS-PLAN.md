# 工作区面板「轮次」1:1 对齐 WorkDSH 改造方案

> 范围：仅左侧栏「工作区」一块（项目 → 对话 → 轮次）。对话主区、右侧面板不在本方案内。
> 目标参照：https://github.com/techflag/workdsh （WorkDSH 桌面端侧栏，README 截图
> `apps/web/assets/screenshots/workdsh-projects-alpha8-dark.png`「the complete desktop sidebar」）。
> 状态：方案（未实施）。本文件只描述设计，代码现状以仓库为准。

---

## 1. 问题定义

### 1.1 用户反馈
- 界面「没变化」：工作区列表与早期版本观感一致，未细化、未美化。
- 「一直显示一轮」：每条对话行尾只有一个 `N 轮` 小徽标。绝大多数段 `prompts=1`，
  看起来永远是「1 轮」；即便一条对话里用户下发了多次任务，也只看到一个数字，
  看不到「这一轮说了什么、什么时候、跑到哪一步」。

### 1.2 代码现状（已核对）
| 层 | 文件 | 现状 |
| --- | --- | --- |
| 侧栏骨架 | `src/components/layout/Sidebar.vue` L236-292 | 项目行 → 展开箭头 → 嵌套 `RunHistory` |
| 对话列表 | `src/components/chat/RunHistory.vue` L301-342 | 一行一对话：标题 + `{{prompts}} 轮` 徽标 + 相对时间 + hover「···」 |
| 列表样式 | `src/components/chat/RunHistory.css` L102-119 | 「N 轮」是弱化的灰底小计数点 |
| 数据源（前端） | `src/composables/useReplay.ts` L128-145 | `RunRecord`：`prompts`(计数)、`title`(首条用户消息)，**无轮次明细** |
| 数据源（后端） | `src-tauri/src/pi_bridge.rs` L784-812 | `JournalSessionSummary` 同上；journal 内每条 `message_end role=user` 可提取（L816 `user_message_text`），但未随段返回 |

**根因**：轮次明细在 journal 里本就存在，只是后端只聚合出「计数 + 首条标题」，
前端没有可渲染的逐轮数据，UI 退化成一颗数字徽标。

---

## 2. WorkDSH 1:1 参照拆解

WorkDSH 侧栏「工作区」一块的层级与显示规则（据 README 描述 + 截图 + 现有对齐代码注释归纳）：

```
工作区 (Workspace)
└─ 项目 (Project)            ← 一行，带目录图标 + 名称 + 相对时间 + 「···」
   └─ 之前的运行记录          ← 展开后是该项目的对话列表（session 段）
      └─ 对话 (Conversation)  ← 一行：标题 + 轮次/时间元信息 + hover 操作
         └─ 轮次 (Round)      ← 一条对话内的多次用户下发，可逐条展开/定位
```

WorkDSH 的关键显示约定（本方案要对齐的点）：
1. **对话 ≠ 轮次**：一条对话是一整段会话；一轮 = 用户一次下发 + 助手一次完整应答。
   列表里对话行要能体现「这段里有几轮」，且点开能看到每一轮。
2. **轮次是一等公民**：每轮有独立标题（用户首句摘要）、独立时间戳、独立状态
   （完成 / 进行中 / 失败），点击某轮直接定位到转写中该轮的位置。
3. **视觉层级用缩进 + 左边轨**：项目 → 对话 → 轮次三级缩进，选中态用 inset 左边轨
   （现有 `.ws-list li.active` / `.rh-item.checked` 已是这套语言，沿用并下推到轮次级）。
4. **元信息右对齐、等宽数字**：时间列、轮次列不抖动（现有 `.rh-time` 已 tabular-nums）。
5. **hover 才露操作**：常态干净，「···」/ 计数细节滑上去才出现。

> 诚实声明（2026-11-01 实查 `github.com/techflag/workdsh`，Desktop `3.0.0-alpha.4`，MIT）：
> README 与递归文件树（`apps/desktop` Electron 壳、`apps/web`、`packages` 共享 UI/插件）
> 均**未**描述「对话行 → 可展开轮次子列表」这一形态。WorkDSH 侧栏的可核实信息层级是
> **Project（项目）为中心**：README 原文 "Projects bring instructions, plans, tasks,
> material, and capability settings together"，「the complete desktop sidebar」截图
> `apps/web/assets/screenshots/workdsh-projects-alpha8-dark.png` 呈现的是**项目列表 +
> 项目内会话/任务**，侧栏另有 Collaboration 等并列区块。
> 结论：本方案的「逐轮可展开子列表」是 WorkDSH「项目→会话」层级**向下的一层延伸**，
> 而非 WorkDSH 已逐像素实现的既有形态——这点在评审时须明确，避免误标为「照抄」。
> 真正 1:1 可对齐的硬事实：三级缩进语言、元信息右对齐等宽数字、hover 才露操作、
> 项目→会话的父子树。轮次粒度是 pi-workbench 的 journal 数据（每段多条 `message_end
> role=user`）决定的本地增强。若后续提供 WorkDSH 轮次区真实截图，仅校准 §5.4 视觉，
> 数据模型（§4）不变。

---

## 3. 目标信息架构

三级可折叠树，全部活在现有 `RunHistory` 一块板子里（不新增顶层导航项）：

```
项目行 (Project)                       [现有]
 └ 对话行 (Conversation)               [现有 RunRecord 一行]
    ├ 轮次摘要徽标：「3 轮」+ 末轮时间   [改造：徽标可点 = 展开逐轮]
    └ 展开后 → 轮次列表 (Round list)    [新增]
       ├ 轮 1  「分析当前项目结构…」   5小时前  ✓
       ├ 轮 2  「修复 sidebar 撑高…」   2小时前  ✓
       └ 轮 3  「跑一下测试」           1小时前  ⟳/✗
```

- 对话行默认折叠轮次（保持现有紧凑列表观感）。
- 点对话行 = 打开整段回放（现有行为，不变）。
- 点轮次徽标 / 对话行左侧新增的轮次箭头 = 展开逐轮（新增，`stopPropagation`）。
- 点某一轮 = 打开回放并滚动定位到该轮（新增锚点）。

---

## 4. 数据模型改造

### 4.1 后端 `JournalSessionSummary` 增字段
文件：`src-tauri/src/pi_bridge.rs`

```rust
/// 段内每一轮的摘要（按出现顺序）。
#[derive(Clone, serde::Serialize)]
pub struct RoundSummary {
    /// 该轮在段内的序号（0 起），回放定位锚点。
    pub index: usize,
    /// 用户该轮下发正文（已剥 preamble/附件块前的原文，前端截断展示）。
    pub prompt: String,
    /// 该轮结束时间（下一条 user 消息或段尾的事件 ts）；缺则 None。
    pub ended_at_ms: Option<u64>,
    /// 该轮是否以 agent_settled 正常收尾（false = 中断/失败/进行中）。
    pub settled: bool,
}
```

- 在现有分段循环里，对每条 `message_end role=user`（`user_message_text` L816）追加一个
  `RoundSummary`；`prompts` 继续等于 `rounds.len()`，向后兼容。
- 段尾未 `agent_settled` 的最后一轮 `settled=false`，前端渲染 ⟳/✗。

### 4.2 前端 `RunRecord` 增字段
文件：`src/composables/useReplay.ts`

```ts
export interface Round {
  index: number
  prompt: string
  endedAtMs: number | null
  settled: boolean
}
export interface RunRecord {
  // …现有字段不变…
  rounds: Round[]   // 新增，长度 == prompts
}
```

`listRunHistory` 映射时透传 `s.rounds`。浏览器模式 / 后端不可达 → `rounds: []`，
UI 降级为「无明细，仅显示 prompts 计数」（不报错）。

### 4.3 回放定位锚点
`pendingReplayIndex`（useReplay.ts L12）扩展为可携带轮次：
新增 `pendingReplayRound = ref<number | null>(null)`，对话页消费时按轮次序号
在转写里定位到第 N 个 user 气泡并 `scrollIntoView`。复用现有信箱模式，不引入新通道。

---

## 5. UI 组件改造

### 5.1 `RunHistory.vue`
- 对话行 `.rh-item` 内，把静态 `{{prompts}} 轮` 徽标改成**可点击展开**：
  新增 `expandedRounds: Set<number>`（段号集合），点徽标 `toggleRounds(r.index)`。
- 行下新增 `<ul class="rh-rounds">`（`v-if="expandedRounds.has(r.index) && r.rounds.length"`），
  逐轮渲染：轮序号圆点 + prompt 摘要（单行 ellipsis）+ 相对时间 + 状态点。
- 点某轮 → `emit('open-round', { index: r.index, round: round.index })`。
- 单轮对话（`rounds.length === 1`）：徽标仍可点，但展开只有一行；或 hover 提示
  「单轮对话」直接打开。**默认仍允许展开**，保持交互一致。

### 5.2 `RunHistory.css`
新增轮次子列表样式，全部走现有主题变量，零内联：

```css
/* 轮次徽标：从纯展示变成可点（加 hover 反馈 + 光标） */
.rh-prompts { cursor: pointer; }
.rh-prompts:hover { background: var(--bg-active); color: var(--text-dim); }
.rh-prompts.open { background: var(--accent-dim); color: var(--accent); }

/* 轮次子列表：缩进贴出层级，左侧虚线导轨连到对话行 */
.rh-rounds {
  list-style: none;
  margin: 2px 0 4px;
  padding: 0 0 0 14px;
  margin-left: 6px;
  border-left: 1px dashed var(--border);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.rh-round {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 3px var(--sp-2);
  border-radius: var(--r-sm);
  font-size: var(--fs-sm);
  color: var(--text-dim);
  cursor: pointer;
}
.rh-round:hover { background: var(--bg-hover); color: var(--text); }
.rh-round-n {           /* 轮序号圆点 */
  flex-shrink: 0;
  width: 16px; height: 16px;
  display: grid; place-items: center;
  border-radius: var(--r-full);
  background: var(--bg-elev);
  font-size: var(--fs-xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-faint);
}
.rh-round-text { flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.rh-round-time { flex-shrink: 0; font-size: var(--fs-xs); color: var(--text-faint); font-variant-numeric: tabular-nums; }
.rh-round-status { flex-shrink: 0; width: 6px; height: 6px; border-radius: var(--r-full); }
.rh-round-status.ok   { background: var(--success, var(--text-faint)); }
.rh-round-status.live { background: var(--accent); }
.rh-round-status.err  { background: var(--danger); }
```

> 若主题无 `--success` 变量，用现有状态色或 `--text-faint`，不新增 token（避免发散）。

### 5.3 `Sidebar.vue`
- 项目行层级、展开箭头不变。
- `.ws-runs` 容器内 `RunHistory` 透传新事件 `@open-round`，转成
  `pendingReplayIndex` + `pendingReplayRound` 后跳 `/chat`（复用现有 `openRecord` 模式）。

### 5.4 美化细化点（对齐 WorkDSH 观感）
1. 对话行与轮次行用**同一左边轨语言**：选中 inset 2px accent（项目/对话已用，下推轮次）。
2. 轮次徽标加**轻微计数强调**：`prompts >= 2` 时徽标用 `--accent-dim` 底，
   单轮保持中性灰——一眼区分「多轮对话」值得展开。
3. 时间列统一右对齐 + tabular-nums（对话、轮次一致）。
4. 展开箭头旋转动效沿用 `.ws-caret.open` 的 `rotate(90deg)`，轮次箭头同款。
5. 列表项 `min-height` 统一（对话 30px、轮次 ~26px），密度对齐 WorkDSH 截图。

---

## 6. 交互规格

| 操作 | 行为 |
| --- | --- |
| 点对话行（非徽标区） | 打开整段回放（现有） |
| 点「N 轮」徽标 | 展开/收起该对话的轮次列表（新增，stopPropagation） |
| 点某一轮 | 打开回放 + 滚动定位到该轮 user 气泡（新增） |
| 点项目展开箭头 | 显示/隐藏该项目对话列表（现有） |
| hover 对话行 | 露「···」菜单（现有） |
| 单轮对话 | 徽标置灰不可展开，hover 提示「单轮，点击打开」 |

键盘：徽标 `role="button" tabindex="0"`，Enter/Space 切换展开；轮次行 Enter 打开定位。

---

## 7. 实施阶段

- **P0 后端上浮轮次**：`pi_bridge.rs` 加 `RoundSummary` + 分段填充；`useReplay.ts` 加 `Round`/`rounds`。
  验收：`pi_journal_sessions` 返回带 `rounds`，前端 console 可见多轮段明细。
- **P1 前端逐轮渲染**：`RunHistory.vue` 展开态 + `.rh-rounds` 子列表 + CSS。
  验收：多轮对话可展开看到每轮标题/时间/状态。
- **P2 轮次定位回放**：`pendingReplayRound` 信箱 + 对话页 scrollIntoView。
  验收：点第 3 轮，转写滚到第 3 个 user 气泡。
- **P3 美化细化**：徽标强调、左边轨下推、密度/对齐校准（§5.4）。
  验收：与 WorkDSH 截图并排，层级与观感一致。

每阶段独立可交付、可回滚；P0/P1 是解决「一直显示一轮」的最小闭环。

---

## 8. 涉及文件清单

| 文件 | 改动 |
| --- | --- |
| `src-tauri/src/pi_bridge.rs` | 新增 `RoundSummary`，分段循环收集每轮；`prompts = rounds.len()` |
| `src/composables/useReplay.ts` | `RunRecord.rounds`、`Round` 类型、`pendingReplayRound` 信箱、映射透传 |
| `src/components/chat/RunHistory.vue` | 徽标可点展开、`.rh-rounds` 子列表、`open-round` 事件 |
| `src/components/chat/RunHistory.css` | 轮次子列表样式 + 徽标可点态（§5.2） |
| `src/components/layout/Sidebar.vue` | 透传 `@open-round` → 信箱 + 跳转 |
| `src/views/ChatView.vue` | 消费 `pendingReplayRound`，回放后定位轮次 |
| `docs/`（本文件） | 方案记录 |

---

## 9. 验收标准

1. 一条含 ≥3 次用户下发的对话，列表行显示「3 轮」，展开可见 3 行轮次，每行有
   摘要/时间/状态。
2. 单轮对话不再误导为「需要展开」：徽标置灰或不可展开。
3. 点任一轮回放并定位到对应用户气泡。
4. 浏览器模式 / 后端不可达：列表正常显示对话标题 + 计数，无报错、无空轮次块。
5. 三级缩进（项目/对话/轮次）与选中左边轨视觉一致，与 WorkDSH 截图并排无明显层级差。
6. 全部样式走主题变量，零内联；新增代码不超 2000 行/文件，重复结构抽公共。

---

## 10. 风险与取舍

- **journal 体积**：长会话逐轮返回 prompt 原文可能很大。→ 后端每条 `prompt` 截断到
  ~120 字符（展示用），完整正文仍在回放通道里取，列表不传全量。
- **段号稳定性**：`RoundSummary.index` 是段内序号，与全局段号 `RunRecord.index` 解耦，
  不影响回放按段号定位（现有约束：合并 run_meta 不得重排段号）。
- **WorkDSH 逐轮 UI 未逐像素确认**：本方案是其层级的合理延伸；若拿到 WorkDSH 轮次区
  真实截图，仅调 §5.4 视觉细节，数据模型（§4）不变。
- **不过度设计**：不引入虚拟列表/分页轮次（侧栏宽度有限，单段轮次通常 < 20）；
  不做轮次内再嵌套工具调用树（那是主区转写的事）。
