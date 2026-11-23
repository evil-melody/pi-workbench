# 整体运行链路：从一句话到工具落地

> 依据：2026-11-12 实读代码 + 本机运行态数据（`~/Library/Application Support/com.piworkbench.app/.pi/journal/events.jsonl`）。
> 架构图：`docs/diagrams/agent-runtime-pipeline.html`（archify，standalone，双主题）。

## 一句话

外壳把一句话写进常驻内核的 stdin；内核按轮次调用工具，扩展在工具前后拦截/记账；所有事件走同一条 `pi://event` 回流，前端与 journal 各取所需。**整条链只有一个 agent 身份**，团队是另起的独立子进程，不在同一条事件流里。

## 1. 进程模型

| 事实 | 位置 |
| --- | --- |
| 内核以 `pi --mode rpc --no-session` 启动，stdin/stdout 均是逐行 JSON | [pi_bridge.rs](file:///Users/tatsuma/Documents/GIT/pi-workbench/src-tauri/src/pi_bridge.rs) `spawn_kernel` |
| 启动参数带 `--extension <file>`（逐个扩展 TS）、provider/model、项目 cwd | 同上 |
| 进程按「provider + model + cwd」签名复用；配置变化先停旧进程再拉起 | 同上 `ensure_kernel` / `reuse_child` |
| `--no-session`：内核不维护会话历史，外壳用 journal 自己重建 | 同上 |
| journal 写入 `<app_config_dir>/.pi/journal/events.jsonl`，逐行 append，事件带 `pi_seq` / `pi_ts` | 同上 `append_journal` |
| 启动时写一条 `session_open`（含 cwd），前端据此开新会话 | 同上 |
| 单进程单任务：`agent_start` 置忙，`agent_settled` 释放；忙时新消息进队列或 steer | 同上 `pi_send` |
| 空闲 5 分钟可回收；回收不影响团队调度与账本（团队走自己的子进程） | 同上 `reap` |

关键取舍：内核是**长期复用**的，不是一问一进程。这样工具白名单、模型配置在启动时定格，改配置必须重启（`project_memory` 已记录）。

## 2. 一次对话的时序

1. `ChatView` 调 `pi_send`，带消息、会话范围、当前项目。
2. `pi_bridge` 确保内核在跑；把 prompt 以 JSONL 写入 stdin。
3. 内核开轮：`turn_start`。
4. 模型流式输出：`message_start` / `message_update` / `message_end`。
5. 需要工具时：`tool_execution_start`（含 `toolCallId` / `toolName` / `args`）。
6. 扩展介入（同进程）：
   - `agent-tool-gate`：风险判定，放行 / 要求确认 / 直接拦截；
   - `agent-*` 扩展提供的工具（团队、记忆、技能池、浏览器、MCP）执行；
   - 写类工具在动手前落 checkpoint（`checkpoint`）。
7. `tool_execution_end`（含 `isError` / `result`），结果回灌模型。
8. 无工具调用后收轮：`turn_end`；整轮结束：`agent_settled`。
9. `pi_events.rs` 给事件补 kind / 摘要，emit `pi://event`，同时 append journal。
10. 前端：`usePiEvents` 按 `pi_seq` 排序去重 → 气泡 / 轨迹抽屉 / 活动面板 / 会话树。

## 3. 工具面（真实注册清单）

内核自带：`read`、`bash`、`edit`、`write`。

扩展注册（全部经 `pi.registerTool`）：

| 扩展 | 工具 |
| --- | --- |
| agent-teams | `team_create` `team_dispatch` `team_status` |
| agent-memory | `memory_store` `memory_recall` `memory_update` `memory_forget` |
| agent-skill-pool | `skill_publish` `skill_pool_list` `skill_pool_install` |
| agent-browser-session | `browser_open` `browser_fetch` `browser_screenshot` |
| agent-mcp-bridge | `mcp_call` `mcp_list_tools` |
| agent-codebase | `codebase_status` `codebase_search` `codebase_architecture` `codebase_query` |
| agent-guard | `safe_shell` |
| sandbox-env | `sandbox_list` `sandbox_run` |
| agent-tool-gate | `gate_status`（只读状态，不承载放行） |

`role-inject` 不注册工具，只在 `before_agent_start` 把 `.pi/roles/current.md` 追加到系统提示。

## 4. 门禁与落盘

`agent-tool-gate.ts` 的三条硬事实：

- **风险分档**：读类直接放行；写类要求确认；命中禁区的命令直接 block，且不回退宿主执行（fail-closed）。
- **预授权有边界**：授权带 TTL 与范围，越界转人工确认，不靠提示词约束。
- **确认与执行分离**：pending 确认由 UI 呈现，超时/拒绝都有明确终态，不会静默继续。

`checkpoint` 在写工具动手前拍快照，UI 的「回滚」走同一份快照，不依赖模型自述。

## 5. 代码任务 vs 办公任务

| 维度 | 代码任务 | 办公任务 |
| --- | --- | --- |
| 内核链路 | 完全相同 | 完全相同 |
| 主要工具 | `read` / `bash` / `edit` / `write` + codebase / MCP | 仍是 `bash`（调 python / 命令行工具） |
| 写入门禁 | checkpoint + 审批 + 回滚 | 同样受门禁，但**没有办公专用工具** |
| 产物处理 | 代码文件直接落盘 | `library.rs` 扫描并解析 `pdf/docx/pptx` 文本用于索引/预览 |
| 专用技能 | 无（靠仓库上下文） | **app 配置目录的 `skills/` 目前为空**，办公技能未安装 |

结论：办公任务当前不是一条独立管线，只是「同一内核 + bash + 资料库解析」。这是缺口，不是设计。补齐路线见 `docs/AGENT-VISUALIZATION-DESIGN-2026-11-12.md` 的「办公能力接缝」。

## 6. 团队 / 多 agent 现状

`agent-teams.ts` 能做到：

- `team_create`：只写定义（id / name / members / strategy / created_at）。
- `team_dispatch`：`sequential` 顺序、`parallel` 并发、`debate` 两轮互评；每个成员 **spawn 一个 `pi --mode chat` 子进程**，cwd 为项目目录，继承 provider/model/api-key 环境；成员超时 90s 被回收。
- 共享上下文：一个 JSON 黑板（`<id>-blackboard.json`），以文本拼接进下一位成员的 prompt。
- 运行日志：`<app_config_dir>/.pi/teams/<id>.jsonl`，每条 `{runId, member, ok, output, at}`，末尾一条 `{runId, team, strategy, real, at}`。

做不到：

- 没有 handoff 事件：成员之间只有「黑板文本」，没有「谁把什么交给谁」的结构化记录。
- 没有共享会话：每个成员独立上下文，彼此看不到对方的工具调用。
- 没有成员级工具事件：子进程是 `--mode chat`，只回收 stdout 文本。
- 没有失败重试：成员失败即记 `ok:false`，不重跑。

因此团队可视化当前只能到「成员起止 + 全文产出」，这是数据上限，不是界面偷懒。

## 7. 观测数据现状（journal 实测）

- 有：`session_open`、`turn_start`、`turn_end`、`tool_execution_start`、`tool_execution_end`（带 `toolCallId` / `args` / `isError` / `result`）、`message_*`、`auto_retry_start`、`auto_retry_end`、`agent_start`、`agent_settled`、`process_exit`。
- 没有：`agentId`、`spanId`、`parentSpanId`。主流程事件带 `runId`（桥侧 `run_start` 起，`process_exit` 收尾）。
- 桥侧还会合成 `tool_call` / `tool_result`（无 `toolCallId`），与真实执行事件同时存在；前端需要二选一，避免重复。

### 用户原文必须落 journal（2026-11-12 修复）

`prompt` / `follow_up` / `steer` 三种下发都在**发送时**由桥侧合成一条 `user_prompt`：

```json
{"mode":"steer","pi_ts":1794481288309,"queued":true,"runId":"run-9","text":"插个话","type":"user_prompt"}
```

- `mode`：`prompt` / `follow_up` / `steer`；`queued` 仅在排队/插话时为 `true`。
- `prompt` 在前端乐观气泡出现时先由 `pi_note_user` 落一条（此时 run 尚未开始，不带 `runId`），`pi_send` 带 `journaled:true` 跳过重复合成；`runId` 由随后的 `run_start` 提供。
- `follow_up` / `steer` 由 `pi_send` 落盘，带当前 `runId`。
- 不能只依赖内核回显的 `message_end`：排队消息碰上 `auto_retry` / `process_exit` 可能永远不被消费，回放时用户刚说的话就消失。
- 回放按文本去重：`user_prompt` 与内核回显任一先落盘，都只保留一条气泡（合成事件优先保留附件元数据）。
- 同一 cwd 的内核重启 / 空闲回收会连续落多条 `session_open`。回放把它们合并成一段，只取最后一段会把重启前的整段对话丢掉。
- journal 每行一次 `write_all` 并用同一把锁串行化：多句柄并发追加会写出半行交错 JSON（实测 4 行被丢弃）。

## 8. 相关文档

- 可视化设计：[AGENT-VISUALIZATION-DESIGN-2026-11-12.md](file:///Users/tatsuma/Documents/GIT/pi-workbench/docs/AGENT-VISUALIZATION-DESIGN-2026-11-12.md)
- 对接 WorkBuddy 专家：[WORKBUDDY-EXPERT-INTEGRATION-2026-11-12.md](file:///Users/tatsuma/Documents/GIT/pi-workbench/docs/WORKBUDDY-EXPERT-INTEGRATION-2026-11-12.md)
