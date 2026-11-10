# 参考实现 版式对齐总表

> 本表把 参考实现 仓库中所有客户端页面/面板与当前 Pi Workbench 项目一一映射，用于逐页追踪完成度与后端依赖。
>
> 来源仓库：`https://github.com/外部参考实现`，路径前缀 ``。

## 1. 全局外壳（Shell）

| 参考实现 组件 | 源码位置 | 本地对应 | 版式状态 | 功能状态 | 备注 |
|---|---|---|---|---|---|
| 品牌区 + 折叠按钮 | `packages/bundle/src/client/components/Brand.tsx` | `src/components/layout/Sidebar.vue` | ✅ 已对齐 | ✅ 已可用 | 品牌文字保留 Pi |
| 导航位置 / 主导航 | `packages/bundle/src/client/components/NavigationLocation.tsx` | `src/components/layout/Sidebar.vue` | ✅ 已对齐 | ✅ 已可用 | 4 项一级导航 |
| 工作区项目列表 | `packages/plugins/projects/src/client/ProjectsPanel.tsx`（侧边栏分支） | `src/components/layout/Sidebar.vue` | ✅ 已对齐 | ✅ 已可用 | 含相对时间 |
| 左下角余额 | 截图可见，源码在 `外部侧栏组件包` npm 包 | `src/components/layout/Sidebar.vue` | ✅ 已对齐 | ⚠️ 演示数据 | `billing_status` 返回写死值，已加「演示」角标，见 14 号 |
| 外观注入 | `packages/bundle/src/client/components/ShellAppearance.tsx` | `src/styles/base.css` | ✅ 已对齐 | ✅ 已可用 | design tokens |
| 社区市场入口 | `packages/bundle/src/client/components/CommunityMarket.tsx` | `src/views/PluginsView.vue` | ✅ 已对齐 | ✅ 已可用 | 静态 mock 已移除，改为真实扩展清单 + 从直链安装，见 15 号 |
| 右侧边栏（智能体浏览器） | `packages/bundle/src/client/components/AgentBrowserPage.tsx` | `src/views/ChatView.vue` 右侧 tab | ✅ 已对齐 | ✅ 已可用 | 「智能体浏览器」与文件/终端并列，见 06 号 |
| 诊断面板 | `packages/bundle/src/client/components/DiagnosticsPanel.tsx` | 无 | ❌ 未实现 | ❌ 未实现 | 可选 |

## 2. 一级页面（主导航）

| 路由 | 参考实现 页面 | 源码位置 | 本地对应 | 版式状态 | 功能状态 | 后端依赖 |
|---|---|---|---|---|---|---|
| `/plugins` | 发现社区插件 | `packages/plugins/skills/src/client/SkillHubPanel.tsx` + `packages/bundle/src/client/components/CommunityMarket.tsx` | `src/views/PluginsView.vue` | ✅ 已对齐 | ✅ 真实清单 + 直链安装 | `extensions_list` / `extensions_install_from_url`，见 15 号 |
| `/projects` | 项目主页 | `packages/plugins/projects/src/client/ProjectsPanel.tsx` | `src/views/ProjectsView.vue` | ✅ 已对齐 | ✅ 已可用 | `projects_list/add/remove/archive/unarchive/set_active/active` |
| `/capabilities` | 技能市场 / 专家市场 / 连接器市场 | `packages/plugins/experts/src/client/ExpertsPanel.tsx` + `packages/plugins/skills/src/client/SkillHubPanel.tsx` + `packages/plugins/connectors/src/client/ConnectorsPanel.tsx` | `src/views/CapabilitiesView.vue` | ✅ 已对齐 | ✅ 技能安装 + 连接器工具白名单已接线，见 11 号 | `role_list` / `skills_list` / `skills_install` / `mcp_list` / `tools_list` / `tools_activate` |
| `/library` | 资料库 | `packages/plugins/library/src/client/LibraryPanel.tsx` | `src/components/panels/LibraryPanel.vue` | ✅ 已对齐 | ✅ 已可用 | `fs_read_dir` / `fs_read_file` |
| `/chat` | 会话页 | `packages/plugins/workbench/src/client/components/BusinessPanel.tsx` + `packages/plugins/activity/src/projection.ts` + 会话树/消息列表 | `src/views/ChatView.vue` + `src/components/chat/*` | ✅ 已对齐（含 Hero 空态，见 10 号） | ⚠️ 轨迹/工作流为降级投影，见 09 号 | `pi_start/call/send/stop` + artifact 相关；活动依赖 `turn/start` 等 6 类事件 |

## 3. 旧二级页面（已清理）

> 状态更新于 07 号文档：四条路由连同 4 个面板组件 + 3 个 CSS 已从仓库删除，`CapabilitiesView` 与 Chat 右侧边栏承接了全部能力。

| 路由 | 原组件 | 版式状态 | 功能承接 | 当前状态 |
|---|---|---|---|---|
| `/skills` | `SkillsPanel.vue` | ❌ 旧版 | `/capabilities` 的「技能市场」tab | 🗑 已删除，tab 仍为占位按钮 |
| `/connectors` | `ConnectorsPanel.vue` | ❌ 旧版 | `/capabilities` 的「连接器市场」tab | 🗑 已删除，注入白名单 UI 待补 |
| `/sandbox` | `SandboxPanel.vue` | ❌ 旧版 | Chat 右侧「文件 / 终端 / 智能体浏览器」 | 🗑 已删除 |
| `/activity` | `ActivityPanel.vue` | ❌ 旧版 | 无对应原型页面 | 🗑 已删除，功能下线 |

保留的后端接线层（当前无前端消费者，待接线后可一并删除）：
`src/composables/useSkills.ts`、`useMcp.ts`、`useTools.ts`、`useSandbox.ts`。

## 4. 尚未实现的 参考实现 页面

| 参考实现 页面 | 源码位置 | 说明 |
|---|---|---|
| 专家详情 / 编辑器 / 草稿 | `packages/plugins/experts/src/client/ExpertDetailModal.tsx` 等 | 当前只列卡片，未做详情编辑 |
| 连接器详情 / picker | `packages/plugins/connectors/src/client/ConnectorsPanel.tsx` `ConnectorPicker.tsx` | 当前只列 MCP 服务 |
| Library 引用 / 选择 chips | `packages/plugins/library/src/client/LibraryReferencePage.tsx` 等 | 当前只有文件列表 |
| 浏览器会话面板 | `packages/providers/browser-session/src/client/BrowserBrowserSessionPane.tsx` | 右侧浏览器面板 |
| 成果物工作区 / Office 预览编辑 | `外部参考实现-web` deliverable workspace | LibraryPanel 可预览文本/HTML/docx/xlsx；pptx/pdf 降级提示用「原件」打开（12 MiB 上限） |
| 第三方 插件市场 catalog | `packages/plugins/market` | 当前提供「从链接安装」直链兜底，真正的 catalog API 待接入 |
| Workbench 业务面板 / 任务执行通知 | `packages/plugins/workbench/src/client/components/BusinessPanel.tsx` `TaskExecutionNotice.tsx` | 会话页右侧或浮层 |

## 5. 当前整体完成度（2026-09-27 更新）

| 范围 | 完成 | 明细 |
|---|---|---|
| 全局外壳 | ✅ 7/8 | 品牌区、4 项一级导航、项目列表、余额卡、外观、社区市场入口、右侧边栏；仅诊断面板未做 |
| 一级页面 | ✅ 5/5 | `/chat` `/projects` `/library` `/capabilities` `/plugins` 全部版式对齐 |
| 旧二级路由 | ✅ 4/4 | 已清理，无僵尸入口 |
| 会话页子面板 | ✅ 6/6 | 左栏 4 tab + 中栏活动条 + 右栏 3 面板；工作流改为解析真实任务清单，轨迹为真实事件，见 14 号 |
| 事件管线 | ✅ 已打通 | 桥侧合成 `tool_call` / `tool_result` + `pi_ts`/`pi_seq` 元信息，消费端零改协议，见 13 号 |
| 智能体浏览器 | ✅ 事件侧打通 | viewport 消费真实 `pi://event`（与轨迹面板共享单订阅）；「前往」已接 `browser_open` 真实开系统浏览器，返回回退访问记录，见 14 号 |
| `/chat` 空态 Hero | ✅ 已美化 | 分段控制器 + 带图标的技能胶囊 + cardlet 底部工作空间 + 光晕动画，见 10 号 |
| 应用图标 | ✅ 已生成 | `src-tauri/icons/` 全套 icns / ico / Android / iOS / UWP，见 10 号 |
| 能力中心 | ✅ 已接线 | 技能安装 + 连接器工具白名单已接通后端，见 11 号 |
| 后端能力 | ✅ 已补流水线 | 项目/扩展/技能/连接器/RPC 桥命令齐备 + 桥侧事件增强；余额与市场仍为静态占位 |
| 全模块半成品清理 | ✅ 已过一遍 | 12 处假开关 / 空壳按钮 / 假数据 / 僵尸代码全部处理完，见 14 号 |
| 验证 | ✅ 全绿 | typecheck / build / test(66) / check:matrix / cargo test(66, 0 warning) / app:preflight 全通过 |

## 6. 下一步建议顺序（剩余）

1. **P1** SkillHub 远端市场 API（内核或自建市场服务提供接口）
2. **P1** 社区市场安装链路（远端下载 + 落盘 + 注册）
3. **P1** Rust 侧 `sandbox.rs`（5 个命令 + `SandboxState`）已无前端消费者，确认不再需要后整体下线
4. **P1** `billing_status` 替换为真实计费接口后的数据接入
5. **P2** 诊断面板（可选，原型无强对应页面）
6. **P2** 消除 pnpm 版本告警（`corepack prepare pnpm@12.6.0 --activate`）
