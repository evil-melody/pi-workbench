# 参考实现 对齐记录 —— 15 号：社区市场真实链路与死代码下线

> 周期：2026-09-27
> 目标：把能力中心/插件市场中仍用 mock/占位糊弄的链路换成真实动作；同步下线没有前端消费者的 `sandbox` 模块。

---

## 1. 完成度清单

| 参考实现 组件 | 本地对应 | 15 号前 | 15 号后 |
|---|---|---|---|
| SkillHub 远端市场 | `CapabilitiesView.vue` SkillHub tab | 远端市场未接入，单条占位卡片 | 从任意 SKILL.md 直链真实安装；已装技能区分 `local`/`url` |
| 社区插件发现 | `PluginsView.vue` 发现 tab | 静态 `MARKET_MOCK` 假列表 | 显示真实扩展清单；新增「从链接安装扩展」 |
| 插件市场安装入口 | `PluginsView.vue` 右上角 | 搜索链接无行为 | 打开安装弹窗，调 `extensions_install_from_url` |
| 本地技能导入 | `CapabilitiesView.vue` 本地技能 | 已可用 | 落盘路径修复：创建 `<name>` 子目录，避免 ENOENT |
| sandbox 模块 | `src-tauri/src/sandbox.rs` + `state.rs` | 5 个命令 + state 无前端消费者 | 整体下线，移除文档与所有引用 |
| 计费状态 | `Sidebar.vue` 余额角标 | 前端硬编码「演示」 | 后端 `BillingStatus.demo` 驱动，UI 不撒谎 |
| 新建项目指令 | `ProjectsView.vue` | 原生 `<textarea>` | 改用 `AppTextarea`，符合「禁用原生控件」铁律 |

---

## 2. 后端实现逻辑

### 2.1 出网公共件 `net.rs`

把三处出网需求收敛到一个文件：

- `normalize_url`：浏览器语义，无 scheme 时补 `https://`，拒绝非法 scheme 与 CRLF/空白注入。
- `require_http_url`：安装语义，必须显式带 `http://` 或 `https://`，不补协议。
- `fetch_text`：15 秒超时、1 MiB 上限、自定义 UA。

原先 `browser.rs`、`skills.rs` 各有一套地址校验，扩展 URL 安装会写成第三套；抽取后避免同一类注入面重复出现。

### 2.2 技能远端安装 `skills_install_from_url`

- 调 `require_http_url` 校验 → `fetch_text` 下载 → 复用本地安装的 `land_skill` 落盘。
- `land_skill` 修复了一个真实 bug：之前只创建技能根目录，没创建 `<name>` 子目录，写入必然 `ENOENT`（本地导入同样受影响）。TDD 先写测试时暴露。
- `SkillEntry` 新增 `origin` 字段：`local`（磁盘扫描/本地导入）| `url`（远端直链）| `kernel`（内核回报）。

### 2.3 扩展远端安装 `extensions_install_from_url`

- 校验 URL 必须是 `.ts` 直链。
- 文件名白名单：`[A-Za-z0-9_-]`，最长 64 字符；路径穿越被「只取最后一段」自然消解。
- 落盘到 `extensions/<name>.ts`，然后重新扫清单返回真实 `ExtensionInfo`。
- 调用方在 Pi 启动时通过 `--extension` 加载该目录即可生效。

### 2.4 sandbox 下线

- 删除 `src-tauri/src/sandbox.rs`、`docs/nix-sandbox.md`。
- 删除 `state.rs` 中 `NixEnvInfo` / `SandboxState` / `NixEnv`。
- 删除 `lib.rs` 中 `mod sandbox`、`manage(SandboxState)`、5 个 `sandbox_*` handler。
- `extensions.rs` 测试夹具里的 `sandbox_list` / `sandbox_run` 改成中性的 `search_symbols` / `search_text`。
- `capabilities.json` 与 `pi_bridge.rs` 中的默认扩展名 `sandbox-env.ts` → `sandbox-env.ts`。
- `Cargo.toml` 移除不再使用的 `sha2`。

### 2.5 计费状态真实化

`BillingStatus` 新增 `demo: bool`，占位值置 `true`。`Sidebar.vue` 据此渲染「演示」角标，而不是前端硬编码。接入真实 model-service/usage-service 时只需把后端 `demo` 改成 `false`，UI 不变。

---

## 3. 与 Pi 的融合改造方案

1. **市场和技能的边界**：Pi 0.87.1 本身不区分 skill 与 extension；本应用沿用 参考实现 的版式分层——
   - 技能市场 = `skills/` 目录下的 `SKILL.md`。
   - 插件市场 = `extensions/` 目录下的 `.ts` 文件。
   - 两者都通过「远端直链安装」补齐市场能力，不臆造一个不存在的服务端。

2. **安装来源可追踪**：`SkillEntry.origin` 让 UI 能区分「本机导入」与「远端直链安装」，避免用户看到来源不明的技能。

3. **死代码不下线会腐烂**：`sandbox.rs` 有完整 Nix 实现但没有任何面板/命令调用；继续保留只会随 API 漂移变成负资产。下线后设计思想仍留在 `docs/roles.md` 的 `search_code` 示例中。

4. **安全边界统一**：地址校验、下载限额、文件名白名单都在后端执行，前端只负责收集输入和展示结果。

---

## 4. 验证结果

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 通过 |
| `pnpm build` | ✅ 229 modules / 6.80s |
| `pnpm vitest run` | ✅ 7 files / 66 passed |
| `cargo test --lib` | ✅ 73 passed，0 warnings |
| `cargo check --no-default-features` | ✅ 通过，0 warnings |

> 注：本地 `rtk` 命令不可用，因此本回合未跑 `graphify update .` 与 `code-review-graph`；后续如恢复请补一次同步。

---

## 5. 新增/修改文件

| 路径 | 说明 |
|---|---|
| `src-tauri/src/net.rs` | 新增：地址校验 + 文本下载公共件 |
| `src-tauri/src/skills.rs` | 远端安装改走 `net.rs`；修复 `land_skill` 子目录 bug；`SkillEntry.origin` |
| `src-tauri/src/browser.rs` | `normalize_url` 改从 `net.rs` re-export |
| `src-tauri/src/extensions.rs` | 新增 `extensions_install_from_url`；扩展名白名单；测试 |
| `src-tauri/src/lib.rs` | 注册 `net` 模块、`skills_install_from_url`、`extensions_install_from_url`；移除 sandbox |
| `src-tauri/src/state.rs` | 移除 Nix 沙箱类型 |
| `src-tauri/src/projects.rs` | `BillingStatus.demo` |
| `src-tauri/Cargo.toml` | 加 `reqwest`，移除 `sha2` |
| `src/composables/useSkills.ts` | 新增 `skillsInstallFromUrl`，`SkillEntry.origin` |
| `src/views/CapabilitiesView.vue/.css` | SkillHub 改为真实直链安装入口 |
| `src/views/PluginsView.vue/.css` | 移除 mock 市场，改为真实扩展清单 + 从链接安装 |
| `src/views/ProjectsView.vue/.css` | 指令输入框改用 `AppTextarea` |
| `src/components/layout/Sidebar.vue` | 余额角标由 `billing.demo` 驱动 |
| `src-tauri/capabilities.json` | 默认扩展名 `sandbox-env.ts` |
| `src-tauri/src/pi_bridge.rs` | 候选扩展名同步 |
| `docs/roles.md` | 示例工具名去 sandbox |
| `docs/nix-sandbox.md` | 🗑 删除 |
| `src-tauri/src/sandbox.rs` | 🗑 删除 |

---

## 6. 剩余未完成

| 优先级 | 项 | 说明 |
|---|---|---|
| P1 | 与 参考实现 功能逐项对齐 | 用户要求优先对照 `https://github.com/外部参考实现` 的功能清单；当前外壳/页面版式已对齐，具体能力（Deliverable workspace、第三方 插件市场 插件生态）需按仓库截图进一步确认 |
| P1 | 远端市场服务端 | 当前是「直链安装」兜底；真正的 SkillHub / 插件市场 需要自建或接入第三方 catalog API |
| P2 | 诊断面板 | 外部参考实现 有 `DiagnosticsPanel`，本应用未实现 |
| P2 | pnpm 版本警告 | `corecore prepare pnpm@12.6.0 --activate`（环境级，不影响代码） |
