# 参考实现 对齐 17 · 项目域完整化（A 轮）

> 对应 参考实现 `packages/plugins/projects` 的 `ProjectService` 全部能力面。
> 上一轮「项目」只有 CRUD + 归档，本轮补齐配置修订、计划项、资产关联、会话任务绑定与目录选择。

## 1. 完成度清单

### 1.1 后端（`src-tauri/src/projects.rs`，150 → 1300+ 行）

| 参考实现 能力 | 命令 | 状态 |
|---|---|---|
| `templates()` | `projects_templates` | ✅ 5 个模板内置，与 参考实现 文案一致 |
| `list / listArchived` | `projects_list` | ✅ 按更新时间倒序 |
| `create` | `project_add` | ✅ 带模板预填指令 + 首条修订 |
| `get` | `project_get` | ✅ 返回完整快照（project / config / 计划项 / 资产 / 任务 / 活动） |
| `archive / restore` | `project_archive` / `project_unarchive` | ✅ 沿用 |
| `updateConfig` | `project_update_config` | ✅ 修订号自增、乐观锁、token 预算拦截 |
| `addWorkItem` | `project_add_work_item` | ✅ |
| `updateWorkItem` | `project_update_work_item` | ✅ 乐观锁 |
| — | `project_remove_work_item` | ✅ 参考实现 未导出删除，本项目补齐（面板需要） |
| `addAsset / removeAsset` | `project_add_asset` / `project_remove_asset` | ✅ 同资产同版本去重 |
| `validateInputRefs` | 并入 `linkTask` | ✅ 过期引用拒绝 |
| `linkTask` | `project_link_task` | ✅ 能力必须已绑定在项目配置里 |
| `taskContext` | `project_task_context` | ✅ 按任务记录的修订取配置，不吃后来的改动 |
| `noteDeliveryGap` | — | ⏸ 归属治理域，见对齐清单 P2 |
| 旧 projects.json | 导入 | ✅ 自动补首条修订 |

### 1.2 前端

| 新增 | 位置 | 说明 |
|---|---|---|
| 项目工作台 | `src/views/ProjectWorkspace.vue`（新） | 配置 / 计划项 / 资产 / 活动 四个页签 |
| 目录选择器 | `src/composables/useDirPicker.ts` + `tauri-plugin-dialog` | 新建项目与工作台都能选目录 |
| 领域类型与命令 | `src/composables/useProject.ts` | 15 个 invoke 封装 + 错误码翻译 |
| 项目详情路由 | `/projects/:id` | 列表卡片进入，卡片右上角「在对话中打开」直达 Chat |
| 上下文注入 | `ChatView.submit` | 会话下发前拼项目上下文前缀 |
| 单元测试 | `tests/projectDomain.spec.ts` | 7 用例 |

### 1.3 修复的真实缺陷

1. **`create_project` 的 `config_revision_id` 写成了空串**——项目从创建起就挂在一个不存在的修订上，任何 `project_get` 都会 `projects/not-found`。由 RED 测试逼出。
2. **ID 生成撞号**——`new_id` 只用时间戳纳秒，同一纳秒内连续两次调用会返回相同 id（表现为「第二个项目覆盖第一个」）。改为纳秒 + 原子自增计数器。
3. **测试自身不确定**——`first_project_id` 取 `HashMap` 任意键，跨项目用例会随机落到本项目，偶发失败。改为显式取 id。

## 2. 后端实现逻辑

### 2.1 数据模型：一条命令一个修订，不原地覆盖

```rust
pub struct Project { config_revision_id: String, archived: bool, path: Option<String>, .. }
pub struct ProjectConfigRevision { id, project_id, number, instruction, capabilities, created_by, created_at }
```

配置不可变追加：每次保存生成新修订，`Project.config_revision_id` 指向当前生效的那条。好处是历史会话仍然指向自己那晚的修订——`task_context` 按 `task.config_revision_id` 取配置，而不是取项目当前配置，所以改了配置不会让旧会话突然套用新能力。

写入侧三道闸门：

```rust
if previous.id != expected_revision_id || previous.number != revision_number {
    return Err("projects/revision-conflict")
}
if estimate_instruction_tokens(instruction) > PROJECT_INSTRUCTION_TOKEN_BUDGET {   // 8000
    return Err("projects/instruction-budget-exceeded")
}
```

token 估算对齐 参考实现 `instruction-budget.ts`：ASCII 每 4 字符 1 token，非 ASCII 每字符 1 token。

### 2.2 全量落盘 + 旧格式迁移

`projects.json` 从 `Vec<Project>` 变成 `ProjectStore{ projects, configs, work_items, assets, tasks, activity }`。`decode_store` 先按新格式解析，失败再按旧数组解析并给每个项目补一条 `created_by: "migrated"` 的初始修订——老用户的项目不会因为格式变更而打不开。

活动流水只保留最近 200 条，避免文件无上限膨胀。

### 2.3 会话→项目上下文注入

```rust
pub fn task_context(store, session_id) -> Result<Option<ProjectTaskContext>, String>
```

`ChatView.submit` 在下发 prompt 前调 `taskContextPreamble()`，把「项目名 + 修订号 + 指令 + 本次可用能力 + 本次引用」拼成前缀。**没有改内核的提示词模板**，因为 Pi 的 RPC 只接受 `type: prompt` 的文本；把结构化上下文走同一条通道，用户能看到、也能被完整记录，不会出现「内核悄悄吃了上下文但没人知道」。

## 3. 与 Pi 的融合改造方案

| 环节 | 当前 | 与 Pi 内核的结合点 |
|---|---|---|
| 项目配置指令 | 存本地 | 未来可用 Pi 的 `Skill` 注入：把指令当作一个隐式 skill 挂进 `session_files` |
| 计划项 | 本地 CRUD | 可映射为 Pi 的 todo list（`applyEvent` 已有 todo 投影），读回时双向同步 |
| 能力绑定 `skill/expert/connector` | 自由文本 `kind:id` | Pi 侧的 skill id 直接可用；`extensions_list` / `skills_list` 可下拉选择而非手输 |
| 目录绑定 | `tauri-plugin-dialog` 选目录 | 直接作为 `pi_start` 的 cwd，已由 ChatView 的 `watch(cwd)` 走通 |
| 会话任务绑定 | `sessionId = pi-workbench:default` | Pi 是单条常驻会话；将来支持多会话树时按 leaf id 绑定即可 |
| 出网指令 | 预算 8000 token | 若接 usage-service，`demo: true` 改 false，UI 的「演示」角标自动消失 |

## 4. 验证基线

```
cargo check --all-targets   → 0 warning 0 error
cargo test --lib            → 93 passed, 0 failed（连跑 8 次稳定）
pnpm typecheck              → exit 0
pnpm vitest run             → 8 files / 73 tests passed
pnpm build                  → built in 6.30s
```

新增依赖：`tauri-plugin-dialog 2.7.3` / `@tauri-apps/plugin-dialog 2.7.3`；
`capabilities.json` 增加 `core:default / dialog:default / opener:default`。

## 5. 下一步

B 轮：专家域（草稿 / 校验 / 发布确认 token / 发布）。
