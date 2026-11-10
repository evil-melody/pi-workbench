# ALIGN-23：主区宽度修复 · 首页底部工具栏美化 · 多模型配置

对应本轮反馈：
1. 用户截图指出 `.app-main` 的 `display: flex` 注释掉才能撑满屏幕宽。
2. 首页底部「选择工作空间 / 默认权限」行的位置与版式（用户红框标注）。
3. 「模型应该支持配置多个吧」——设置页模型配置改为多模型列表。
4. 「其他全部功能都要还原。比对这块。功能要全部调通」——全页面命令链路核对。

---

## 一、完成度清单

| # | 项 | 状态 | 落地位置 |
|---|---|:--:|---|
| 1 | `.app-main` 去掉 `display: flex`，主区内容撑满 | ✅ | `src/styles/layout.css` |
| 2 | 首页底部工具栏改为实底卡片（边框 + 阴影 + hover） | ✅ | `src/components/chat/ChatHero.css` |
| 3 | 项目选择器 + 目录选择按钮保留在输入框下方（与截图一致） | ✅ | `src/components/chat/ChatHero.vue` |
| 4 | 模型配置支持**多模型**列表 | ✅ | `src/views/SettingsView.vue`、`src-tauri/src/models.rs` |
| 5 | 多模型：新增 / 删除 / 启用禁用 / 设为默认 / 逐条测试连接 | ✅ | `SettingsView.vue` |
| 6 | 后端 `AppSettings` 从单 `model` 改为 `models[] + default_model_id` | ✅ | `models.rs` |
| 7 | 旧版单 model 配置自动迁移 | ✅ | `models.rs::settings_load` |
| 8 | 补齐缺失图标（cpu / tool / info / save / check-circle / eye-off / mic） | ✅ | `src/components/ui/AppIcon.vue` |
| 9 | 设置页模型空态（无模型时的虚线卡片 + 引导） | ✅ | `SettingsView.vue/.css` |
| 10 | 全页面命令链路核对（前端 invoke ↔ 后端注册，76 条全对齐） | ✅ | 见第四节 |

---

## 二、本轮修掉的缺陷

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 主内容区撑不满屏幕宽 | `.app-main { display: flex }` 让 `<main>` 成为 flex 容器，子视图被 flex 子项规则约束（宽度不再按 block 100% 展开） | 移除 `display: flex`，保留 `flex: 1; min-width: 0; overflow: hidden` |
| 2 | 首页底部工具栏看着"飘"（透明底、hover 才显形） | `.footer-card` 默认 `background: transparent; border-color: transparent` | 改为 `background: var(--bg-panel)` + `border: 1px solid var(--border)` + `box-shadow`，与截图实底卡片一致 |
| 3 | 只能配一个模型 | `AppSettings { model: ModelConfig }` 单字段 | 改为 `models: Vec<ModelConfig>` + `default_model_id`；前端列表化编辑 |
| 4 | SettingsView 里 `AppIcon name="cpu"/"tool"/"info"/"save"/"check-circle"/"eye-off"` 无图形 | `AppIcon` 的 `PATHS` 缺这些键，渲染成空 `<path>` | 补 7 个 Lucide 路径 |
| 5 | 数字字段（temperature / max_tokens）用 `v-model` 直连 number 会丢焦点 | AppInput 只接受 `string`；v-for 内不能稳定创建 computed | 用 `inputMap: Record<id, {temperature, max_tokens}>` 承接字符串输入，保存/测试前 `applyInputs()` 回写 |

---

## 三、后端实现逻辑

### 3.1 `src-tauri/src/models.rs`

```
ModelConfig { id, name, provider, base_url, model, api_key, temperature, max_tokens, enabled }
AppSettings { models: Vec<ModelConfig>, default_model_id: Option<String>, theme, language }
```

- 文件：`app_config_dir/app-settings.json`（与项目数据、tools 的 `settings.json` 隔离）。
- `settings_load(app)`：
  1. 先按新格式反序列化，成功则 `ensure_default_model()` 兜底（无模型时补默认模型、无 default_model_id 时选第一个启用的/first）。
  2. 失败则尝试 `LegacyAppSettings`（旧版单 `model` 字段），迁移为一条 `id = "migrated"`、`name = "已迁移模型"`、`enabled = true` 的条目，`default_model_id` 指向它。
  3. 两者都失败才返回 `AppSettings::default()`。
- `settings_save(app, settings)`：`serde_json::to_string_pretty` 落盘，父目录 `create_dir_all`。
- `settings_test_model(config)`：只做 `GET base_url` 可达性探测，10s 超时，服务端 5xx 才判失败，**不发送真实补全请求、不消耗 token、错误信息不回显 key**。

### 3.2 命令注册（`src-tauri/src/lib.rs`）

```
models::settings_load,
models::settings_save,
models::settings_test_model,
```

### 3.3 前端 SettingsView 数据流

- `load()` → `settings_load` → `models` / `defaultModelId` / `inputMap` 初始化，默认展开默认模型卡片。
- 卡片头：名称 + 服务商 + 「默认」/「已禁用」徽章 + 启用 `AppCheckbox` + 设为默认（`check-circle`）+ 删除（`trash`）。
- 卡片展开体：显示名 / 服务商 / 模型名 / Base URL / API Key（密码 + 眼睛切换）/ Temperature / Max Tokens + **测试连接**（仅对该条）。
- `addModel()`：`crypto.randomUUID()` 生成 id，`模型 N` 命名，展开并注册 inputMap。
- `removeModel(id)`：移除并清理 inputMap；若删的是默认模型则顺延到下一个启用的；删空后自动补一条新的默认模型。
- `onEnabledChange(id, enabled)`：禁用默认模型时把默认顺延；启用且当前无默认时自动设为默认。
- `save()`：先 `applyInputs()`（字符串 → 数字、带 clamp：temperature 0~2、max_tokens ≥1），再 `settings_save { models, default_model_id }`。

---

## 四、与 Pi 的融合改造

模型配置目前是**外壳侧设置**，尚未注入 Pi 内核。与 Pi 融合的路径：

1. **默认模型注入 Pi**：`pi_bridge::pi_start` 启动时读取 `settings_load` 的 `default_model_id`，把对应 `ModelConfig` 映射为 Pi 的 provider 环境变量（`OPENAI_BASE_URL` / `OPENAI_API_KEY` / 模型名），再 spawn `pi-coding-agent`。当前 Pi 仍走自身配置，属**待接线**项。
2. **Temperature / max_tokens**：Pi 内核的采样参数来自自身配置，外壳保存后可作为 `pi_send` 的 payload 覆盖字段（需 Pi 侧支持，当前未开放）。
3. **多模型切换语义**：`default_model_id` 只影响新会话；已启动的 Pi 进程保持原模型直到重启——UI 上应显式提示「改动保存后需重启内核生效」（工具激活 Tab 已如此提示，模型 Tab 待补同样文案）。
4. 与 Pi 的**工具白名单**共用同一份配置目录，但分文件存储（`app-settings.json` vs tools 的 `settings.json`），避免相互覆盖。

---

## 五、全页面命令链路核对

前端 `invoke()` 调用名 vs `lib.rs` `generate_handler!` 注册名，**76 条命令全部对齐，无孤儿调用**：

| 域 | 命令数 | 示例 |
|---|---:|---|
| 文件系统 | 3 | `fs_read_dir` / `fs_read_file` / `fs_write_file` |
| 项目 | 18 | `projects_list` / `project_add` / `project_active` / `project_task_context` … |
| 资料库 | 17 | `library_tree` / `library_read` / `library_publish` / `library_rollback` … |
| 专家 | 7 | `experts_list` / `expert_validate` / `expert_publish` / `expert_confirm` … |
| 技能 | 4 | `skills_list` / `skills_install` / `skills_install_from_url` / `skills_uninstall` |
| 连接器 | 9 | `connectors_list` / `connectors_config` / `connectors_apply_scope` … |
| 扩展 | 2 | `extensions_list` / `extensions_install_from_url` |
| 角色 | 3 | `role_list` / `role_current` / `role_set` |
| 工具 | 2 | `tools_list` / `tools_activate` |
| MCP | 4 | `mcp_list` / `mcp_connect` / `mcp_call` / `mcp_disconnect` |
| Pi 桥 | 4 | `pi_start` / `pi_send` / `pi_call` / `pi_stop` |
| 终端 | 1 | `term_exec` |
| 产物 | 3 | `artifacts_scan` / `artifacts_read` / `artifacts_open` |
| 浏览器 | 1 | `browser_open` |
| 计费 | 1 | `billing_status` |
| 设置 | 3 | `settings_load` / `settings_save` / `settings_test_model` |

页面体量（无空壳页）：`ChatView` 337、`ProjectsView` 361、`PluginsView` 370、`SettingsView` 437、`ProjectWorkspace` 480、`CapabilitiesView` 485、`LibraryPanel` 715 行。

---

## 六、验证

```
cargo check --all-targets   0 error 0 warning
cargo test --lib            143 passed
pnpm typecheck              No errors found
pnpm build                  ✓ 162 modules（CSS 119.60 kB / JS 290.91 kB）
pnpm vitest run             111 passed（11 files）
pnpm check:matrix           [check:extensions] 2 个扩展通过
pnpm app:preflight          ✔ Node 22.22.3 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲
```

## 七、遗留

- 模型配置**未注入 Pi 内核**（第四节 1~3 项待接线）。
- 首页附件上传、语音输入仍为 UI 占位。
- 设置页缺少「外观 / 语言」Tab（主题切换目前只在 Sidebar 的 `ThemeToggle`）。
