# 对接 WorkBuddy「专家」：事实、映射与第一步

> 事实来源：**本机安装的 WorkBuddy 运行数据**（路径均在下方逐条列出），不是公开宣传页。
> 未核实项会明确标注，不做推测性补全。

## 1. WorkBuddy 的专家机制（实读）

### 1.1 专家是一个插件，不是一条提示词

`~/.workbuddy/plugins/cache/experts/code-crew/1.0.0/.codebuddy-plugin/plugin.json`：

- `expertType: "team"`（单专家则为 `"agent"`）
- `agentName`: 队长 agent
- `teamInfo.leadAgent` + `teamInfo.memberAgents[]`: 团队拓扑
- `agents[]`: 每个角色的 markdown 文件
- `skills[]`: 团队技能（含 references / contracts）
- `members[]`: `id` / `name`（中英）/ `profession` / `avatar` / `role`（`lead` | `member`）
- `displayName` / `profession` / `displayDescription` / `categoryId` / `tags` / `quickPrompts` / `defaultInitPrompt`：展示与开箱即用信息

### 1.2 角色 markdown 的契约

`agents/code-investigator.md` 的 YAML frontmatter：

```yaml
name: code-investigator
description: 调查员 Vera：只读代码、日志与文档…
displayName: { en: "Vera", zh: "Vera" }
profession: { en: "Code Investigator", zh: "调查员" }
color: "#8B5CF6"
```

正文强制包含：

- **职责边界**：`✅ 允许` / `❌ 禁止`，逐条列。调查员明确「不修改任何文件」。
- **工作方式**：按 brief 圈定范围、结论必须带证据（路径:行号）。
- **产出格式**：写入 `output_path`（`.agent-runs/{date}/{task}/…`）。
- **返回状态块**：`STATUS: PASS|FAIL|BLOCKED|NEED_INFO` + `REPORT` + `SUMMARY`（见 `references/contracts/task-result-format.md`）。

### 1.3 子智能体 Brief 的必填字段

`references/agent-factory/role-attribute-schema.md` 明确列出：

`role_name`、`mission`、`when_to_use`、`input_files`、`allowed_edit_scope`、`forbidden_actions`、`tools_policy`、`output_path`、`success_criteria`、`stop_condition`、`handoff_format`；可选 `depends_on`、`max_iterations`、`isolation`、`notes`。

这比「角色 + 提示词」多出四类硬约束：**可改范围、禁用行为、工具策略、停止条件**。

### 1.4 团队运行态

`~/.workbuddy/teams/<team>/config.json`：

- 顶层：`name` / `description` / `createdAt` / `leadAgentId` / `leadSessionId` / `members[]`
- 成员：`agentId` / `agentType` / `name` / `role`（本次任务角色）/ `model` / `color` / `cwd` / `tmuxPaneId` / `subscriptions`（本机为 `["*"]`，广播订阅）/ `planModeRequired` / `prompt`

`runtime.json`：

- 顶层：`version` / `teamName` / `leadAgentId` / `leadSessionId` / `createdAt` / `updatedAt` / `status` / `members[]`
- 成员：`agentId` / `agentType` / `backendType`（本机为 `in-process`）/ `status`（如 `paused`）/ `taskId` / `taskDescription` / `resumeSessionId` / `cwd`

结论：WorkBuddy 的成员是**同进程内的 agent 实例**，有独立会话 id 与任务 id，可按成员恢复；我们的成员是独立 `pi` 子进程，这是结构差异。

### 1.5 运行轨迹（可直接借鉴的事件模型）

`~/.workbuddy/traces/<session>/trace_*.jsonl`：

- `trace_start`：`traceId` / `name` / `workerPid` / `startedAt` / `status` / `spanCount` / `totalTokens`
- `span_start` / `span_end`，span 字段：`traceId` / `spanId` / `parentId` / `name` / `type` / `startedAt` / `endedAt` / `duration` / `status` / `error`
- `type` 实读四种：`custom`（如 `mcp_tools`）、`agent`（带 `agentName`）、`generation`、`function`（带 `toolName` / `toolInput` / `toolOutput`）
- 大字段会截断并标注：`attributes.tracePayloadTruncated` / `tracePayloadTruncatedFields`

这是「按 agent 分道」的直接依据：`type=agent` 开泳道，`parentId` 建父子，`function` 是工具调用，`generation` 是模型调用。

## 2. 与本仓现状的映射

| WorkBuddy | pi-workbench 现状 | 差距 |
| --- | --- | --- |
| 专家插件 `plugin.json` | `experts.rs` 的 `ExpertDefinition`（草稿/发布） | 缺展示元数据、成员拓扑、技能引用 |
| 角色 md（职责/边界/产出/状态块） | `role` / `methodology` / `boundaries` / `deliverables` 四段文本 | 有文本，无结构化字段 |
| `tools_policy` + `allowed_edit_scope` | `agent-tool-gate` 有风险分档，但策略来自全局，不来自专家 | **专家无法声明自己的工具边界** |
| `output_path` / 状态块 | 无 | 产出不可寻址、结束状态不可解析 |
| 团队 `members[]` + `subscriptions` | `team_create` 的 `members: string[]` | 只有名字，没有角色/工具/产出契约 |
| `runtime.json` 成员状态 | 团队调度日志 `{runId, member, ok, output, at}` | 有状态，无任务 id、无恢复、无耗时 |
| trace span（agent/generation/function） | journal 单流，无 agent/span 身份 | 需补事件信封 |

## 3. 专家定义的最小结构（建议）

在本仓现有字段上增量，不新建体系：

```json
{
  "id": "code-investigator",
  "name": "调查员 Vera",
  "role": "只读调查，定位根因，输出调查报告",
  "methodology": "先读必读文件，再按线索扩展；结论必须带证据",
  "boundaries": "❌ 不修改任何文件；❌ 不做最终方案拍板",
  "deliverables": ".agent-runs/{date}/{task}/investigation-report.md",
  "allowed_tools": ["read", "bash", "codebase_search", "codebase_query"],
  "denied_patterns": ["git commit", "rm -rf", "npm publish"],
  "max_iterations": 1,
  "handoff": { "format": "status-block", "fields": ["STATUS", "REPORT", "SUMMARY"] }
}
```

- `allowed_tools` / `denied_patterns`：进入工具门，成为硬边界。
- `deliverables`：从自由文本升级为路径模板，产出可被资料库索引。
- `handoff`：团队调度时按此格式收敛，前端可解析状态。

## 4. 映射到现有代码

| 目标 | 落点 | 改动量 |
| --- | --- | --- |
| 专家字段扩展 | `ExpertDefinition` 增 `allowed_tools` / `denied_patterns` / `handoff`（均 `#[serde(default)]`） | 小 |
| 工具边界生效 | `expert_publish` 额外写 `.pi/policy/expert.json`；`agent-tool-gate.ts` 每次调用读一次 | 中 |
| 团队引用专家 | `team_create` 的 `members` 从 `string[]` 兼容升级为 `{name, expertId?}` | 中 |
| 成员状态可视 | 调度日志补 `member_start` / `member_end`（`at` / `durationMs` / `round` / `outputPath`） | 小 |
| 轨迹分道 | Rust 事件信封补 `runId` / `agent`；前端 `AgentLanes` 消费 | 小 |

## 5. 可执行的第一步（只做这一件）

**让专家声明自己的工具边界，并让工具门真的执行它。**

1. `ExpertDefinition` 增加 `allowed_tools: Vec<String>`（默认空 = 不限制）与 `denied_patterns: Vec<String>`（默认空）。
2. `expert_publish` 除写 persona 外，写 `<项目>/.pi/policy/expert.json`：
   ```json
   { "expertId": "...", "name": "...", "allowedTools": ["read","bash"], "deniedPatterns": ["git commit"], "digest": "..." }
   ```
3. `agent-tool-gate.ts` 在 `tool_call` 前读取该文件：
   - `allowedTools` 非空且工具不在其中 → block，返回明确原因；
   - 命令命中 `deniedPatterns` → block；
   - 读取失败 → 沿用现有全局策略（fail-safe，不因配置缺失放开）。
4. `gate_status` 返回当前生效的专家策略，UI 能自证「规则已加载」。
5. 「智能体」页签在头部显示当前专家与工具边界；团队分道沿用同一策略。

验收：发布一个只允许 `read` 的专家，调 `bash` 必须被 block 且原因可读；改回允许后无需重启内核（每次调用读文件）。

明确**不做**：不在第一步改团队子进程通信、不做 RPC 化、不做跨专家路由。这些等第一步验证通过后再排。

## 6. 落地记录（2026-11-12）

第一步已实现并验过，链路与上文方案一致，未新增数据表。

**定义与存储**
- `ExpertDefinition` 增加 `allowed_tools` / `denied_patterns` / `stop_condition` / `max_iterations`，发布时写入 persona 与 `<项目>/.pi/policy/expert.json`；删除命令只清草稿/已发布/persona/本专家策略，不碰 journal。
- 专家列表新增 `role`、`tool_count`、`last_run`（扫 journal 的 `expert_start` + `agent_settled` 得出）。

**运行时**
- `pi_send` 携带 `expertId` 时先写项目策略并落 `expert_start` 事件；不带专家时删除策略，避免上一轮限制残留。
- `agent-tool-gate.ts` 每次 `tool_call` 前读策略：白名单外工具直接 block，bash 命中拒绝模式也 block，越界写 `.pi/policy/expert-audit.jsonl`；`gate_status` 永远放行。
- 链路新增 `expert` 节点：首位显示「专家 X 接管」，接力显示「交接给专家 Y · 来自 X」。
- ChatView 按勾选顺序接力，上一位 assistant 文本作为下一位 prompt 并带 `handoffFrom`。

**验收证据**
- `tests/agentToolGate.spec.ts`：真实调用扩展 `tool_call` 处理器，允许 `read`、拒绝 `bash`，审计文件落一行 `expert_denied`。
- `scripts/simulate-run-chain.mjs expert`：99/99 断言通过，链路截图同时出现「专家 代码评审专家 接管」与「交接给专家 实现专家」，越界 bash 标红。
- `scripts/visual-check.mjs`：123/123 通过，含「新建专家 → 工具清单来自 tools_list → 保存 → 列表显示角色 / 2 个工具 / 最近运行成功」。

## 7. 未核实 / 明确不知道

- WorkBuddy 成员的 `subscriptions: ["*"]` 具体路由语义（广播还是过滤）未在本地数据中坐实，只知道字段存在、值为 `*`。
- WorkBuddy 的 `backendType: "in-process"` 是否所有成员都同进程，本机样本只有一个团队，未做多团队交叉验证。
- 其 trace 的 `totalTokens` 统计口径未验证（样本中为 0）。
- 本机没有找到「专家市场/下载」的服务端契约，无法确认远程安装协议。

## 8. 导入到本应用（最小可用版）

**格式识别**
- 输入路径可以是插件目录（含 `.codebuddy-plugin/plugin.json` 或根级 `plugin.json`）或单个角色 md。
- `agents[]` 相对 `plugin.json` 解析；`.codebuddy-plugin/agents/*.md` 与根级 `agents/*.md` 都兼容。

**字段映射**

| WorkBuddy | 本应用字段 |
|---|---|
| 角色 md 首个二级标题前的正文 | `role` |
| `## 职责边界` / `## 行为边界` / `## 禁止` | `boundaries` |
| `## 工作方式` / `## 工作方法` / `## 工作流程` / `## 核心原则` | `methodology` |
| `## 产出格式` / `## 交付` / `## 报告结构` / `## 输出` | `deliverables` |
| `## 停止条件` / `## 状态块` / `## 返回队长` | `stop_condition` |
| frontmatter `tools` / `allowedTools` 或工具章节里的反引号词项 | `allowed_tools` |
| `displayName.zh` → `profession.zh` → 插件名 | `name` |
| 插件 `displayDescription.zh` / md `description` | `description` |
| 插件 `tags[].zh` | `tags` |

未映射字段逐条列出：`skills`、`teamInfo`、`members`、`quickPrompts`、`defaultInitPrompt`、`avatar`、`categoryId`、`version`、`author`。团队按角色拆成独立专家导入。

**工具映射**
- 常见别名（`read_file`→`read`、`run_command`→`bash`、`web_search`→`websearch` 等）只在内核 `tools_list` 里存在时给建议。
- 映射不上的工具**必须显式决策**：预览里默认「待决定」，存在待处理项时导入按钮不可用。
- 顶部汇总「还有 N 项待处理」并逐项提供跳转按钮；专家卡与工具行各自标出待处理项。
- 决策写进专家定义 `tool_mapping`：`{ from, to, decision }`。`to` 为 `null` / `decision: "ignored"` 表示主动忽略，`decision: "mapped"` 表示映射到别的工具。
- 工具门只看 `allowed_tools`；`tool_mapping` 仅作追溯。导入后的专家详情保留「工具映射记录」，可直接看出某能力是被主动忽略还是映射成了什么。

**冲突与事务**
- 同名专家默认「跳过」，可选覆盖或改名；改名 id 与现有专家重复时前端拦截。
- `expert_import_apply` 先整体校验，再快照原文件写盘；任一步失败按快照回滚，不留半成品。
- 导入只写草稿，`source: "imported"` + `imported_from` 记录来源；列表按该字段显示「导入 / 本地创建」。不新增数据表。

**命令**
- `expert_import_preview(path, availableTools)` → 预览。
- `expert_import_apply(items)` → 落盘结果（created / overwritten / skipped）。

**验收证据**
- `src-tauri/src/experts.rs` 单测：样例插件字段映射、未映射工具建议、插件级未映射字段、单 md 导入。
- 同一单测覆盖冲突四分支（新建 / 跳过 / 覆盖 / 改名）、整体校验失败零落盘、导入后来源为 `imported`。
- 同一单测覆盖 `tool_mapping` 落盘规范化：`decision` 以 `to` 为准，忽略项不写 `to`。
- `tests/expertImport.spec.ts`：工具映射替换与去重、预览渲染未映射项、待处理计数与跳转、未决策时按钮不可用、显式忽略与指定替代工具两条落盘路径（含 `tool_mapping` 记录）。

## 9. 「专家」到底由什么构成（2026-11-13 核对）

核对对象：本机 WorkBuddy 缓存（`plugin.json` + `agents/*.md` + `teams/config.json` + `runtime.json` + `traces/*.jsonl`）、WorkBuddy 自带 `references/agent-factory/role-attribute-schema.md`，以及有公开文档的 CrewAI Agents、OpenAI Agents SDK handoffs、LangGraph multi-agent。

| 要素 | WorkBuddy | CrewAI | OpenAI Agents SDK | LangGraph | 本仓现状 |
| --- | --- | --- | --- | --- | --- |
| 提示词 / 人格 | 角色 md 正文 + frontmatter | `role`/`goal`/`backstory` | `instructions` | 节点 prompt | 有：`role`/`methodology`/`boundaries`/`deliverables` |
| 工具白名单 | `tools_policy` + `allowed_edit_scope` | `tools`（Agent 级） | `tools`（Agent 级） | 节点内绑定工具 | 有：`allowed_tools` → 工具门硬拦 |
| 拒绝模式 | `forbidden_actions` | `max_iter`/`allow_delegation` 等 | handoff 过滤 | 图边控制 | 有：`denied_patterns`（仅 bash） |
| 停止条件 | `stop_condition` 必填 | `max_iter` / `max_rpm` | `max_turns` | 图终止条件 | 部分：`stop_condition` 只进 persona 文本 |
| 模型覆盖 | 成员 `model` 字段 | Agent 级 `llm` | Agent 级 `model` | 节点级模型 | **缺**：无 per-expert 模型字段 |
| 上下文隔离 | 独立 session + task id | 任务级上下文 | handoff 传 `input` | 每节点独立 state 视图 | **缺**：成员子进程共享 cwd，无上下文裁剪契约 |
| 交接协议 | 固定状态块 `STATUS/REPORT/SUMMARY` | `output` 字符串 | 结构化 handoff + `input_filter` | state 通道 | 部分：接力传上一位文本，无结构化契约 |
| 评估 | 状态块 + trace span | `Task` 的 expected_output | guardrails | 评测图 | **缺**：只有 `ok/output`，无验收标准字段 |
| 运行可观测 | `trace_*` span（agent/generation/function） | 日志 | tracing | 事件流 | 有：团队 `member_start/member_end/handoff` |

缺口按上文标 **缺** 的三项记，不当作已有能力：per-expert 模型覆盖、成员上下文隔离契约、结构化交接/评估。已有的是人格、工具白名单、拒绝模式、团队运行事件。

## 10. 新建与编辑（2026-11-13）

**会真正生效的字段**
- `name` / `role` / `methodology` / `boundaries` / `deliverables` / `stop_condition` → 发布时拼进 persona（`experts.rs`），运行时注入。
- `allowed_tools` → 发布写 `.pi/policy/expert.json`；团队成员按 `PI_EXPERT_ID` 直接读专家定义派生策略，工具门 `expertGateDecision` 硬拦并 `auditExpertDenial` 留痕。
- `denied_patterns` → bash 命令子串匹配拦截（大小写不敏感）。

**只存不生效、已从编辑器界面移除**
- `skill_requirements`：无任何读取方，导入时保留原值以兼容。
- `max_iterations`：策略里带上了，但工具门不消费它（没有迭代计数），编辑器不再展示。

**`tool_mapping`**：编辑器内可增删改，`from` 改名与 `to` 选择都会同步 `allowed_tools`；`to = 忽略` 时从白名单移除并记 `decision: "ignored"`。工具门不看它，仅作追溯，详情页只读展示。

**真实缺陷修复**
- `expert_draft_save` 原先重写文件时只保留 `{definition, revision, updated_at}`，编辑导入专家会把 `source`/`imported_from`/`imported_at` 抹掉、退化成「本地创建」。现用 `read_draft_meta` 读回外层元信息再写，新增单测 `draft_body_preserves_import_provenance`。
- `expert_draft_load` 补返回 `source` / `imported_from`，编辑器头部显示「本地创建 / 导入自 …」。

**界面**
- 专家卡 meta 拆成「来源 + 已发布」与「工具数 / 最近运行 / 修订号」两层，间距与层级不再挤成一行。

## 11. 专家团（2026-11-13）

**定义**：`<PI_CODING_AGENT_DIR>/.pi/teams/<id>.json`，字段 `{id,name,members,lead,strategy,on_failure,created_at}`。

- 成员键：`e:<expertId>`（注入专家人格 + 设 `PI_EXPERT_ID`）、`s:<skill>`、`c:<connectorId>`；旧团队纯标签按普通成员跑。
- 牵头：`lead` 必须是成员之一，默认首位；顺序/并行/辩论三种策略都由牵头收尾汇总。
- 交接：顺序策略相邻成员写 `handoff` 日志；并行/辩论先把成员产出写黑板，再由牵头汇总。
- 失败：`on_failure` = `stop`（默认，记 `run_aborted` 并中断）/ `continue`（继续其余成员）/ `retry`（重试一次再按 stop）。
- 工具门与审计：成员子进程带 `PI_EXPERT_ID`，`agent-tool-gate` 的 `envExpertPolicy` 按专家定义派生策略，仍走原 `expertGateDecision` / `auditExpertDenial`，未新增拦截路径。
- 可见性：团队卡片显示牵头与失败策略；「运行记录」弹窗按 runId 分组，列出成员开始/结束、耗时、重试次数、产出、交接与中断原因，2.5s 轮询。

**测试**：`tests/agentToolGate.spec.ts` 新增 `PI_EXPERT_ID` 用例（无 `.pi/policy/expert.json` 也能按专家定义拦截）；`tests/agentTeams.spec.ts` 覆盖创建校验、重复成员去重、悬空专家拦截、黑板文件排除、调度次数口径。

## 12. 专家团运行审计与修复（2026-11-13）

- **retry 语义修正**：重试耗尽后按 `stop` 中断，不再等同于 `continue`。
- **悬空专家**：`team_dispatch` 在派发前检查 `e:` 成员，专家定义缺失时直接返回错误并列出缺失 id；团队卡对缺失专家标红。
- **策略回落**：成员子进程总是显式注入 `PI_EXPERT_ID`（非专家写空串），工具门据此不再回落到项目级 `.pi/policy/expert.json`，避免继承上一次交互运行的专家限制。
- **黑板文件**：`agent_teams_list` / `listTeams` 跳过 `<id>-blackboard.json`，不再显示空团队。
- **调度次数**：只统计 `run_end`（及 `plan-only`），不再把日志行数当调度次数。
- **运行记录**：`member_end` / `member_retry` 带 `round`；记录按事件时间排序；没有 `run_end` 的运行显示「未收口」，不再默认「已结束」。
- **成员去重**：Rust `agent_team_create` 与 Pi `team_create` 一致，去重保序。

已知取舍（未改需求）：单成员辩论只跑两轮无互评；`denied_patterns` 只作用于 bash；同一团队并发调度共享黑板为最后写入；日志无轮转；`member_start` 之后进程被杀会在记录里留「进行中」。

