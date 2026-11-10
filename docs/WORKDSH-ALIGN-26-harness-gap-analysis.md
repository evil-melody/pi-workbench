# WORKDSH-ALIGN-26：以 Pi 为核心，对照 WorkDSH 的 harness 差距全量分析

> 参照物：`github.com/techflag/workdsh`（WorkDSH 桌面 2.0.6-alpha.5，DSH 官方 runtime `@deepseek-ai/dsh` + Cordis 插件体系）。  
> 本仓立场：**Pi 是唯一内核**，不引入第二个 harness；对照只回答「Pi 这条链上缺什么、哪些当前实现是坏的」。

---

## 一、参照系速写（WorkDSH 的 harness 分层）

从 workdsh 源码（`/tmp/workdsh`，depth-1 clone）确认的结构：

| 层          | WorkDSH 的做法                                                                                                                                                                                                                      | 关键证据                                                                          |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 内核         | DSH 官方 runtime，桌面壳用**可写 Profile** 覆盖官方安装锚点，运行时物化 member profile                                                                                                                                                                  | `apps/desktop/src/local-runtime.ts`（`materializeRuntimeProfile`）              |
| 插件体系       | Cordis 插件 = npm 包，市场安装/启用/禁用/版本管理，`inject` 声明依赖服务                                                                                                                                                                                | `packages/plugins/*` 各自 `package.json` + `plugin-archive-cache.ts`            |
| 域插件 19 个   | skills / experts / connectors / office / library / projects + **治理五件套**（identity / access / audit / model-policy / usage）+ enterprise-collaboration / tables / automations / pages / applications / activity / admin / workbench | `packages/plugins/` 目录、`profiles/shared/workdsh-features.json`                |
| harness 闸门 | 专家编译成 DSH preset；**工具执行前 confirmation + execution-guard**；plans 运行态                                                                                                                                                              | `experts/src/runtime/{confirmation,execution-guard,preset-compiler,plans}.ts` |
| 企业桥        | `workdshEnterprise` 认证注入，业务插件复用成员登录，主进程携带认证请求后台，不落地 Token                                                                                                                                                                        | `apps/desktop/src/enterprise-auth.ts`、README §企业插件开放认证服务                      |

## 二、本仓当前 harness 链路（以 pi 为核心的事实）

```
Vue ChatView ──invoke pi_send──> Rust pi_bridge ──stdin JSON──> pi --mode rpc --no-session
     ↑                              ├─ 启动签名 cwd|provider|model 复用/重启（pi_start/pi_restart）
     │                              ├─ 内置 extension 探测注入（agent-*.ts, role-inject.ts）
     └──pi://event<─────────────────┘   事件流（message_update / tool_call / agent_settled）
人面：agent_ops.rs 读写 <config>/.pi/{teams,memory,skills-pool,browser}，与 extension 共状态
```

**这条链成立的**：单内核常驻复用、角色 addendum 注入（`role-inject.ts` 走 `appendSystemPrompt`，不覆盖 Pi 自带段）、人面/agent 面同一份落盘状态、能力清单单一真源。

## 三、harness 核心问题清单（用户点名重点，全部验证过源码）

### A 级：当前实现是坏的或假的

| #  | 问题                                                                          | 证据                                                                            | 后果                                                             |
| -- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------- |
| A1 | **`team_dispatch` 用 `spawnSync` 同步跑成员，阻塞 Pi 内核事件循环**                        | `extensions/agent-teams.ts` L55-70（`spawnSync('pi', …timeout 90_000)`）        | 调度期间内核假死最长 90s/成员 ×N：事件流断流、UI 无响应、其他 RPC 全部排队。这是 harness 最重的缺陷 |
| A2 | **三种协调策略全是假的**：`parallel`/`debate` 声明了，实现是同一个顺序 for 循环                      | `agent-teams.ts` L153-170                                                     | 策略字段只是写进 JSON 的字符串，行为无差别；debate 无轮次、无互评、无收敛                    |
| A3 | **成员子进程裸奔**：`pi --mode chat` 不带 `cwd`、不带 provider/model/api-key、无角色注入、无团队黑板 | `agent-teams.ts` L58（无 cwd/options）；`role-inject.ts` 只读主进程 cwd 的 `current.md` | 成员用默认模型在错误目录跑，互相看不到产出，「团队」实际是 N 个孤立问答                          |
| A4 | **无会话持久化**：`--no-session` 启动，消息只存前端内存                                       | `pi_bridge.rs` 启动参数；usePi 无落盘                                                 | 崩溃/重启/切项目即全丢；对照 DSH 的 SQLite 会话存储 + 恢复，这是工作台最基本保命功能的缺失         |
| A5 | **`pi_restart` 丢弃 in-flight 请求且无提示**：`pending.clear()` 直接扔掉等待中的 RPC 响应      | `pi_bridge.rs` `pi_restart`                                                   | 正在流式的回答静默消失，前端 `streaming` 状态可能永远卡住                            |
| A6 | **MCP 工具桥接断裂**：MCP server 跑在 Tauri 侧子进程，Pi 进程拿不到，白名单只是把名字写进配置               | `tools.rs`；README 自认「真正的可见性还需要 extension 桥接」                                  | 连接器面板「注入 Pi」在内核侧是无效操作，用户被 UI 误导                                |

### B 级：harness 应有而完全没有的机制

| #  | 缺失                                                          | WorkDSH 对应物                                                  | 对 Pi 的正确补法                                                                                           |
| -- | ----------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| B1 | **审批/执行守卫**：bash、edit、write 直通，无危险命令拦截、无 diff 确认、无审批 UI 接缝  | `experts/src/runtime/confirmation.ts` + `execution-guard.ts` | Pi extension 侧挂 tool-call 前置钩子，危险模式（rm -rf / git push --force / curl 管道）先 `emit` 到前端等批准；Tauri 维护审批队列 |
| B2 | **事件 journal / 审计**：`pi://event` 只往 UI emit，无落盘、无回放         | `audit` 插件 + DSH 会话日志                                        | Rust 侧 append 事件 jsonl（与 `usePiEvents` 环形缓冲互补），会话恢复/审计都靠它                                            |
| B3 | **会话 fork / 分支 / 压缩**：无 fork、无长会话 summarization             | DSH 会话树                                                      | Pi 有 session 机制，去掉 `--no-session` 或在 Tauri 侧持久化 prompt 流重放；压缩走 Pi 自带的 compact（若内核支持）或前端摘要回灌          |
| B4 | **上下文预算管理**：taskContext/引用资料无差别拼在 prompt 前，无 token 计量、无截断策略 | DSH preset 编译带预算                                             | 拼接前按预算裁剪（资料引用给摘要不给全文），roles.rs 已有 <2000 token 约束可推广                                                  |
| B5 | **记忆语义召回**：memory.jsonl 线性扫描 + 200 条上限，关键词匹配                | workdsh library 检索 + RAG                                     | 短期：复用 `library_search` 做召回；中期：本地向量索引（AGENT-OPS.md 自认 B 期）                                            |
| B6 | **沙箱/环境隔离**：`sandbox-env.ts` 只是 env 探测；bash 在宿主全权执行         | DSH 桌面受控执行 + 企业 model-policy                                 | 最小可行：extension 内置「宿主 PATH 白名单 + 命令黑名单」；真隔离留给 Pi 原生沙箱演进                                               |
| B7 | **多内核/并发 agent**：全局单 PiState，单签名单进程                         | DSH 每会话独立 runtime 实例                                         | 保留常驻复用为主，但团队场景需要「短期子内核」抽象：受控 spawn（异步、带 cwd/model、超时回收）                                              |

### C 级：域与企业层差距（对照 19 插件，摘要）

| 域      | WorkDSH                                  | 本仓现状                                |
| ------ | ---------------------------------------- | ----------------------------------- |
| 成果工作区  | office 插件：文档/表格/演示/PDF 工作副本编辑            | 无；artifacts.rs 仅产出登记                |
| 插件市场   | Cordis 包市场：安装/启用/版本/缓存                   | `extensions_list` 静态扫描本地文件，「市场」是空态页 |
| 治理五件套  | identity/access/audit/model-policy/usage | 全无；模型密钥走本地 settings（无转发代理）          |
| 协作分享   | enterprise-collaboration：@同事、分享正文与文件     | 无（个人工具定位可后置）                        |
| 应用/自动化 | applications/automations/pages           | 无                                   |

## 四、修复路线（按「坏 > 缺 > 企业」排序）

1. **P0 修 A 级**：A1 spawnSync→异步 spawn + 结果回填；A2 策略做真（parallel 用并发 Promise，debate 至少做两轮互评）；A3 成员带 cwd/model/角色头；A5 restart 前 drain 或通知前端。
2. **P0.5 补保命**：A4 会话持久化（事件 journal 落盘即顺带解决 B2），崩溃可恢复。
3. **P1 harness 闸门**：B1 审批守卫（先黑名单后 diff 确认），B6 最小命令防护。
4. **P1 补桥**：A6 MCP 桥（extension 转发调用到 Tauri，工具名透传内核），B4 上下文预算。
5. **P2**：B3 fork/压缩、B5 语义召回、成果工作区。
6. **P3 企业层**：治理五件套按需，个人工具定位下不阻塞。

## 五、边界声明

- Pi 单内核路线不变：B7 的子内核仅服务团队编排，不引入第二 harness。
- 本分析基于 workdsh `desktop-v2.0.6-alpha.5` 源码与本仓当前 HEAD；不复制 workdsh 实现（不同内核、不同插件协议），只取机制。
- movo（`himovo/movo`，DSH 企业平台版）已 clone 到 `/tmp/movo`，其 `services/chat-api/dsh/runtime-host` 可作企业侧编排的补充参照，本文未展开。

## 六、修复进度（2026-10-10 执行）

按第四节路线图，分五轮落地：第一轮 P0（A 级坏实现）+ B2 审计落盘 + 工具链脚本缺陷修复；第二轮 P1 的 A6（MCP 桥）与 B6（最小命令防护）；第三轮 B1 硬审批回传通道 + A6 加固 + A4 崩溃重放；第四轮 P2 的 B3（压缩接入）/ B4（上下文预算）/ B5（评分召回）；第五轮 P3 的治理五件套轻量落地。  
验证：`node scripts/check-extensions.mjs` 全过（10 扩展 / 21 工具 / 8 命令）；`test-harness-p1/p2/p3.ts` 17+22+13 断言；`cargo test`（src-tauri 161 测全过）；前端 `vue-tsc --noEmit` + `vitest`（18 文件 / 163 测）+ `vite build` 全过。

| 项             | 状态    | 落点                                                                                                                                                                                                                                                                                                                                                                                                                      | 验证                                                                                                      |                               |
| ------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ----------------------------- |
| A1 调度阻塞内核     | ✅ 修   | `extensions/agent-teams.ts`：`spawnSync` → `spawn` 异步 + 超时回收（SIGKILL），事件循环不再卡死                                                                                                                                                                                                                                                                                                                                           | check:extensions 过                                                                                      |                               |
| A2 策略是假的      | ✅ 修   | 真实分支：`sequential` 顺序 / `parallel` `Promise.all` / `debate` 两轮互评收敛；黑板跨轮可见                                                                                                                                                                                                                                                                                                                                                | check:extensions 过                                                                                      |                               |
| A3 成员子进程裸奔    | ✅ 修   | 成员带 `cwd`（项目目录）+ `PI_LAUNCH_*`（provider/model/api-key，`pi_start` 透传）+ 角色头 + 团队黑板（`<teams>/<id>-blackboard.json`）                                                                                                                                                                                                                                                                                                        | check:extensions 过                                                                                      |                               |
| A4 会话持久化      | ✅ 修   | journal（B2）+ `pi_journal_read` 命令（Rust，支持 `last_n` 截取）+ `useReplay.ts`：与实时通道共用 `applyEvent` 折算从 journal 重建转写，入口在轨迹面板「从 journal 重放会话」                                                                                                                                                                                                                                                                                    | 单测 `journal_read_parses_and_slices` 过；已知边界：journal 只含内核事件，用户 prompt 原文不在重建范围                            |                               |
| A5 重启静默丢请求    | ✅ 修   | `pi_bridge.rs` `pi_restart`：`pending.drain()` 逐条回送「内核重启」失败响应 + 广播 `kernel_restarted` 事件                                                                                                                                                                                                                                                                                                                                 | 单测 `restart_drains_pending_with_error` 过                                                                |                               |
| B2 事件 journal | ✅ 修   | `state.rs` 加 `journal_path`；`pi_bridge.rs` reader 线程把每条 `pi://event` 追加到 `<config>/.pi/journal/events.jsonl`；新增 `pi_journal_path` 命令                                                                                                                                                                                                                                                                                    | 单测 `journal_path_unset_by_default` 过                                                                    |                               |
| A6 MCP 桥接断裂   | ✅ 修   | `extensions/agent-mcp-bridge.ts`：内置最小 MCP stdio 客户端（JSON-RPC 2.0），按 Tauri `mcp.rs` 同写的 `<config>/mcp.json` 惰性建连并缓存，`mcp_call(server,tool,arguments)` 转发调用；`mcp_bridge` 命令列出已连 server/工具供 agent 发现                                                                                                                                                                                                                       | check:extensions 过 + 单测 McpClient 往返                                                                    |                               |
| B6 最小命令防护     | ✅ 修   | `extensions/agent-guard.ts`：`safe_shell` 工具 + `guardShell` 黑名单（rm -rf / git push --force / curl                                                                                                                                                                                                                                                                                                                         | sh / dd of=/dev / mkfs / fork bomb 硬拦截）+ 软闸门（sudo / git reset --hard / rm 等需 confirm:true）+ 宿主 PATH 白名单 | check:extensions 过 + 单测 17 断言 |
| B1 审批/执行守卫    | ✅ 修   | 三层落地：① `agent-tool-gate.ts` 经 Pi 扩展 `pi.on('tool_call')` 前置钩子拦截（实测 Pi 0.87.1 支持 block，先前「无法拦截」判断有误——扩展层在内核进程内可拦）；② 灾难命令硬 block、风险命令走 `ctx.ui.confirm`，超时/异常 fail-closed；③ 回传通道 `pi_bridge.rs` `pi_ui_response` 命令把用户决定以 `{"type":"extension_ui_response","id","confirmed"}` 回送 stdin（协议自 pi bundle 反向工程确认），前端 `useApproval` + `ApprovalDialog.vue` 消费 `extension_ui_request` 事件渲染批准横幅                                   | check:extensions 过 + 分类器 18 断言                                                                          |                               |
| 工具链脚本 bug     | ✅ 修   | `scripts/check-extensions.mjs`：① `REGISTER` 索引改 `hasOwnProperty`（修复 `toString` 等继承键误判）；② `duplicateKeys` 对无 `name` 属性（对象展开/计算属性）空值保护                                                                                                                                                                                                                                                                                    | check:extensions 全过                                                                                     |                               |
| B3 会话 fork/压缩 | ✅ 修   | fork 早已通（前端 `forkFrom` → 原生 `fork` 命令 + 会话树）；压缩接内核原生 `session.compact`——ChatView 工具栏「压缩」按钮 → `rpc('compact', timeout 120s)`，摘要落消息流；`usePi.rpc` 支持可选 timeout（默认 30s）                                                                                                                                                                                                                                                     | vue-tsc + vite build 过；协议自 pi bundle 反向工程确认                                                             |                               |
| B4 上下文预算      | ✅ 修   | `contextBudget.ts`：`estimateTokens`（CJK 感知粗估 0.75 token/字）+ `trimPreamble`（按行优先级裁剪：项目/配置修订元信息永不丢 → 指令 > 能力 > 引用；单行 2000 token 硬上限常显生效；裁剪显式标注「[已裁剪]」）+ `dispatchToPi` 接线（默认预算 4000 tokens）                                                                                                                                                                                                                               | vitest 6 测全过（`tests/contextBudget.spec.ts`）                                                             |                               |
| B5 记忆语义召回     | 🟡 短期 | `agent-memory.ts` `scoreOf` 升级多信号评分：中文 bigram 切词（`queryTerms`）+ tags 命中 ×2 加权 + 词长权重 + 覆盖率归一 + 时效微加分（7 天半衰期 tie-break）；`memory_recall` 返回按相关度排序。**仍是词面召回**——语义向量 RAG 属 AGENT-OPS §B 期（本地向量索引）                                                                                                                                                                                                                           | strip-types 13 断言全过（`test-harness-p3.ts`）                                                               |                               |
| 治理五件套         | ✅ 轻量  | `governance.rs`：**identity**（`governance.json` 的 `identity.operator` → 前缀 `[操作者]` 行，identity 拉取失败静默降级）；**access/model-policy**（`enforce_model_policy` 在 `pi_start` 准入校验 provider 白名单 + 模型拒绝名单，违规拒启动，未配置模型不拦）；**audit**（复用 B2 journal，不重复落盘）；**usage**（从 journal `message_end` 解析 assistant `provider/model/usage` 聚合 tokens/cost，`governance_usage` 命令 + 轨迹面板用量区）；`governance_get/set` 命令持久化 `<config>/governance.json` | cargo 单测 9 个（policy 拒绝/放行/大小写 + journal 聚合/since 过滤/坏行跳过）+ vitest 2 个（操作者注入/降级）                         |                               |

### 本轮未做（后续轮次，按优先级）

- **P2 残留**：B5 语义向量召回（本地向量索引，AGENT-OPS §B 期）、成果工作区。
- **B3 演进**：autocompact 策略调优（内核 `set_auto_compaction` 已暴露但保持默认）；压缩按钮缺真机回归。
- **P3 企业级缺口（有意不做）**：治理五件套当前为单机轻量版——无请求转发代理（模型密钥仍在本机 settings）、无多租户/RBAC、无集中审计上报；策略编辑暂走手改 `governance.json`（`governance_get/set` 命令已具备，接设置页 UI 属后续项）。
- **A6 演进**：当前每个被 Pi 调用的 server 在 Pi 侧额外起一个 stdio 连接（与 Tauri `mcp.rs` 各持一份）。轻量 server 可接受；后续收敛为单一 owner，或改为 Pi 原生 MCP 配置注入实现工具名透明注入。
- **B1 待真机回归**：审批回传的端到端链路（gate → extension_ui_request → 横幅 → pi_ui_response → confirm 解析）单测与协议均已验证，仍需桌面 App 真机跑一轮风险命令做交互回归；`ctx.ui.confirm` 的 select/input 变体前端暂只处理 confirm。

## 七、待回归与演进手册（2026-10-10 登记）

### 7.1 B1 审批横幅真机回归

**有什么用**：B1 是整条 harness 的「危险动作保险丝」。当前分类器单测（18 断言）只验证了**判定逻辑**；横幅 UI、`extension_ui_request` 事件转发、`pi_ui_response` 回传、Pi 内 `ctx.ui.confirm` 解析这四段是跨进程链路，只有真机能验证「用户点了批准 → 内核真的放行执行」这一完整回路。不回归 = 硬闸可能在关键时刻静默放行或永久卡死。

**回归步骤**（桌面 App dev 模式，选好模型后开一轮对话）：

| # | 操作                           | 预期                          | 验证锚点                   |
| - | ---------------------------- | --------------------------- | ---------------------- |
| 1 | 让模型执行 `ls -la`（良性）           | 直接执行，无横幅                    | 消息流出结果；轨迹面板有 tool_call |
| 2 | 让模型执行 `sudo whoami`（RISKY 表） | composer 上方弹批准横幅「sudo 提权执行」 | 横幅出现；内核不执行、流不卡死        |
| 3 | 点横幅「批准」                      | 命令真正执行并返回结果                 | 消息流出现 whoami 输出        |
| 4 | 再触发一次，点「拒绝」                  | 命令不执行，模型收到拒绝原因可继续对话         | 无执行输出；模型回应不崩           |
| 5 | 触发横幅后不点，等超时                  | fail-closed：拒绝执行            | 同 #4                   |


| 6 | 让模型执行 `rm -rf /tmp/x-test`（DISASTER 表） | 无横幅、直接 block + terminate，模型收到 block 原因 | 内核不执行；gate 日志显示 terminate |  
| 7 | 让模型用 write/edit 写 `.env` 或 `~/.ssh` 下文件 | block（受保护路径） | 同 #6 |

**失败排查**：横幅不弹 → 查 `pi://event` 里有无 `extension_ui_request`（轨迹面板可看）；弹了点批准没反应 → 查 Rust 侧 `pi_ui_response` 是否收到调用、stdin 写入是否成功；都通了仍卡 → Pi 内 confirm 解析层，抓内核 stdout 对照协议帧。

### 7.2 B3 压缩按钮真机回归

**有什么用**：长会话上下文膨胀后模型质量下降、成本上升；压缩用内核原生 `session.compact` 把历史折叠成摘要。协议与超时（120s）已验，需真机确认长会话下 UI 流畅性与摘要落盘表现。

**回归步骤**：跑 20+ 轮对话 → 点工具栏「压缩」→ 预期 120s 内返回摘要落消息流、压缩后继续对话模型仍记得摘要外的大方向；压缩期间 UI 不冻结（rpc 已 async）。

### 7.3 B5 语义向量召回（§B 期演进设计）

**有什么用**：当前 `memory_recall` 是**词面召回**（bigram + 多信号评分）——「数据库连接失败」查不到记成「DB 挂了/conn error」的条目，同义改写、跨语言、错别字场景全部漏召回。向量召回把记忆条目和查询都编码成语义向量做相似度匹配，解决「意思相同、字面不同」的检索盲区。

**业界落地路径（真实方案，按引入成本排序）**：

| 方案             | 组成                                                                                                                                     | 出处（已核实存在）                                                                                                                                 | 适用判断                                          |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| A · 暴力余弦（推荐起步） | `memory_store` 时调 embedding API 向量化 → 存 `<config>/memory/vectors.json`（id + vec + 元数据）；`memory_recall` 时查询向量化 → 全量余弦扫描 → 与词面分 RRF 融合排序 | embedding 走 Ollama 本地 API（`POST /api/embed`，Ollama 官方）或 model-service；模型用 BAAI `bge-m3` 或 `nomic-embed-text`（均为开源 embedding 模型，Ollama 可拉） | 个人工具记忆条目 <1k，暴力扫描 <10ms，**不需要 ANN 索引**——YAGNI |
| B · sqlite-vec | SQLite `vec0` 虚表 + KNN 查询，替代手写向量文件                                                                                                     | asg017/sqlite-vec（MIT，SQLite 向量扩展，sqlite-fts 系列继任者）                                                                                       | 条目上万后才值得；引入 SQLite 依赖                         |
| C · LanceDB    | 嵌入式向量库（Rust 编写，Rust/Node binding，无服务端），Tauri Rust 侧新模块管理                                                                               | lancedb 官方仓库（Apache-2.0）                                                                                                                  | 需增量更新/过滤/多模态时再上                               |

**推荐落地顺序**：先 A（改动集中在 `agent-memory.ts` + 新增 embedding 客户端封装，纯函数余弦 + RRF 可单测），阈值暴露到 `governance.json`（如 `recall.vector_weight`）。条目规模破千或需要过滤检索时再评估 B/C。**未做核实的部分**：各模型在本仓实际语料上的召回提升幅度需 A/B 实测（准备 20 组「同义改写」测试对，对比词面 vs 混合命中率）。

### 7.4 企业级缺口声明（暂不做）

治理五件套当前为单机轻量版（见第六章 P3 行）。以下企业级能力**有意不做**，留此为证，后续接团队/多租户场景时再立项：请求转发代理（模型密钥集中托管，本机仍存 settings）、多租户与 RBAC、集中审计上报、策略管理 UI（当前手改 `governance.json`，`governance_get/set` 命令已具备）。
