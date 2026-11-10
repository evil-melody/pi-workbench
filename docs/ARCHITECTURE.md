# Pi Workbench · 产品结构与工程契约

> 对象：本仓（Tauri 2 + Vite + Vue 3 + Pi `0.87.1` 内核）
> 内核：Pi `0.87.1`（`@earendil-works/pi-coding-agent`）
> 术语：文中「参考基线」指立项时对照的外部产品能力清单（仅作取舍讨论用），本仓不依赖任何外部仓库、不搬运其代码。
> 与 [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md) 的关系：后者管「内核能力落地」，本文管「产品结构与工程契约」。冲突时以本文的合并边界为准。

---

## §0 结论（先行）

1. **产品骨架整套自建，内核不换。** 内核自己不提供模型与工具，本仓就是「固定版本的内核 + 外壳 + 能力对象」的组合。取法：Pi 是唯一内核，能力对象（项目 / 资料库 / 专家 / 技能 / 连接器 / 成果工作区）在本仓是一等公民，扩展一律以 **Pi extension** 形式挂载。
2. **两层能力模型必须分清**：Skill（说明、脚本、资源，可导入 `SKILL.md`）与插件（扩展内核/工具/服务）不是一回事。当前仓库把两者混在一个 `SkillsPanel` 里，是「能力不可组合」的根因。
3. **固定上游 + 自动校验**是工程契约的核心：参考实现 用 `upstream.json` 锁版本、用 `check:*` 脚本校验对齐。本仓库已有雏形（`piVersion` + `app:preflight`），需要补齐技能/插件侧的对齐校验。
4. **本轮已落地**：`npm run app:dev` 一键拉起 + 环境前置校验；修复 `src-tauri/target` 中迁移残留导致的 `cargo check` 失败；浏览器模式（`app:dev:web`）不再因调用内核而崩溃。
5. **待办分三期**（§4）：A 期打通技能/资料/连接器与内核的闭环；B 期引入成果工作区；C 期工程化（校验矩阵 + 测试）。

---

## §1 环境版本矩阵（实测 2026-09-26）

| 工具 | 版本 | 状态 | 备注 |
|---|---:|---|---|
| Node | v22.22.3 | ✅ | 满足 `engines.node >= 20` |
| npm | 10.9.7 | ✅ | |
| pnpm | 12.6.0 | ✅ | 与 `packageManager` 一致 |
| bun | 1.4.2 | ✅ | 可选 |
| Pi（内核） | 0.87.1 | ✅ | `@earendil-works/pi-coding-agent`；注意同名 `pi-number` 是圆周率包 |
| rustc / cargo | 1.98.1 | ✅ | 在 `~/.cargo/bin`，**不在默认 PATH**，桌面模式必须先注入 |
| Tauri CLI | 2.x（cargo-tauri） | ✅ | 通过 `pnpm tauri` 调用 |
| Nix | 未安装 | ⚠️ | 沙箱面板自动回退宿主模式，不阻塞 |
| rtk / graphify | rtk 0.42.4（graphify CLI 未装） | ⚠️ | 代码图谱走 rtk；首次建图需 `graphify . --code-only --no-cluster` |

**本次修复的构建阻塞**：`cargo check` 报 `failed to read plugin permissions: .../pi-workbench/src-tauri/target/.../app_hide.toml`。
根因是本仓曾整体从 `NextCode/pi-workbench/` 迁到 `NextCode/`，`src-tauri/target/` 内旧的 tauri build 产物把**旧绝对路径**写死，产物中的 permissions 目录内容为空 → tauri-build 读不到命令文件。
修复方式：删除失效产物（`tauri-ff8d8ed9d810ebfd`、`tauri-175bca1fab00c161`、`tauri-f205e04a24ca11d0`）后 `cargo check` 通过（4.84s）。
**迁移仓库时若再遇到，直接删这几个 build 目录，不要 `cargo clean`（重编代价高）。**

---

## §2 参考实现 可借鉴点 → 本仓库落点

| # | 参考实现 做法 | 我们有没有 | 落到 Pi Workbench 的具体位置 |
|---|---|---|---|
| W1 | **不重造内核**：Electron 外壳 + 固定版本 DeepSeek Harness 子模块，`upstream.json` 锁版本 | ✅ 精神一致 | `package.json#piVersion` + `scripts/app-dev.mjs` 前置校验内核版本，不符直接失败 |
| W2 | **六类一等对象**：项目 / 资料库 / 专家 / 技能 / 连接器 / 成果工作区 | 部分 | 项目✅、专家✅(`roles.rs`)、连接器✅(`mcp.rs`)；资料库❌(`LibraryPanel` 占位)、技能⚠️(静态 `SkillsPanel`)、成果工作区❌ |
| W3 | **两层能力分层**：Skill（说明/脚本/资源）vs 插件（扩展 host/工具/服务） | ❌ 混淆 | Skill → Pi 原生 `get_commands` + `SKILL.md` 导入；插件 → Pi extension `registerTool` / `setActiveTools` |
| W4 | **按需加载工具**（描述不进 system prompt，激活才进） | 部分 | `setActiveTools(names)`，连接面板「注入 Pi」按钮 |
| W5 | **能力包 = 可分发单元**：参考实现 功能包本身也是插件 | ❌ | 新增 Pi 能力清单 `src-tauri/pi-manifest.json` 声明「能力 → 提供 extension」，随内核加载；第三方按同一清单适配 |
| W6 | **成果工作区**：在支持的格式内预览/编辑成果（HTML/PDF/ office 工作副本） | ✅ | Artifact 面板：纯前端预览 HTML/MD/JSON；Office 预览已接——docx/xlsx 直接渲染，pptx/pdf 降级提示用「原件」打开（12 MiB 上限），仅预览不改写（避免保真陷阱） |
| W7 | **校验脚本矩阵**：`check:layout` / `check:*-alignment` / `verify-*` | ❌ | `app:check`（环境→Rust→前端）+ 后续 `check:skills` / `check:extensions` |
| W8 | **显式声明边界**：README 明确标注 Alpha 限制、未验证项 | ✅ | README「状态」段 + 本文 §5 未验证清单 |
| W9 | **桌面包内置运行时**：用户不必自装 Node/Python | ⚠️ | 长线：桌面包内置 Pi 与 Node，避免 PATH 依赖（当前仍需 `pi` 在 PATH） |

> 边界说明：本仓库**不**引入 Electron；桌面壳保持 Tauri 2。参考实现 用 Electron 只是它壳层选型的产物，不是它的方法论。

---

## §3 融合后的目标结构

```
┌ L5 表现层  Vue3 工作区：对话 / 会话树 / 文件 / 终端 / 技能 / 资料 / 连接器 / 成果
├ L4 编排层  Tauri commands + 事件总线（pi://event）
├ L3 能力层  Pi RPC 桥 · MCP Gateway · Nix 沙箱 · 能力清单解析
├ L2 插件层  Pi extension（每能力一个文件）：
│             sandbox-env.ts  沙盒执行面
│             role-inject.ts  专家角色注入
│             skills.ts  ← 新增：SKILL.md 扫描 + 注册为 Pi command
│             artifact.ts ← 新增：成果预览/编辑工具
└ L1 内核层  Pi 0.87.1 原生：会话树 · 工具 · 模型 · 压缩 · cost
```

合并原则（对齐 §0 第 1 条）：

- **L1 不重复实现**：会话树、分支、工具集、压缩、token 计数全部走 Pi；本仓库只写「策略与接缝」。
- **L2 一个能力一个 extension**，同名能力不跨文件重复注册。
- **能力清单单一真源**：`src-tauri/pi-manifest.json` 声明每个能力由哪个 extension 提供、依赖什么状态（Tauri ACL 在 `src-tauri/capabilities/default.json`，两者职责分离）。
- **凭证不入库**：provider key 一律由 Pi 自身管理，本仓库不存、不读、不打印。

---

## §4 合并路线（分三期，每期独立可验收）

### A 期 · 打通「能力对象 ↔ 内核」✅ 已完成

| 项 | 动作 | 落点 | 状态 |
|---|---|---|---|
| A1 | `SkillsPanel` 接 `get_commands`，显示来源（`source: skill|prompt|extension`）、路径、作用域、来源（disk/kernel） | `skills.rs::skills_list` + `SkillsPanel.vue` | ✅ |
| A2 | 导入 `SKILL.md` 前预检 frontmatter，合法后落盘到 `<agent-dir>/skills/<name>/` 或项目 `.pi/skills/<name>/`，返回 `needs_restart` | `skills.rs::skills_install` | ✅ |
| A3 | `LibraryPanel` 接 fs 能力：目录列表 + 文本预览 + 回写（越界由 `fs.rs::resolve` 拒绝） | `LibraryPanel.vue` | ✅ |
| A4 | Pi 能力清单（`pi-manifest.json`）+ 加载器，并在启动时校验内核版本与技能/工具声明 | `capabilities.rs` + `pi-manifest.json` | ✅ |
| A5 | 连接器「注入 Pi / 取回」写 `<agent-dir>/settings.json#defaultTools` | `tools.rs` + `ConnectorsPanel.vue` | ✅（边界见下） |

**验收（已实测，2026-09-26）**：

1. 向真实的 Pi `0.87.1` 发 `{"type":"get_commands"}`，返回 85 条技能命令与 1 条内联扩展命令，字段与文档一致（`source: "skill"` / `sourceInfo.path` / `scope: "user"`）。
2. 安装一个测试技能 `piwb-verify` 后重启 RPC 内核，`get_commands` 立刻出现 `skill:piwb-verify`，路径正确；测试技能已清理。
3. 畸形技能（`name: BAD_Name`，大写 + 单段连字符）**不会被内核加载，但也不会拖垮启动**（技能数仍为 85）——这正是 A2 把校验前移到安装期的理由。
4. `cargo test --lib -- skills:: capabilities:: tools::` 全绿（当次快照 19 passed；**通过数以闸门输出为准**）。
5. `cargo check` 无 warning；`pnpm build` / `vue-tsc` / `pnpm app:check` 均通过。

**A5 的诚实边界**：Pi 自身没有把工具集暴露成 RPC 命令，「注入 Pi」在本仓库落到写 `settings.json#defaultTools`（`settings.md` 明文支持，`defaultTools` 为 `string[]`，影响内置/扩展/自定义工具的激活）。但本仓库的 MCP server 跑在 **Tauri 侧**，`Pi` 进程拿不到这些工具，因此点「注入」后落在白名单里的是工具名，真正让内核可见仍需要一条 Tauri→Pi 的 extension 桥接（排在 B/C 期）。UI 上的文案已明示「下次启动内核时生效」，不宣称已端到端打通。

### B 期 · 成果工作区（对齐 W6）

| 项 | 动作 | 落点 |
|---|---|---|
| B1 | 会话消息里的文件路径 → 成果卡片（类型/预览入口） | `MessageList.vue` |
| B2 | 纯前端预览：HTML / MD / JSON / SVG；图片点击放大 | 新增 `src/components/artifact/` |
| B3 | Office（docx/xlsx/pptx）：只读预览 + 「用外部应用打开」，明确不承诺保真 | 同上 |

**验收**：一个 `index.html` 成果能在内嵌预览里渲染并可继续编辑。

### C 期 · 工程契约（对齐 W7/W8）

| 项 | 动作 |
|---|---|
| C1 | `check:skills` —— 校验 skills 目录格式（`SKILL.md` 首行元数据） |
| C2 | `check:extensions` —— 校验 extension 文件的 API 兼容性与重复注册 |
| C3 | `check:pi-alignment` —— 校验内核版本与 `piVersion` 一致（并入 `app:preflight`） |
| C4 | Vitest 覆盖 `usePi.handle()` / `useSessionTree.flattenTree`；Rust 侧补 `spec_id`/MCP id 路由单测 |
| C5 | README 全量重写（含本方案与边界声明） |

---

## §5 本轮已落地的变更

### 第一轮（工程契约）

| 文件 | 变更 |
|---|---|
| `package.json` | 新增 `app:dev` / `app:dev:web` / `app:build` / `app:check` / `app:preflight`；新增 `engines.node`、`piVersion` |
| `scripts/app-dev.mjs` | 新增：前置校验（Node / pi 版本 / cargo / 端口）+ dev / web / build / check 四个任务 |
| `src/composables/usePi.ts` | 新增浏览器模式降级：非 Tauri 环境明确拒答，不再抛底层错误 |
| `src/views/ChatView.vue` + `.css` | 浏览器模式下对话区顶部提示条，说明需 `npm run app:dev` |
| `src-tauri/target/` | 删除迁移残留的失效 build 产物，恢复 `cargo check` |

### 第二轮（A 期）

| 文件 | 变更 |
|---|---|
| `src-tauri/src/skills.rs` | 新增：`SKILL.md` frontmatter 解析与校验、递归扫描、`get_commands` 内核清单合并、`skills_list` / `skills_install` |
| `src-tauri/src/tools.rs` | 新增：`settings.json#defaultTools` 白名单读写，`tools_list` / `tools_activate` |
| `src-tauri/src/capabilities.rs` | 新增：能力清单加载与校验、内核版本对齐检查；启动日志打印能力规模 |
| `src-tauri/pi-manifest.json` | 新增：能力单一真源（内核版本钉 0.87.1、技能目录、内置工具、extension 列表；Tauri ACL 另见 `capabilities/default.json`） |
| `src-tauri/src/pi_bridge.rs` | `lock_seq` 提升为 `pub(crate)`，供 `skills.rs` 复用发号逻辑 |
| `src/components/panels/SkillsPanel.vue` | 技能面板下线占位内容，接 `skills_list` / `skills_install`，展示来源与「重启内核」入口 |
| `src/components/panels/LibraryPanel.vue` | 资料库接 fs：目录浏览、文本预览、回写 |
| `src/components/panels/ConnectorsPanel.vue` + `.css` | 连接器增加工具白名单条与「注入 Pi / 取回」 |
| `src/composables/useSkills.ts`、`useTools.ts` | 新增：薄 IPC 封装与类型 |

验证证据（**当轮快照**；最新结果一律以闸门输出为准，复现：`pnpm typecheck` / `pnpm build` / `pnpm test` / `cd src-tauri && cargo test`）：

```
node --check scripts/app-dev.mjs          ✔ 语法通过
pnpm app:preflight                        ✔ Node 22.22.3 / pi 0.87.1 / cargo 1.98.1 / 端口空闲，exit 0
pnpm build                                ✔ 86 modules，dist 157.71 kB（gzip 59.06 kB）
pnpm typecheck / pnpm app:check           ✔ vue-tsc 无报错
cargo check                               ✔ 无 warning
cargo test --lib -- skills:: capabilities:: tools::   ✔ 全绿（当次 19 passed / 0 failed）
Pi 内核实测                               ✔ get_commands 返回 85 条技能；新装技能经重启 RPC 后可见
反向验证（PATH 里塞一个输出 3 的假 pi）    ✘ 被拦截：版本不匹配并提示正确安装命令

### 第三轮（B 期成果卡片 + 去原生控件）

| 文件 | 变更 |
|---|---|
| `src-tauri/src/artifacts.rs` | 新增：从会话文本抽取项目内路径 → 成果卡片（`artifacts_scan` / `artifacts_read`）。路径安全复用 `fs::resolve`，不另起一套边界判定；NUL 嗅探拦二进制；文本超 512KB 截断并标记 |
| `src-tauri/src/fs.rs` | `resolve` 提升为 `pub`，供 artifacts 复用 |
| `src-tauri/src/lib.rs` | 注册 `artifacts::artifacts_scan` / `artifacts_read` |
| `src/composables/useArtifacts.ts` | 新增：按消息聚合成果、500ms debounce 的自动补扫（流式期间不扫，避免把内核请求打爆）、`readArtifact` 模块级导出 |
| `src/components/chat/ArtifactCard.vue` + `.css` | 新增：按扩展名给图标与类型（html/markdown/json/svg/image/text），显示体积与行数 |
| `src/components/chat/ArtifactPreview.vue` + `.css` | 新增：6 类 kind 的统一预览；HTML/SVG 走 `<iframe srcdoc sandbox="">`，图片走 data URL |
| `src/components/chat/MessageList.vue` | 消息体下方渲染卡片条，保持流式光标位置正确 |
| `src/components/ui/AppSelect.vue` / `AppInput.vue` / `AppTextarea.vue` / `AppCheckbox.vue`（+ 各自 `.css`） | 新增 UI Kit：完全自定义下拉、输入框、多行输入、复选框。**复选框保留原生 `<input type="checkbox">` 在 DOM 中但视觉自绘**，兼顾键盘可访问性与屏幕阅读器 |
| 业务面板 | `RoleSwitcher` / `SkillsPanel` / `SandboxPanel` / `ConnectorsPanel` / `LibraryPanel` / `TerminalPanel` / `ProjectsView` / `ChatView` 全部改用 UI Kit；全仓已无原生 `select/input/textarea/checkbox` 直接出现在业务代码 |
| `SkillsPanel.css` / `LibraryPanel.css` | 由组件内 `<style scoped>` 抽出为独立 CSS 文件 |

两个踩到的真实缺陷（已修）：

1. **中文标点未进路径分隔符** —— 内核常输出「已完成 xxx.md 与 yyy.md 的迁移。」，标点缺失会整句粘连成一个 token，扩展名判定随之失效。`TERMINATORS` 已补 `。，、；：！？（）《》【】`。
2. **未知扩展名无条件当文本放行** —— 伪装成 `.html` 的二进制会直接冲进预览区。改为 `kind != "image"` 一律嗅探前 2048 字节是否含 NUL。

验证证据（**当轮快照**；最新结果一律以闸门输出为准，复现：`pnpm typecheck` / `pnpm build` / `pnpm test` / `cd src-tauri && cargo test`）：

```
pnpm typecheck                            ✔ vue-tsc 无报错
pnpm build                                ✔ 105 modules，dist JS 162.88 kB（gzip 61.04 kB）／CSS 24.93 kB（gzip 4.81 kB）
pnpm app:check（cargo check + vite build） ✔ 无 warning
cargo test --lib -- artifacts::           ✔ 全绿（当次 9 passed / 0 failed）
```

---

## §6 风险与取舍

| 决策 | 取 | 舍 | 风险 |
|---|---|---|---|
| 用 Tauri 而非 Electron 承载 | 体积小、启动快、与 Rust 侧共享类型 | 移动端/部分系统 API 需单独适配 | 与 参考实现 壳层不同，但方法论同源 |
| 内核锁 Pi 单一版本 | 版本不符即失败，杜绝 pi-number 那类静默事故 | 升级需人工同步 `piVersion` | 低 |
| 成果工作区只做纯前端预览 | 不引入重量级 office 运行时 | docx/xlsx 保真有边界 | 需在 UI 明示，避免"能编辑"的误 expectation |
| A 期不重做会话树/token 面板 | 复用 Pi 原生 | 短期 UI 能力弱于 参考实现 | 已在 IMPLEMENTATION-PLAN §Phase 2/7 排队 |

## §7 未验证清单（诚实标注）

1. 本机未装 Nix，沙箱端到端路径未验证（`nix develop` 相关）。
2. 无 provider 凭证，Pi 的真实模型调用与 token/成本数值未验证。
3. A3 文本文件读取与回写已做；Office 预览已接（docx/xlsx 渲染，pptx/pdf 降级提示用「原件」打开，12 MiB 上限），图片预览未做。
4. A5 只写到 `defaultTools`，Tauri 侧 MCP 工具尚未经 extension 桥接入内核，`get_active_tools` 一类真实激活状态未在 UI 回显。
5. `pi-manifest.json` 尚未打进桌面包资源，仅开发态可读（C 期处理）。
