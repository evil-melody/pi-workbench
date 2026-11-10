# 首页项目选择器 / 扩展与技能可读 / 项目页修复（本轮）

对齐目标：`外部参考实现` —— 首页版式（`参考实现` 卡片行 + 分类 + 技能 chips）、
扩展市场与技能市场的**实体可读**、项目首页的**信息完整**。
内核仍是 `pi-coding-agent 0.87.1`，外壳仍是 **Tauri 2**（无 Electron）。

本轮起因：4 张截图暴露 4 个「没完善」的硬伤 ——

1. 扩展市场两个扩展都显示「未提供（扩展文件不可读）」；
2. 技能市场 0 技能，只有一行占位文字，没有可执行入口；
3. 「项目」页主区域空白（列表失败被 `catch {}` 静默吞掉）；
4. 首页项目选择器位置靠下，且**只能选已有项目、不能选择目录**。

---

## 一、完成度清单

### 1.1 后端（`src-tauri`）

| # | 能力 | 实现要点 | 状态 |
|---|------|----------|------|
| 1 | 扩展目录持久化 | `extensions_dir()` 指向 `app_config_dir/extensions`，`dev/prod` 一致且可写 | ✅ |
| 2 | 默认扩展同步 | `seed_defaults()` 启动时从「资源目录 / `CARGO_MANIFEST_DIR` / exe 同级」三处候选复制到持久化目录，已存在则不覆盖 | ✅ |
| 3 | 能力清单为准 | `CapabilityManifest::discover()` 仍是唯一真源，只同步它声明的文件名 | ✅ |
| 4 | 清单与磁盘对齐 | `capabilities.json` 的 `sandbox-env.ts` → **`sandbox-env.ts`**（与 `src-tauri/extensions/` 真实文件一致） | ✅ |
| 5 | 打包资源 | `tauri.conf.json` 的 `bundle.resources`：`extensions/* → extensions/` | ✅ |
| 6 | 目录选择权限 | `capabilities/default.json` 补 `dialog:default` + `dialog:allow-open` | ✅ |
| 7 | 计费可配置 | `billing_status(app)` 读 `app_config_dir/billing.json` 覆盖，无文件时回落演示值并打 `demo: true` | ✅ |
| 8 | 命令注册 | `projects_list` / `billing_status` / `projects_templates` / `extensions_*` / `skills_*` 全在 `lib.rs` 的 `invoke_handler` | ✅ |
| 9 | Rust 测试 | `sync_default_file_copies_only_when_missing` 等扩展相关 7 条；`cargo test --lib` **140 passed** | ✅ |
| 10 | 编译零告警 | `cargo check --all-targets` **0 error 0 warning** | ✅ |
| 11 | 扩展校验矩阵 | `pnpm check:extensions` 2 个扩展「默认导出完好 / 工具 2 个 / 命令 1 个」 | ✅ |

### 1.2 前端

| # | 能力 | 位置 | 状态 |
|---|------|------|------|
| 1 | 项目选择器上移 | `ChatHero.vue` 里工作空间卡片从 `.hero-footer`（原在 composer 之后）上移到 `.hero-brand` 之后 | ✅ |
| 2 | 选择目录 | `ChatHero` 增加 `dir-btn` + `chooseDirectory()`，emit `pick-directory` | ✅ |
| 3 | 目录 → 项目 | `ChatView.onPickDirectory()`：`pickDirectory()` → 目录名 → `createProject(name, '', undefined, dir)` → `setActiveProject` | ✅ |
| 4 | 项目页错误显式化 | `ProjectsView.loadError`，替代原先 silently 吞异常的 `catch {}` | ✅ |
| 5 | 技能市场空态 | `CapabilitiesView.market-empty`：图标 + 文案随关键字切换 + 「从链接安装 / 添加技能」+「刷新」 | ✅ |
| 6 | 余额卡片演示标识 | `Sidebar` 未接入真实计费时虚线描边 + `.demo-flag`，`title` 提示配置 `billing.json` | ✅ |
| 7 | Vue 模块声明 | 新增 `src/env.d.ts` 的 `declare module '*.vue'`，消掉 7 个 TS2307 | ✅ |
| 8 | 卡片行语义化 | `.hero-footer` → `.hero-meta`（它还不是页脚），窄屏下 `min-width` 归零防溢出 | ✅ |
| 9 | 目录按钮可见性 | `.dir-btn` 从纯透明改成「描边 + 反色底 + hover 强调色」，视觉上能看出可点 | ✅ |
| 10 | 类型/构建/测试 | `pnpm typecheck` **No errors** / `pnpm build` **157 modules** / `pnpm vitest run` **111 passed** | ✅ |
| 11 | 环境预检 | `pnpm app:preflight` 全绿（Node / pi / cargo / 端口 1420 空闲） | ✅ |

---

## 二、本轮修掉的缺陷

| # | 现象 | 根因 | 修复 |
|---|------|------|------|
| 1 | 两个扩展都「未提供（扩展文件不可读）」 | ① `capabilities.json` 声明 `sandbox-env.ts`，磁盘上是 `sandbox-env.ts` → 找不到源；② `extensions_dir()` 在 dev 下解析到 `exe.parent()/extensions` 即 `target/debug/extensions/`，该目录根本不存在 | 清单文件名对齐 + 目录改到 `app_config_dir` + `seed_defaults` 三候选源同步 |
| 2 | `pnpm typecheck` 7 个 TS2307 | 项目缺 `*.vue` 的模块声明 | 新增 `src/env.d.ts` |
| 3 | 首页不能选择目录 | `ChatHero` 只有 `AppSelect` 选已有项目，没有目录入口 | 加 `pickDirectory` 按钮 + `ChatView` 侧 `createProject` 落库 |
| 4 | 首页项目选择器位置靠下 | `.hero-footer` 在 DOM 中排在 `.hero-composer` 之后 | 整块上移到 `.hero-brand` 之后 |
| 5 | 「项目」页主区域空白 | `refresh()` 的 `catch {}` 把 `projects_list` 的失败吞掉，界面只剩空态 | 新增 `loadError` 显式渲染 |
| 6 | 技能市场 0 技能只有一行字 | 空态只有文案，没有动作 | 换成 dashed 卡片空态 + 安装 / 刷新按钮 |
| 7 | 余额卡片像真数据 | 后端写死 `demo = true` | `billing.json` 可覆盖 + 前端虚线 + 「演示」标记 |

---

## 三、后端实现逻辑

### 3.1 扩展目录解析（三层来源 + 一个落点）

```
capabilities.json (CapabilityManifest::discover)   ← 唯一真源，声明文件名
        │
        ├─ 源候选（找文件）                    目标（复制落点）
        │  ├─ resource_dir()/extensions          app_config_dir()/extensions
        │  ├─ $CARGO_MANIFEST_DIR/extensions     （dev 与 prod 一致，且可写）
        │  └─ current_exe().parent()/extensions
        │
        └─ sync_default_file()：目标已存在 → 直接返回（不覆盖用户改动）
```

`list()` 里原先 `let dir = extensions_dir(app)?;` 在失败时整个列表变空，
现在改成 `match … Err(_) => return Vec::new()`，只降级不炸。

### 3.2 命令链路

| 前端 `invoke` | 后端 | 备注 |
|---|---|---|
| `extensions_list` | `extensions::extensions_list(app)` | 读 `app_config_dir/extensions` |
| `extensions_install_from_url` | `…::extensions_install_from_url` | 同一目录写入 |
| `skills_list` / `skills_install` / `skills_install_from_url` / `skills_uninstall` | `skills::*` | 不变 |
| `projects_list` | `projects::projects_list(state)` | 不变，失败现在会被前端显示 |
| `billing_status` | `projects::billing_status(app)` | 新增 `app: AppHandle` 参数，读 `billing.json` |
| `project_active` / `project_set_active` | `projects::*` | 不变 |

### 3.3 权限清单

`src-tauri/capabilities/default.json`：

```json
"permissions": [
  "core:default",
  "opener:default",
  "opener:allow-open-path",
  "dialog:default",
  "dialog:allow-open"
]
```

`plugin-dialog` 的 `pickDirectory()` 依赖 `dialog:allow-open`，原先缺失会在桌面端静默失败。

---

## 四、与 Pi 的融合改造

| 层次 | 现状 | 下一步（Pi 侧） |
|------|------|-----------------|
| 扩展加载 | `src-tauri/extensions/*.ts` 由 `check:extensions` 静态校验默认导出 | 接 `pi` 的 extension registry，让 `.ts` 扩展在内核进程内注册 tool / command，而非仅外壳可读 |
| 技能 | `skills_list` 只扫本地 `SKILL.md` | 让 `pi` 的 agent loop 直接消费技能目录，`/name` 触发走内核而非前端拼 prompt |
| 项目 = cwd | `createProject(name, '', undefined, dir)` 写库，前端持有 `cwd` | 项目目录直接作为 `pi` 的 `cwd`，项目配置修订作为 system prompt 的版本化来源 |
| 计费 | 演示数据 / `billing.json` | Pi 的 token 计量回流到 `billing_status`，`billing.json` 由内核写入 |
| 首页 | 1:1 复刻 外部参考实现 版式 | 保留版式，会话与技能事务全部下沉到 Pi 的 RPC |

---

## 五、验证记录

```
cargo check --all-targets   → Finished `dev` profile, 0 error 0 warning
cargo test --lib            → 140 passed (1 suite)
pnpm typecheck              → TypeScript: No errors found
pnpm build                  → ✓ 157 modules transformed (CSS 110.67 kB / JS 280.12 kB)
pnpm vitest run             → Test Files 11 passed (11) / Tests 111 passed (111)
pnpm check:matrix           → [check:extensions] 2 个扩展通过
pnpm app:preflight          → Node 22.22.2 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲
```

**未覆盖**：本轮无 GUI 截图（截图源已不在工作区），扩展目录选择与首页目录选择需在
`pnpm app:dev` 中人工点验一次；`app_config_dir` 的实际路径见运行日志。
