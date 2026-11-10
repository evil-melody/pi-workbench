# ALIGN-25：全量页面审计 + 内核原地重启

对应反馈：「全面检查一下当前项目的实现。包括页面优化……一个页面一个功能的验证。包括后续编辑代码的 agent 这块。最后整合 worker。」

审计结论：不需要新增进程。「整合 worker」落到**模式**这一层 —— 用首页/对话页的三档思考预算（快速/标准/深度 → 内核 `set_thinking_level`）区分工作强度，与 Pi 单内核常驻复用配合。pi 常驻 vs 外部方案常驻的资源对比结论同样是**不引入第二个内核**：Pi 按启动签名（cwd + provider + model）复用同一子进程，换项目/换模型才重启。

---

## 一、缺陷清单与修复

| # | 级别 | 缺陷 | 修复 | 落地位置 |
|---|:--:|---|---|---|
| 1 | P0 | 设置页改模型配置不生效（模型是启动参数，写入后没有重启内核） | 新增 `pi_restart` 命令 + `PiState.launch_cwd`，保存后原地重启 | `pi_bridge.rs` / `state.rs` / `SettingsView.vue` |
| 2 | P0 | 设置页「工具激活」写死工具名列表，与后端真实工具集脱节 | `tools_list` 返回 `catalog`（能力清单 `tools.builtin` ∪ 白名单），前端改读它 | `tools.rs` / `useTools.ts` / `SettingsView.vue` |
| 3 | P0 | 选完项目后模式选择器消失（只在 Hero 渲染），无法再切档 | 抽出 `ModeSwitcher` 组件，Hero 与对话页头部共用 | `components/chat/ModeSwitcher.vue` / `ChatHero.vue` / `ChatView.vue` |
| 4 | P1 | 项目删除无入口（后端 `project_remove` 已注册） | 卡片加删除按钮 + 二次确认弹窗 | `ProjectsView.vue` / `ProjectsView.css` |
| 5 | P1 | 插件页「主题」tab 是空态，而应用已有真实主题系统 | 接 `toggleTheme`，即时切换 | `PluginsView.vue` |
| 6 | P1 | 插件页死按钮「筛选」（无 handler）、假市场版本号 `插件市场 v1.66.1` | 删除；同时清掉未使用的 `AppModal` / `Tag` 导入与死 CSS | `PluginsView.vue` / `PluginsView.css` |
| 7 | P1 | `sandbox-env.ts` 注释引用不存在的 `src-tauri/src/sandbox.rs` | 改为如实描述：沙箱只有 extension 接缝 | `extensions/sandbox-env.ts` |
| 8 | P1 | README 描述了不存在的沙箱子系统（`sandbox.rs` / `docs/nix-sandbox.md` / 侧栏面板 / ✅ 状态） | 按真实能力重写架构图、状态表、目录树 | `README.md` |

## 二、内核原地重启（`pi_restart`）

Pi 的 cwd 在进程启动时固定、协议里没有 `set_cwd`，因此「常驻」只能在同签名内成立。模型与工具白名单都是**启动参数 / 启动时读取**，改动必须换进程才生效。

```
pi_start(cwd)  ── 签名 = cwd|provider|model ──> 签名相同且子进程存活 → 复用（空操作）
                                            └─ 否则 stop_child → 重新 spawn
pi_restart()   ── 读 launch_cwd → 清 pending → stop_child → pi_start(同一 cwd)
                └─ 内核未运行时直接返回 false（不凭空在默认目录拉起内核）
```

- `PiState.launch_cwd` 记住上次启动目录，重启原地重建，不丢项目上下文。
- `pi_restart` 返回 `bool`：前端据此提示「已保存，内核已重启生效」或「已保存」。
- `stop_child` 清 `launch_sig`，保证重启路径不会被复用逻辑短路。

## 三、模式可达性

`ModeSwitcher` 是唯一真源：三档标签（快速/标准/深度）在组件内定义一次，Hero 与对话页头部共用，消除原先两处各写一遍选项的重复。

```
快速 → low · 标准 → medium · 深度 → high   （MODE_LEVEL）
low  → 快速 · medium → 标准 · high  → 深度  （LEVEL_MODE，用于头部回显）
```

对话页头部在项目名、专家角色之后追加档位选择器，选完项目进入对话后仍可切换。

## 四、沙箱的真实边界（诚实化）

沙箱当前**只有 Pi extension 接缝**：`sandbox_list` / `sandbox_run` 两个工具把工作区 `.pi/sandboxes/<id>/` 的环境暴露给模型。仓库里没有 Rust 侧沙箱模块，也没有 UI 面板；环境目录为空时工具如实报 0 个环境，`sandbox_run` 在无就绪环境时直接拒绝执行（fail-closed）、不回退宿主 PATH。README 已同步。

## 五、验证

```
pnpm typecheck        No errors found
pnpm vitest run       119 passed（11 files）
cargo check           Finished（0 warning）
cargo test            143 passed
graphify update .     2250 nodes / 4509 edges / 123 communities
```

新增符号已入图：`pi_restart()`（`pi_bridge.rs` L156，calls `stop_child` / `pi_start`）、`ModeSwitcher.vue`（被 `ChatView.vue`、`ChatHero.vue` 导入）。

## 六、遗留（未在本轮范围）

- **PluginsView 收藏 tab**：需要账号体系，保持诚实空态。
- **沙箱 UI**：需要先有 Rust 侧环境调度器（flake 生成 / 内容寻址 env / 重建），属新功能而非修复。
- **技能安装后的「重启内核」按钮**：`CapabilitiesView` 已有提示，但尚未直接调用 `pi_restart`，下一轮可接入。
- **`sandbox_list` / `sandbox_run` 端到端加载**：需人工在桌面 App 内确认（extension 由 jiti 加载）。