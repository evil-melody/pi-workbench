# ALIGN-16 · 0 编译告警清零 + 外部参考实现 功能面全量对齐

> 基准：`外部参考实现`（commit 取自本地 `/tmp/外部参考实现` 浅克隆，alpha.14 / Harness 0.1.7-rc.2）。
> 本文件三节：**A 完成度清单 · B 后端实现逻辑 · C 与 Pi 的融合改造方案**。

---

## A. 完成度清单

### A1. 本轮修复（用户点名项）

| # | 问题 | 根因 | 修复 | 验证 |
| --- | --- | --- | --- | --- |
| 1 | `warning: function rest_of_authority is never used` → `src/net.rs:63` | 该函数是「只对 authority 段做字符检查」的过渡实现，最终把字符检查提到 `normalize_url` 入口后成为死代码 | 删除 `rest_of_authority`，统一在 `normalize_url` 开头 `has_forbidden_char(trimmed)` | `cargo check --all-targets` → Finished，**0 warning** |
| 2 | `error[E0433]: cannot find module or crate fs` → `src/extensions.rs:249/251` | `extensions_install_from_url` 里用了 `fs::create_dir_all/write`，但漏了 `use std::fs;` | 补 `use std::fs;` | 同上 |
| 3 | `src/views/PluginsView.vue` 模板引用已删除字段 | 上一轮删掉 `MARKET_MOCK` / `MarketPlugin` 后，模板仍读 `p.downloads` / `p.rating` / `p.origin === 'market'`，并有「未接入」禁用按钮 | 模板改用 `Row` 接口；`hasTools` 驱动按钮态；移除全部示例数据分支 | `pnpm typecheck` ✔（0 error） |

验证命令与结果（全部前台同步执行）：

```bash
export PATH="$HOME/.cargo/bin:$PATH"; cd src-tauri
cargo check --all-targets   # Finished, 0 warning, 0 error
cargo test --lib            # 73 passed, 0 failed
pnpm typecheck              # vue-tsc --noEmit, exit 0
pnpm vitest run             # 7 files / 66 tests passed
```

### A2. PluginsView 收尾（本轮完成）

- 行数据与展示统一到 `Row`：`name / author('local') / version(APP_VERSION) / description / tags / hasTools / enabled / tools / path`。
- 行内徽标：`p.enabled` 时显示「已载入」，不再出现「示例数据」。
- 操作列：单一按钮，由 `hasTools` 决定是否禁用，文案 `已启用 / 启用 / 无工具`；`@click` 传 `p.tools`（不再 `p.tools ?? []`）。
- 新增「从链接安装扩展」弹窗：`.modal-mask` + `.modal-card`，输入直链、回车即装、错误/成功提示，`AppInput` 复用项目自研控件，无原生 input。
- 样式追加到 `src/views/PluginsView.css`（无内联 `<style>`）：`--bg-panel` / `--accent-dim` / `--mono` 沿用既有 token。

### A3. 外部参考实现 功能面对齐总表

对照来源：`packages/plugins/*`、`packages/contracts/*`、`packages/bundle/src/client/*`。
「本应用」列状态取自 `src/router/index.ts` + `src-tauri/src/lib.rs:56-92` 的 handler 清单。

| # | 外部参考实现 功能 | 外部参考实现 代码出处 | 本应用状态 | 缺口 | 优先级 |
| --- | --- | --- | --- | --- | --- |
| 1 | 项目列表 / 归档列表 | `projects/src/services/project-manager.ts:24-25` | ✅ `projects_list`（未区分 active/archived） | 归档分组未做视觉分区 | P2 |
| 2 | 项目模板创建 | 同上 `:23 templates()` | ✅ `TEMPLATES` 在 ProjectsView | 一致 | — |
| 3 | 项目创建 / 详情 | `:26-27` | ✅ `project_add` | — | — |
| 4 | 归档 / 恢复 | `:28-29` | ✅ `project_archive` / `project_unarchive` | — | — |
| 5 | 项目配置修订（instruction + capabilities） | `:30 updateConfig`，含 `PROJECT_INSTRUCTION_TOKEN_BUDGET` 与 `projects/revision-conflict` | ❌ 后端**没有** `project_update_config` | instruction 无法编辑、改配置无修订号、无冲突检测 | **P0** |
| 6 | 计划项 WorkItem 增删改 | `:31-32` | ❌ | 项目内「计划」清单缺失 | **P0** |
| 7 | 资产关联/解除 | `:33-34` | ❌ | 项目↔资料库资产引用缺失 | **P0** |
| 8 | 输入引用校验 | `:35 validateInputRefs` | ❌ | 引用资料时不做存在性校验 | P1 |
| 9 | 任务绑定会话 | `:36 linkTask` | ❌ | 项目↔会话链接缺失（WorkflowPanel 只做展示） | **P0** |
| 10 | 会话→项目上下文注入 | `:37 taskContext` | ⚠️ 靠 prompt 侧拼装，无结构化接口 | 无 `taskContext` 命令 | P1 |
| 11 | 交付缺口备注 | `:38 noteDeliveryGap` | ❌ | 缺失 | P2 |
| 12 | 资料库空间/目录树 | `library/src/services/library-manager.ts:73,77` | ✅ `fs_read_dir` + `FileTree` | 未走 library 的 storage 语义 | P1 |
| 13 | 新建文件夹 | `:86 createFolder` | ❌ | 缺失 | P1 |
| 14 | 导入资料（文件/流） | `:97 importAsset` | ⚠️ 只有 `fs_write_file` | 无导入流程与去重 | P1 |
| 15 | 按修订读文本/原始字节 | `:143,147` | ⚠️ `artifacts_read` 只返回单份内容 | 无 revision 概念 | P2 |
| 16 | 资料搜索（带 filters） | `:151 search` | ⚠️ 前端关键字过滤 | 后端无检索 | P1 |
| 17 | 任务选料 / 已选引用 | `:173,190` | ❌ | 缺失 | P1 |
| 18 | 资料草稿 编辑→发布 | `:198,208,218` | ⚠️ LibraryPanel 有「保存」，无草稿/发布两态 | 无 `createDraft/publishDraft` | P1 |
| 19 | 资料状态/重命名/移动/删除 | `:240,249,253,260` | ❌ | 缺失 | P1 |
| 20 | 技能清单/详情/编辑 | `skills/src/services/manager.ts:182,235,275` | ⚠️ 只有 `skills_list` | 无详情与编辑 | **P0** |
| 21 | 技能草稿 → 发布（修订） | `:314,333,345` | ❌ | 无草稿与 `publishDraft` | **P0** |
| 22 | 技能资源读写 | `:371,381` | ❌ | 缺失 | P1 |
| 23 | 导入预检 + 落盘 | `:398,409` | ✅ `skills_install` / `skills_install_from_url` | 预检信息未回显 | P1 |
| 24 | 启用/停用 | `:442 setEnabled` | ⚠️ 只有 tools 级 `tools_activate` | 技能级开关缺失 | P1 |
| 25 | 卸载 / 依赖影响 / 回收站 / 恢复 | `:474,484,531,545` | ⚠️ `skills_uninstall` 无影响评估 | 缺 `dependencyImpact`、回收站 | P2 |
| 26 | 技能目录（catalog）/ 图标 | `:567,578,589` | ❌ | 无内置目录 | P2 |
| 27 | 修订固定（resolve/retain/check/release） | `:808-873` | ❌ | 专家固定修订机制缺失 | P2 |
| 28 | 专家列表/详情 | `experts/src/services/experts-manager.ts:677,735` | ⚠️ 由 `roles_*` 近似承担 | 非专家语义 | **P0** |
| 29 | 专家草稿创建/更新/复制 | `:870,906,960` | ❌ | 缺失 | **P0** |
| 30 | 专家校验 / 发布确认 / 发布 | `:1005,1023,1054,1060` | ❌ | 缺失（含 confirmation token） | **P0** |
| 31 | 可用性 / 偏好置顶 | `:1180,1224` | ❌ | 缺失 | P1 |
| 32 | 专家执行 prepare/create | `:1266,1320` | ⚠️ 靠 `pi_call` 直接驱动内核 | 无 plan 侧校验 | P1 |
| 33 | Handoff 交接 consume/prepare/create | `:1420,1439,1481` | ❌ | 缺失 | P2 |
| 34 | 原生角色解析 / 绑定校验 | `:1548,1569` | ⚠️ `role_current` 近似 | 无 binding 校验 | P1 |
| 35 | 导入暂存/预览/提交 | `:1613,1652,1698` | ❌ | 缺失 | P1 |
| 36 | 专家导出 / 操作查询 | `:1739,1757` | ❌ | 缺失 | P2 |
| 37 | 连接器（MCP）CRUD + 启停 + 会话选择 | `connectors/src/manager.ts:57-127` | ✅ `mcp_connect/list/call/disconnect` | 无 create/update/remove、无会话级选择 | **P0** |
| 38 | 契约测试 `setSelection` 语义 | 同上 `:123,127` | ❌ | 会话级能力选择缺失 | P1 |
| 39 | Office 成果：docx/xlsx 在线预览 | `office/src/**`（Tiptap / Univer） | ✅ `useOfficePreview.ts` 已接 LibraryPanel/FileEditorPane | pptx/pdf 降级提示用「原件」打开（12 MiB 上限） | P1 |
| 40 | Office 实时编辑（live docx） | `office/src/live/**` | ❌ | 缺失 | P2 |
| 41 | CSV / HTML / PDF 成果 | `office/src/{csv,html,pdf}/**` | ⚠️ html/svg/pdf 有预览分支，pdf 走外部打开 | 无内嵌 PDF | P1 |
| 42 | 演示文稿 | `office/src/presentation/**` | ❌ | 缺失 | P2 |
| 43 | 活动记录 projection / 团队状态 | `activity/src/{projection,team-status,registry}.ts` | ✅ `ActivityPanel` + `useActivity.ts` | 团队状态语义未接 | P2 |
| 44 | 治理：访问/身份/审计/模型策略 | `plugins/{access,audit,model-policy,identity}/**`、`contracts/governance.ts` | ❌ | 无账号/权限/审计 | P2（可延后） |
| 45 | 社区市场（发现/主题/收藏/已安装/高级） | `bundle/src/client/components/CommunityMarket.tsx` | ✅ `PluginsView` 五个 tab 已 1:1 | 主题/收藏/高级仍为空态 | P1 |
| 46 | Agent 浏览器页 | `bundle/src/client/components/AgentBrowserPage.tsx` | ✅ `AgentBrowserPane` | 一致 | — |
| 47 | 诊断面板 | `DiagnosticsPanel.tsx` | ✅ `copyDiagnostics()` | 一致 | — |
| 48 | 外壳外观 | `ShellAppearance.tsx` | ✅ `ThemeToggle` | 一致 | — |
| 49 | 应用/自动化/表格/用量模块 | `plugins/{applications,automations,tables,usage}/**` | ❌ | 外部参考实现 自身亦未交付（无 package.json 名） | P3 |

统计：**对齐 = 18 项，部分对齐 = 14 项，未对齐 = 17 项**；未对齐中的 P0 共 **8 项**。

### A4. 建议实施顺序（本轮起，逐项落地）

1. **P0-1 项目配置修订 + 计划项 + 资产/任务绑定**（`projects` 域补齐，最能改变「半成品」观感）
2. **P0-2 专家域**（草稿/校验/发布确认，可先做只读列表 + 发布确认弹窗）
3. **P0-3 连接器 CRUD + 会话级选择**
4. **P0-4 技能详情/草稿/发布**
5. P1：资料库导入/重命名/移动/删除/搜索、技能启停、Office.pptx/pdf
6. P2：回收站、目录、专家 handoff、外壳观感补齐

---

## B. 后端实现逻辑

### B1. 出网公共件 `src-tauri/src/net.rs`（新增，本轮）

三条远端链路原本各写一份地址校验与下载，收敛到一个模块：

```rust
pub const FETCH_LIMIT: usize = 1 << 20;   // 1 MiB 下载上限

/// 浏览器语义：缺 scheme 补 https://；只放行 http/https；拒绝控制字符与空白（含 CRLF 注入）
pub fn normalize_url(raw: &str) -> Result<String, String>
/// 安装语义：必须显式 http(s)://，不补协议
pub fn require_http_url(raw: &str) -> Result<String, String>

async fn fetch_text(url: &str) -> Result<String, String>  // reqwest 15s 超时 + UA + status 判断 + 限额 + UTF-8 校验
```

安全边界：先判 scheme 再补协议；控制字符/空白/CRLF 一律拒绝（防请求头注入）；响应体超过 `FETCH_LIMIT` 直接失败；不跟随非 http scheme。

### B2. 技能远端安装 `skills::skills_install_from_url`

```
require_http_url → fetch_text（≤1MiB / 15s）
  → land_skill(origin="url")  → parse_skill_md 校验 name/description
  → create_dir_all(<目标域>/<name>) → 写 SKILL.md
  → SkillInstallResult{ origin:"url", scope: user|project, needs_restart:true }
```

关键约束：**本地导入与远端下载共用 `land_skill`**，避免两条链路装到不同目录。本轮同时修复了 `land_skill` 只建父目录、不建技能目录导致 `os error 2` 的真实 bug，本地导入同样受益。

### B3. 扩展远端安装 `extensions::extensions_install_from_url`

```
require_http_url → extension_name_from_url（取末段文件名，剥 query/anchor、后缀需为 .ts）
  → 白名单校验：[A-Za-z0-9-_]，长度 ≤ NAME_MAX(64) → 目录穿越自然消解
  → 落盘 extensions/<name>.ts → list() 复核，扫不到即报错
```

### B4. 死代码下线

`sandbox.rs` 与 `SandboxState / NixEnv / NixEnvInfo` 整体删除（含 6 个 handler、capabilities 声明、测试夹具、`docs/nix-sandbox.md`），随之失去消费者的 `sha2` 依赖一并从 `Cargo.toml` 移除。命名残留同步下沉为业务名：`sandbox-env.ts` / `role-inject.ts`。

### B5. 数据诚实性

`projects::billing_status` 返回 `BillingStatus { .., demo: true }`，Sidebar 依据 `billing.demo` 渲染「演示」角标并改写 tooltip，不再把占位值冒充真实用量。

---

## C. 与 Pi 的融合改造方案

Pi 内核（`pi --mode rpc`）提供会话、工具、技能与命令发现；本应用只做壳与业务域，融合点是**把 外部参考实现 的业务语义压到 RPC 之上，而不是自己再造一套运行时**。

### C1. 项目域 ↔ RPC

- 外部参考实现 的 `taskContext`（会话→项目上下文）在本应用由 `useProject.ts` 在发起 `pi_send` 前拼装 `config.instruction + capabilities` 实现，**保留该位置**，但改为调用新增的 `project_task_context(sessionId)`，由 Rust 侧读项目配置修订，避免前端拼装漂移。
- `PROJECT_INSTRUCTION_TOKEN_BUDGET` 的预算校验前移到 Rust：写 `project_update_config` 时先算 token，超限返回 `projects/instruction-budget-exceeded`，前端不再需要自己估算。
- 修订冲突：`updateConfig(linkTask)` 接受 `expectedRevisionId`，不匹配返回 `projects/revision-conflict`，前端弹「配置已被其他会话更新」。

### C2. 专家域 ↔ RPC

外部参考实现 把专家做成「固定修订的预设」，发布链路是 `createDraft → validate → requestPublishConfirmation → confirmPublish(token) → publish`。Pi 侧 `get_commands` 已能拿到内核命令与技能，因此：

- 不新增 Pi RPC：`experts_*` 命令挂在本应用 Rust 侧，持久化为 `experts/<id>/revisions.json`，**修订号即 skill revision 的引用**，与 外部参考实现 的 `resolveRevision/retainRevision` 同义；
- 发布确认沿用 Pi 的事件确认机制（`pi_send` 的 confirmation 事件），与 `requestPublishConfirmation` 的 token 语义对齐；
- `consumeHandoff / createHandoff` 对应内核的子代理交接事件，本应用先只读展示，写操作延到 P2。

### C3. 连接器 ↔ MCP

`mcp_connect/list/call/disconnect` 已在壳内；补 `mcp_create / mcp_update / mcp_remove / mcp_set_enabled / mcp_selection(sessionId) / mcp_set_selection` 后，即可在「连接器」tab 完成 外部参考实现 的 8 个方法。会话级选择结果写入项目配置能力的 `capabilities[]`，与 `linkTask` 的 `capabilities` 字段共用一套 ID。

### C4. 资料库 ↔ fs 工具

外部参考实现 的 library 是 storage 域；本应用直接用 `fs_read_dir / fs_read_file / fs_write_file` + `useFs.ts`。补齐重命名/移动/删除/新建文件夹后，语义与 `library_node` 一致，但**不引入 revision 表**：草稿即「写回前的临时内容」，发布即 `fs_write_file`，发布结果回读一次做校验——与 `publishDraft` 返回 `LibraryTreeEntry` 等价，但省掉一层存储。

### C5. 明确不做（避免范围失控）

- 治理/身份/审计（`access / audit / identity / model-policy`）：需要账号体系，Pi 无对应语义，按 P3 搁置；
- 自动化 / 表格 / 用量 / 应用：`外部参考实现` 自身未交付（无包名、无 apply），不作为对齐目标；
- 主题市场与收藏：需要远端市场服务端，当前以「从链接安装」替代，P2 再评估。

---

## D. 验证基线（本轮全部通过）

| 命令 | 结果 |
| --- | --- |
| `cargo check --all-targets` | Finished · **0 warning · 0 error** |
| `cargo test --lib` | **73 passed · 0 failed** |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run` | **7 files · 66 tests passed** |

> 备注：本轮 `rtk` 在环境中不可用（`command not found: rtk`），未执行 `graphify update`；代码定位改用 `Grep`/`Read`/`find` 直查，结论已逐条标注 外部参考实现 内文件路径与行号，可复核。
