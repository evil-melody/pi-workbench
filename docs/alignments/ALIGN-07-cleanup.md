# WORK参考实现 对齐 07 — 旧二级路由与面板清理

> 目标：把 1:1 还原后**已失去入口**的旧二级页面从路由表中彻底移除，避免"同一份能力两条入口、两套版式"的漂移。

---

## 1. 为什么清理

参考实现 的导航只有 4 级容器（Projects / Skills / Plugins / Library → 各自内嵌 tab）。
本项目在 1:1 还原过程中，把原型的四个二级页面做成了独立的旧路由：

| 旧路由 | 旧面板 | 现在归属 |
|---|---|---|
| `/skills` | `SkillsPanel.vue` | `/capabilities` 的「技能市场」tab |
| `/connectors` | `ConnectorsPanel.vue` | `/capabilities` 的「连接器市场」tab |
| `/sandbox` | `SandboxPanel.vue` | Chat 页右侧边栏「文件 / 终端 / 智能体浏览器」 |
| `/activity` | `ActivityPanel.vue` | **无对应原型页面**，功能未落地 |

这四条路由仍挂在 `createRouter` 的 `routes` 数组里，属于"看不见但会被深链命中"的僵尸入口 —— 深链一旦进入，渲染的是旧版式，与 1:1 还原后的外壳不一致。

---

## 2. 改动文件

### 2.1 `src/router/index.ts`（重写）

- 删除 4 条 `import`（`SkillsPanel` / `ConnectorsPanel` / `SandboxPanel` / `ActivityPanel`）
- 删除 4 条 route 记录（含 `meta.icon`）
- 删除原注释「旧路由保留，避免深链断裂」
- 保留 5 条主干路由：`/chat`、`/projects`、`/library`、`/capabilities`、`/plugins`
- 保留 `LibraryPanel` 作 `/library` 整页（对应 参考实现 的 Library 容器页）

```ts
// 清理后完整路由表
const routes = [
  { path: '/', redirect: '/chat' },
  { path: '/chat',       name: 'chat',        component: ChatView,        meta: { title: '对话', icon: 'chat' } },
  { path: '/projects',   name: 'projects',    component: ProjectsView,    meta: { title: '项目', icon: 'share-network' } },
  { path: '/library',    name: 'library',     component: LibraryPanel,    meta: { title: '资料库', icon: 'book' } },
  { path: '/capabilities',name: 'capabilities',component: CapabilitiesView,meta: { title: '专家 · 技能 · 连接器', icon: 'grid' } },
  { path: '/plugins',    name: 'plugins',     component: PluginsView,     meta: { title: '插件', icon: 'puzzle' } },
]
```

### 2.2 删除的面板文件

```
src/components/panels/SkillsPanel.vue        + SkillsPanel.css
src/components/panels/ConnectorsPanel.vue    + ConnectorsPanel.css
src/components/panels/SandboxPanel.vue       + SandboxPanel.css
src/components/panels/ActivityPanel.vue      （无独立 css）
```

删除前用 graphify 全仓扫过：这 4 个组件**只有 `src/router/index.ts` 一处引用**，无其他视图、无 `router.push({ name: ... })` 深链。删除后 `pnpm typecheck` 零报错，证明无残留引用。

### 2.3 保留的 composable（不删）

以下 4 个 composable 之前只被上述面板消费，现在暂时无消费者，但**保留不动**，原因见 §4：

```
src/composables/useSkills.ts   (30 行)  skillsList / skillsInstall
src/composables/useMcp.ts      (8 行)   mcpConnect / mcpList / mcpCall / mcpDisconnect
src/composables/useTools.ts    (12 行)  toolsList / toolsActivate
src/composables/useSandbox.ts  (97 行)  沙箱启停 + 包管理
```

它们是对 `src-tauri` 后端命令的薄封装，属于**可复用的后端接线层**。现在 `CapabilitiesView` 的技能/连接器 tab 用的是页内自有实现（见 03/04 号文档），两者尚未合并。若直接删掉，后续接线要重新写一遍 IPC 调用。

---

## 3. 后端实现逻辑（Rust 侧不受影响）

本轮**未改动任何 Rust 代码**。被删掉的面板调用的命令在 `src-tauri/src/lib.rs` 的 `generate_handler!` 中仍然注册，链路完整：

| 命令 | 所属模块 | 状态 |
|---|---|---|
| `skills_list` / `skills_install` | `skills.rs` | 保留注册，当前无前端消费 |
| `mcp_connect` / `mcp_list` / `mcp_call` / `mcp_disconnect` | `mcp.rs` | 保留注册，当前无前端消费 |
| `tools_list` / `tools_activate` | `tools.rs` | 保留注册 |
| 沙箱相关命令 | `sandbox.rs` | 保留注册 |

> ⚠️ 风险提示：这部分是「僵尸命令」。下一步把 `CapabilitiesView` 的技能/连接器 tab 与后端真正接通时（见 §4 待办），必须优先复用这些命令，而不是新增一批平行命令。

---

## 4. 与 Pi 的融合改造

清理动作直接影响 Pi 内核的能力注入链路：

- **技能安装（Pi）**：旧 `SkillsPanel` 支持粘贴 SKILL.md 导入 → `skills_install` → `restartKernel`。新 `CapabilitiesView` 的「+ 添加技能」目前是占位按钮，功能尚未打通。**这是本轮唯一的功能回退**，见 §5 待办 #1。
- **工具白名单（Pi）**：旧 `ConnectorsPanel` 的 `toolsActivate` 会把 MCP 工具注入 Pi 的激活白名单。新版把该能力收敛进 `/capabilities` 的连接器 tab，但 UI 交互（勾选注入）尚未实现。
- **`pi.setActiveTools([])` 语义陷阱**（见 03 号文档）：空数组 = 只激活列出的工具，会把 Pi 内置工具全停掉。任何后续接线都必须在前端补一个"默认全选"基线，不能传空数组。

---

## 5. 完成度清单

| # | 项目 | 状态 |
|---|---|---|
| 1 | 路由表收敛到 5 条主干 | ✅ |
| 2 | 4 个旧面板组件 + 3 个 CSS 删除 | ✅ |
| 3 | graphify 全仓引用扫描（无残留） | ✅ |
| 4 | `pnpm typecheck` 零报错 | ✅ |
| 5 | `pnpm build` 通过 | ✅ |
| 6 | 4 个 composable 处置 | ⏳ 保留待接线 |
| 7 | 后端僵尸命令收敛 | ❌ 未做 |
| 8 | `CapabilitiesView` 技能安装打通 Pi | ❌ 未做（占位按钮） |
| 9 | `CapabilitiesView` 连接器注入白名单 UI | ❌ 未做 |
| 10 | `/activity` 对应 参考实现 页面 | ❌ 原型中无此页面，待确认是否要做 |

---

## 6. 验证

```bash
pnpm typecheck     # ✅ vue-tsc --noEmit 无输出
pnpm build         # ✅ 107 modules（清理前 126，减少 19 个模块）
                   #    dist/assets/index-b1XGrLtq.css   49.78 kB
                   #    dist/assets/index-BSLdJoGm.js    186.05 kB
```

模块数从 126 → 107，与删除 4 个面板 + 其子树依赖吻合，无孤儿模块被误打包。

---

## 7. 待办（建议优先级）

1. **P0** — `CapabilitiesView` 的「+ 添加技能」接通 `skills_install`（复用既有 composable/命令，不新增平行链路）。
2. **P0** — 连接器 tab 补「工具注入白名单」勾选 UI，接线 `tools_activate`，注意非空数组基线。
3. **P1** — 把 `useSkills` / `useMcp` / `useTools` / `useSandbox` 接回前端，然后把 4 个 composable 与面板一起删掉，消除僵尸代码。
4. **P1** — 确认 `/activity` 是否有 参考实现 对应页面；若无，整块功能下线。
