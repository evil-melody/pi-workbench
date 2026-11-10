# 页面功能点审计（每页 · 每个功能 · 是否可运行）

> 审计对象：`/Users/tatsuma/Documents/GIT/pi-workbench`（Tauri 2 + Vite + Vue 3 + Pi 0.87.1）
> 审计日期：2026-09-29（第九轮：头部上下文 pill 去折行、底部状态栏收进 composer 并加转圈；第八轮：对话页版式回归「一栏对话 + 过程抽屉」，选完项目仍停在落地页；文件/终端/浏览器迁到项目详情页；「新会话」真正重置。此前依次为 菜单渲染崩溃根因 → 换目录卡死根因/工作目录合并 → 品牌资产统一 → 首页输入/目录/模型/实时用量 → 去外部命名 + 模型连通性根因 + 逐页问题清单）
> 审计口径：静态代码 + `vue-tsc --noEmit`（类型） + `vite build`（构建） + `cargo check`/`cargo test`（Rust） + `vitest`（单测） + `visual-check.mjs`（真实渲染）。
> **GUI 点检**（真实鼠标点击）无法在此无头环境执行，需在 `pnpm tauri dev` 中人工复核——见 §10「验证分级」。

**状态图例**
- ✅ 代码/类型/构建/命令注册均通过，逻辑闭环清晰
- ⚠️ 仅 Tauri 运行时可用（浏览器预览已加横幅，写操作不落盘）
- ❓ 依赖内核 / 外部进程，需 `pnpm tauri dev` 人工点检

---

## §0 问题总表（先给结论）

### 0.0 本仓是一个独立项目：命名已与任何外部平台解耦

Rust 模块与命令、Pi extension 文件名、前端 composable、样式表与类前缀、路由、文档文件名
**已全部改为本项目自有命名**，零残留校验命令见 [AGENT-OPS.md §5.3](./AGENT-OPS.md)。
`pi-manifest.json`、`pi_bridge.rs` 兜底清单、`visual-check.mjs` 路由断言、`README.md` 已同步。

取舍原则（取最优、去劣势）见 [AGENT-OPS.md §8 取舍表](./AGENT-OPS.md)。**本仓不依赖任何外部仓库，也不搬运其代码。**

### 0.1 已修复（本轮 + 前两轮）

| # | 级别 | 问题 | 根因 | 状态 |
|---|---|---|---|---|
| 1 | **P0 阻断** | 设置页「测试连接」永远失败：`无法连接到 openai 服务端: error sending request for url (https://…)` | `Cargo.toml` 里 `reqwest` 用 `default-features = false, features = ["json"]`，连带关掉了 TLS → `Cargo.lock` 中 TLS crate 数为 **0**，本仓**所有** https 请求都不可能完成 | ✅ 已修（见 §0.5） |
| 2 | **P0 视觉** | 「刷新」「+ 添加技能」被压成 30px 方块、文字竖排 | `agent-ops.css` 以全局方式定义通用类名 `.tool-btn{width:30px;height:30px}`，接管了能力中心/资料库同名按钮 | ✅ 已修（见 §0.3b） |
| 3 | P1 | 浏览器预览下界面直接暴露 `Cannot read properties of undefined (reading 'invoke')` | 非 Tauri 运行时 `invoke` 静默 reject，视图 catch 后原样显示 | ✅ 已修（见 §0.3c） |
| 4 | P1 | 思考深度下拉选项被压成竖排（截图里的「快 / 速」） | `AppSelect` 菜单 `left:0;right:0` 被钳成触发器宽度 | ✅ 已修（见 §0.2） |
| 5 | P1 | 能力被「单开分组」放在左侧，不是融合 | 上一轮把四类能力做成独立导航分组 | ✅ 已修（见 §0.1） |
| 6 | P2 | 内嵌视图双层 padding + 两个同名标题 | 视图自带页面级容器，内嵌后叠加 | ✅ 已修（见 §0.4） |
| 7 | P2 | 团队对话框里原生 `<input>/<select>` 无样式 | 未走 UI Kit | ✅ 已修（见 §0.4） |
| 8 | P2 | 目录选择器「正在选择…」从不显示 | `open()` 在父级、`emit` 同步返回 | ✅ 已修（见 §0.3） |
| 9 | **P0 阻断** | 首页输入框**打不进字**：没有活动项目时整块锁死，placeholder 写着「请先在项目页选择」 | `ChatHero` 的 `AppTextarea` 带 `:disabled="!cwd"` | ✅ 已修（见 §0″） |
| 10 | **P1 功能缺失** | 首页**没有模型选择器**，用户不知道当前用哪个模型、也无从切换 | 模型只在设置页可配，Hero/头部都没有入口 | ✅ 已修（见 §0″） |
| 11 | **P1 撒谎 UI** | 左下角余额/今日是硬编码演示值（¥96.28 / ¥2.4201），与真实用量无关 | `billing_status` 无 `billing.json` 时返回占位值，前端照显 | ✅ 已修（见 §0″） |
| 12 | P1 | 设置页 `inputMap[m.id].temperature` 缺条目即整页失活 | 模板直接取属性 | ✅ 已修（`v-if="inputMap[m.id]"` 兜底） |
| 13 | P2 | 首页目录入口只是 28px 图标按钮，没有文字，看不出是干什么的 | 与「选择工作空间」下拉语义重叠 | ✅ 已修（见 §0″） |
| 14 | **P1 视觉** | 首页「难看」：分类用绿/蓝/橙三色胶囊，与全局单一强调色打架；吉祥物是 192px 低清图挤在技能行右侧；标题整段被裁掉 | 详见 §0‴ | ✅ 已修（见 §0‴） |
| 15 | **P1 品牌** | Dock/桌面图标还是旧的蓝色方块字母标；界面品牌标记同为手绘 SVG，与吉祥物两套观感 | 图标从未随品牌更新 | ✅ 已修（见 §0‴ + [BRAND.md](./BRAND.md)） |
| 16 | **P0 静默** | 首页吉祥物带着白底方块，透明底失效 | 模板静态 `src="/mascot.png"` 被当项目根路径解析，根目录遗留的同名不透明原图**静默覆盖**了 `public/` 里那张 | ✅ 已修（见 §0‴） |
| 17 | **P0 卡死** | 「换一下目录 直接卡死」：点完目录选择后整个窗口点不动 | Tauri 的**非 async 命令跑在主线程**，而 `pi_call` 在内核无响应时 `recv_timeout` **最长阻塞 120 秒**；换目录 → `watch(cwd)` → `set_thinking_level` 正好命中这条路径 | ✅ 已修（见 §0⁗） |
| 18 | P1 冗余 | 模型名后面又打印一遍 `openai · agnes-2.0-flash` | `ModelSwitcher` 触发器已显示模型名，仍渲染 `provider · model` 提示 | ✅ 已修（见 §0⁗） |
| 19 | P1 冗余 | 输入框左侧第一个「+」按钮点了没反应 | 附件入口只有提示态，未接资产域 | ✅ 已修：**直接移除**（不留假入口） |
| 20 | P1 重复入口 | 「产品需求全流程」下拉 + 独立「换目录」按钮语义重叠，操作条被撑成两行 | 项目本质上就是「目录 + 名字」，做成两个控件 | ✅ 已修（见 §0⁗） |
| 21 | **P0 功能失效** | 「下面那个换项目换不了，点了没反应」：触发器点下去菜单不出现（Chrome 实测 `menus=0`） | 菜单渲染里 `shortPath(p.path)` 对 **`path = null`** 的项目直接 `.replace()` 抛 `TypeError`；Vue 把渲染异常吞进 `console.error`，界面表现为「什么都没发生」 | ✅ 已修（见 §0⁷） |
| 22 | **P0 静默** | 点没有工作目录的项目（模板建的）**永远不会切换**，也没有任何提示 | 即使渲染不崩，`cwd` 被赋成 `null` 仍是假值 → 首页 Hero 继续显示；`pickProject` 里 `p.path === cwd`（`null === ''` 为假）判断也不覆盖这条路径 | ✅ 已修（见 §0⁷） |
| 23 | P1 视觉 | 「中间点击有个虚线」：点输入框中间会套出一个圆角细框 | `AppTextarea` 自带的 `.app-textarea:focus{box-shadow:0 0 0 2px …}` 没被 Hero 的上层规则压掉（上层只写了 `outline:none`，管不到 `box-shadow`） | ✅ 已修（见 §0⁷） |
| 24 | P1 同步 | 侧栏点了项目、对话页仍停在旧目录（`/chat` 已挂载时 `router.push('/chat')` 不会重新挂载） | 侧栏与对话页各存一份活动项目状态 | ✅ 已修：活动项目收口到 `useProject` 共享 ref + 对话页 watcher（见 §0⁷） |

### 0.2 仍未修复 / 已知边界（诚实清单）

| # | 类型 | 问题 | 说明 / 建议 |
|---|---|---|---|
| A | 待验证 | TLS 修复的端到端回归 | 结构证据 (见 §0.5) + 独立 https 冒烟已通过；**真实模型端点**需在 `pnpm tauri dev` 内点「测试连接」确认 |
| B | 设计缺陷 | `settings_test_model` 只做 `GET <base_url>` 可达性探测，且 404/401 也算「连接正常」 | 表述已改为「网络可达（仅探测 Base URL，未校验 API Key 与模型名）」；真实探测仍未做 |
| E | 已知边界 | 技能安装后需重启内核才被枚举 | Pi 启动时才扫描技能目录 |
| F | 已知边界 | 记忆召回是关键词/全文匹配，非语义向量 | 语义 RAG 在后续阶段 |
| G | 未实现 | 插件页无真实 catalog 服务端 | 现为直链安装兜底 |
| H | 依赖本机 | 团队调度依赖本机 `pi` 子进程；无 pi 时返回调度计划 | 不报错，属预期降级 |
| I | 依赖本机 | 浏览器无头截图依赖本机 chromium | 无则如实报能力不可用 |
| J | 未接 | MCP server 工具无法注入 Pi 进程（仍在 Tauri 侧） | 需要 Tauri→Pi 的 extension 桥接 |
| K | 设计取舍 | 切换模型会**重启内核**（Pi 只在 spawn 时读 provider/model） | 已在选择器 title 里写明；会话内切换模型必然中断当前上下文，属内核约束 |
| L | 待验证 | 首页「先选目录再发送」的自动补发 | 逻辑在 `ChatView.watch(cwd)` 内，需真机验证一次（取消选择 → 草稿保留） |
| M | 待验证 | 打包后 Dock/桌面/任务栏实际显示的新图标 | 图标文件已按规范重出（1024 带 alpha + icns + ico，断言已覆盖文件层）；**系统缓存**会让旧图标残留，需 `pnpm tauri build` 后确认，必要时清理图标缓存 |
| N | 未覆盖 | iOS 图标目录 | 仓库内不存在 `src-tauri/icons/ios/`，说明未启用 iOS 目标；脚本只更新已存在的目录，不凭空造移动端工程 |
| O | 待真机 | 「换目录」的完整链路：选中新目录 → 登记项目 → 内核重启到新目录 | 阻断性的**主线程冻结**已在代码层消除（§0⁗），但原生目录选择器只存在于 Tauri 运行时，浏览器预览覆盖不到 |
| P | 未覆盖 | 对话头部的工作目录控件 | 头部只在「已绑定目录」时出现；§9 全流程断言已用打桩 IPC 真实渲染到头部控件（切项目/绑定后都能看到） |
| Q | 设计取舍 | 激活一个「没有工作目录的项目」会**主动弹出**原生目录选择器 | 这是把原本的「静默无反应」换成「立刻给出下一步」；若用户取消，界面保留首页并给出提示，不会留下半截状态 |
| R | 待真机 | §9 全流程断言用的是**打桩 IPC**，证明的是「前端编排正确」 | 真实内核启动（`pi_start` → 内核在新 cwd 下就位）仍需 `pnpm tauri dev` 点一次；打桩覆盖不到原生对话框与内核进程 |
| S | 已知边界 | 项目一旦没有目录就不能作为工作目录启动对话 | 属产品约束（`cwd` 必须真实存在）；现在会在激活时引导补绑，而不是让用户猜 |
| Q | 已知边界 | 原生目录选择器若被系统吞掉（不返回也不报错），用户最长等 2 分钟才看到复位提示 | 已提供两个出口：超时自动复位 + 菜单内「取消」；根治需更底层的对话框替换，收益不抵成本 |

---

## §0⁗ 第六轮修复的根因细节（卡死 + 操作条合并）

### 0⁗.1 「换一下目录 直接卡死」（P0）：阻塞式 RPC 跑在主线程

**现象**：点「换目录 / 选择目录」后整个窗口点不动，输入框、按钮、原生弹窗全部无响应。

**根因**（Tauri 官方文档 *Calling Rust from the Frontend → Async Commands*）：

> Commands without the *async* keyword are executed on the **main thread** unless defined with `#[tauri::command(async)]`.

本仓的 `pi_call` 恰恰是**非 async** 的，函数体里却是：

```rust
match rx.recv_timeout(timeout) {            // DEFAULT_TIMEOUT = Duration::from_secs(120)
```

也就是说，只要内核没有回这条 RPC，**主线程就被按住最长 120 秒**——窗口渲染、事件派发、原生对话框全部停摆。命中路径是：

```
选择目录 → project_add → project_set_active → cwd 变化
        → watch(cwd) → pi_start → applyThinking() → rpc('set_thinking_level')
        → pi_call（主线程 recv_timeout，最长 120s）
```

同一类问题还有两处：`skills_list`（内部 `get_commands` 阻塞 10s）、`mcp_call`（`tools/call` 阻塞 20s）。

**修复**：

| 位置 | 改法 | 理由 |
|---|---|---|
| `pi_bridge.rs::pi_call` | `#[tauri::command(async)]` | 挪出主线程，内核不回应也不再冻结界面 |
| `pi_bridge.rs` `DEFAULT_TIMEOUT` | `120s → 30s` | 走这条通道的全是控制面 RPC（`get_tree`/`fork`/`set_thinking_level`），agent 轮次走 `pi_send` 的流式通道，不需要 2 分钟余量 |
| `mcp.rs::mcp_call` | `#[tauri::command(async)]` | 内部 20s 阻塞等待子进程 |
| `skills.rs::skills_list` | `#[tauri::command(async)]` | 内部 10s 阻塞等待内核 |

**回归守卫**（`pi_bridge.rs` 单测 `blocking_commands_must_be_declared_async`）：源码级扫描，`pi_call`/`mcp_call`/`skills_list` 若不是 `#[tauri::command(async)]` 就测试失败。新增阻塞式命令时把它加进 `WATCHED` 即可——这类 bug 静态类型检查永远抓不到。

**另一层兜底**（`useDirPicker.ts`）：`pickDirectoryGuarded()` 给目录选择加了**超时复位 + 代际丢弃**，两处入口（工作目录选择器、首页「先选目录再发送」）共用：

- 超时（120s）→ 复位并提示，绝不把界面永久留在「正在选择…」；
- 菜单里提供**取消**出口，取消后迟到的结果由代际计数丢弃，不会把用户已改的状态又覆盖一次。

`tests/dirPicker.spec.ts` 覆盖这 5 种情形；已按 TDD 做过 RED 验证：把 `Promise.race` 与代际判断去掉后，2 条用例立刻失败。

### 0⁗.2 首页操作条瘦身与「项目 / 目录」合并

| 现象 | 处理 |
|---|---|
| 模型名后面又显示 `openai · agnes-2.0-flash` | 触发器已经写明模型名，旁边再打印一遍是纯噪音 → 移除 inline 提示，明细留在下拉项 |
| 最左边的「+」点了没反应 | 附件入口只有提示态、未接资产域 → **直接删掉**（宁可少一个按钮，不留假入口） |
| 「产品需求全流程」下拉 + 独立「换目录」按钮 | 语义重叠（项目 = 目录 + 名字），合成单一控件 `WorkspacePicker.vue`：触发器显示当前项目名 / 末段路径，菜单里列项目 + 「选择本地目录…」，并带等待态与取消出口 |
| 操作条被撑成两行 | 合并后左组只余「工作目录 · 模型 · 权限」三项，右侧「思考深度 · 发送」独立贴右 |

`WorkspacePicker` 菜单用 `Teleport` 挂到 `body` + `position: fixed` 定位（向上/向下自适应）：首页 Hero 是 `overflow-y:auto` 的滚动容器，留在原地会被裁掉——与 `AppSelect` 曾经踩的坑同源。首页与对话头部**共用同一个组件**，头部不再并排显示「项目名」和「目录 chip」两段文本。

### 0⁗.3 本轮验证证据

```
cargo check          通过（当轮快照）
cargo test           144 passed（当轮快照；新增 1 条：阻塞式命令必须声明 async）
vue-tsc --noEmit     通过（当轮快照）
vite build           通过（当轮快照）
vitest               130 passed / 13 files（当轮快照；新增 tests/dirPicker.spec.ts 5 例，已做 RED 验证）
visual-check.mjs     30/30 PASS（当轮快照；新增 9 条：目录入口唯一、旧按钮下线、菜单真展开/可收起、
                                  **菜单位于视口内且水平对齐触发器**、模型不再重复显示 provider、
                                  附件按钮已移除）
```

> 本块为第七轮修复当时的**历史快照**，通过数会随后续轮次变化；
> **当前一律以闸门实跑输出为准**，复现命令：
> `pnpm typecheck` · `pnpm build` · `pnpm test` · `node scripts/visual-check.mjs` · `cd src-tauri && cargo check && cargo test`

**顺带修掉一个「断言全绿但用户什么都看不到」的坑**：`WorkspacePicker` 的菜单第一次实现时忘了算坐标——
`position: fixed` 且无偏移会按静态位置落在**页面末尾**（视口外），而 Playwright 的 `isVisible()`
只检查有没有非空尺寸、**不检查是否在屏内**，于是断言全过、用户看不到任何菜单。
现在断言补上了几何检查（y 在视口内 + x 对齐触发器）。教训：下拉/浮层类的断言必须落到 `boundingBox()`。

---

## §0⁸ 第八轮：对话页从「四栏工作台」回到「一栏对话 + 过程抽屉」

用户原话：
> 选了项目进来后。天。这样式全部都是些啥。选择了项目。应该还停留在原来的界面吧。然后才是跟当前 workbuddy 一样的流程吧。就多了一些流程轨迹这些吧。这个页面应该是单独的详细进项目页吧。

### 0⁸.1 根因：落地页判据里塞进了「工作目录」

```ts
// 旧
const showHero = computed(() => !cwd.value && messages.value.length === 0 && !streaming.value)
```

`cwd` 一旦就位（选完项目/目录），落地页当场卸载，用户被扔进一个**还没有任何消息的会话流**：
左边文件树、右边浏览器/终端、外加一条被挤窄的空对话——四栏同时压上来，中间只剩一条缝，
顶部的上下文 pill 因为宽度不够被折成两行。这就是截图里的「全是些啥」。

判据与工作目录本来无关，现在收口成一个函数（`src/composables/chatStage.ts`）：

```ts
export function shouldShowHero(messageCount: number, streaming: boolean): boolean {
  return messageCount === 0 && !streaming
}
```

`cwd` 不再进判据 —— **选了项目仍然停在落地页**，按下回车、消息进列表之后才切到会话流。

### 0⁸.2 版式：文件 / 终端 / 浏览器搬去项目详情页

| 面 | 旧位置 | 新位置 |
|---|---|---|
| 文件树 + 文件编辑 | 对话页左/右栏（常驻） | 项目详情页 `文件` tab（`FilesWorkspace`） |
| 终端 | 对话页右栏（常驻） | 项目详情页 `终端` tab |
| 智能体浏览器 | 对话页右栏（常驻） | 项目详情页 `浏览器` tab |
| 会话树 / 轨迹 / 工作流 / 连接器 | 对话页左栏（常驻） | 对话页 `轨迹` 按钮 → **过程抽屉**（默认收起） |

- 文件编辑逻辑抽成 `components/fs/FileEditorPane.vue`（对话页与项目页原先只能二选一，现在同一份实现两处复用）。
- 抽屉收起时**连内容都不挂载**：`SessionTree` 会轮询，关着还挂等于白烧 IPC。
- 项目行的「工作台」入口（侧栏项目行右侧图标）是新加的路：想用工具就得有一条明确的路过去。

### 0⁸.3 「新会话」点了没反应

消息与流式状态都活在 `ChatView` 实例里（`usePi()` 每次调用都是新的一份），而
`router.push('/chat')` 在**已经位于 `/chat`** 时不会重新挂载 —— 点了等于没点。
现在把轮次挂到路由视图的 key 上（`App.vue`）：`chat-${chatEpoch}`，`startNewSession()` 加一即重挂载。
RED 验证：去掉 key 后浏览器断言 `0 → 0`（落地页没回来），恢复后 `0 → 1`。

### 0⁸.4 本轮验证证据

```
vue-tsc --noEmit     通过
vite build           通过
vitest               144 passed / 15 files（新增 tests/chatStage.spec.ts 10 例；Hero 判据、常驻三栏下线、
                     抽屉接管过程面板、文件编辑面板抽取、新会话 key —— 均做过 RED 验证）
visual-check.mjs     53/53 PASS（新增 12 条：绑定后仍在落地页、两侧无侧栏、发首条后进会话流、
                     抽屉默认收起/展开、抽屉四 tab、侧栏工作台入口、项目页三工具面渲染、
                     新会话回到落地页）
graphify update      2440+ nodes
```

---

## §0⁹ 第九轮：头部与底部状态栏样式修正

用户原话：
> 这样式也是乱七八糟。没任何反应。也不知道到哪了。在查没查有没有在运行。这块全面修正。

### 0⁹.1 头部：模型名折到第二行

旧 `.header-pill` 用了 `flex-wrap: wrap`：窗口稍窄时，`RoleSwitcher`（180px）+ `ModeSwitcher`（72px）+ `ModelSwitcher`（132px）+ `WorkspacePicker` 把 pill 撑满，模型选择器直接掉到第二行，header 变成双行，顶部 pill 与右侧「轨迹」按钮也对不齐。

修：
- `.header-pill` 改为 `flex-wrap: nowrap`。
- 头部三个选择器统一传 `width="auto"`，由 ChatView.css 给 `min/max-width` 并允许内部 `AppSelect` 省略号收缩：
  - 角色：72–180px
  - 思考深度：56–90px
  - 模型：72–180px（长模型名截断，完整名保留在 title/下拉项）

### 0⁹.2 底部：浮在输入框上的大状态卡片

旧布局在 `MessageList` 与 `composer` 之间插了一个 `.activity-dock`，里面浮着 44px 高的 `ActivityBar` 卡片（带人脸图标、 eyebrow、phase badge、中断按钮、详情折叠），与输入框之间出现双层底部，用户不知道到底「正在运行」的是上面的卡片还是下面的输入框。

修：
- 删除 `ActivityBar.vue` / `ActivityBar.css`（仅 ChatView 使用，已成死代码）。
- 新增 `ComposerStatus.vue`：运行态只显示「转圈 + 中文状态 + 中断按钮」；空闲态显示快捷键提示 + 用量 chip。
- 状态行收进 `.composer` 内部、`.input-wrap` 上方，与输入框形成**一个整体**。
- 运行态的转圈动画让「有没有在跑」一眼可见。

### 0⁹.3 本轮验证证据

```
vue-tsc --noEmit     通过
vite build           通过
vitest               144 passed / 15 files
visual-check.mjs     57/57 PASS（新增 4 条：header pill 不折行、header 单行高度、
                                 旧 activity-dock 下线、composer 内置状态行存在）
```

---

## §0⁷ 第七轮修复的根因细节（菜单渲染崩溃 + 内层焦点环 + 项目切换同步）

### 0⁷.1 「换项目点了没反应」的真正原因：一行 `.replace()` 把整个菜单的渲染炸了（P0）

用户截图上的两个红框对应两个独立缺陷，**都发生在同一句「点下去要有反应」上**。

先复刻本机真实数据（`~/Library/Application Support/com.piworkbench.app/projects.json`）：

```json
{"id":"p18d9685bab9028b81","name":"产品需求全流程","path":null,"archived":false}
{"id":"p18d9b66fa599b9581","name":"pi-workbench","path":"/Users/tatsuma/Documents/GIT/pi-workbench"}
```

**成因 A（渲染崩溃）**：菜单对每个项目渲染 `{{ shortPath(p.path) }}`，而

```ts
function shortPath(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/').filter(Boolean)   // ← p 是 null
```

模板建的项目 `path` 是 `null` → `TypeError: Cannot read properties of null (reading 'replace')`。
Vue 捕获渲染异常后**只往 `console.error` 打一行**，DOM 里连 `.ws-menu` 都不会出现 ——
用户看到的正是「点了没反应」。真实浏览器复现（960×600，Tauri 窗口同尺寸）：

```
menu visible=false box=null / menus before/after: 0 → 0
[console] error TypeError: Cannot read properties of null (reading 'replace')
  at Proxy.shortPath src/components/chat/WorkspacePicker.vue:52
  at src/components/chat/WorkspacePicker.vue:208
```

修：`shortPath(p?: string | null)` 走 `(p ?? '')`，`PickerProject.path` 类型改为 `string | null`
（让类型系统把这条路径显式化），菜单里没绑目录的项目显示 **「未绑定目录 · 点此选择文件夹」**。

**成因 B（静默无效）**：即使菜单渲染成功，点一个没有目录的项目也「什么都不会发生」——
`cwd` 被赋成 `null` 仍是假值 → 首页 Hero 不卸载。修：`pickProject` 对无目录项目**就地拉起目录选择器**
（`project_set_path` 落库 → 激活 → `cwd` 落定），新增 `bind-directory` 事件贯通 ChatHero → ChatView。

### 0⁷.2 「中间点击有个虚线」：textarea 自带的 focus 环没被压掉

`.hero-input-wrap :deep(.app-textarea)` 只写了 `outline: none`，**管不到** `AppTextarea` 自己的
`.app-textarea:focus { box-shadow: 0 0 0 2px rgba(110,168,254,.22) }` —— 焦点态细节（specificity 0,3,0）
与上层规则同权，胜负取决于加载顺序。于是点击输入区会在框内套出一个 2px 圆角浅蓝细框（截图里那条「虚线」）。

修（`ChatHero.css`）：显式压掉，焦点反馈全部交给外层容器（边框变色 + 光晕，本就有）：

```css
.hero-input-wrap :deep(.app-textarea:focus),
.hero-input-wrap :deep(.app-textarea:focus-visible) { box-shadow: none; }
```

### 0⁷.3 侧栏切项目不生效：活动项目被存了两份

`/chat` 已经挂载时，侧栏 `router.push('/chat')` 是**同路由跳转、组件不会重新挂载**，
而活动项目 id 存在 `Sidebar` 自己的局部 ref 里 → 侧栏高亮了，对话页仍停在旧目录。

修：活动项目收口到 `useProject` 的共享 ref（`activeProjectId` / `activeProjectPath`）+ `activateProject(id)`；
对话页用 watcher 跟着走，并在「重新挂载但活动项目没变」（ref 不变 → watcher 不触发）时补一次同步。
无目录项目被激活时**不再静默**：立刻拉起目录选择器补绑，用户始终有下一条可走的路。

### 0⁷.4 本轮验证证据

```
vue-tsc --noEmit     通过
vite build           通过
vitest               134 passed / 14 files（新增 tests/workspacePicker.spec.ts 4 例：jsdom 真实挂载
                                 组件 → 菜单渲染不再崩、点无目录项目会拉起选择器并请求绑定、
                                 点已绑项目会切项目、点当前项目不发请求。已做 RED 验证：
                                 修复前 4 例全红，报错与线上完全一致）
visual-check.mjs     41/41 PASS（新增 §9「全流程」11 条，用真实浏览器 + 打桩 Tauri IPC
                                 复刻桌面端 store：无目录项目在菜单里列出并说明缺什么、
                                 点击后真的调用 project_set_path 并激活、绑定后进入对话界面、
                                 头部显示当前项目、侧栏切项目对话页跟着换、
                                 从项目页返回对话页工作目录仍保持、聚焦后 textarea 无内层焦点环、
                                 全程无渲染期崩溃）
```

**顺带修掉两个「自动化自己制造假崩溃」的坑**（否则新断言会被噪声淹掉）：

1. 打桩 IPC 对未覆盖的命令统一返回 `null`，而真实后端返回数组/对象 → 空桩自己造出
   `Cannot read properties of null (reading 'length')`。修：按真实形状打桩（`role_list: []`、`fs_read_dir: []` 等）。
2. `@tauri-apps/api/event` 退订要回调 `window.__TAURI_EVENT_PLUGIN_INTERNALS__.unregisterListener`
   → 离开对话页时抛 `reading 'unregisterListener'`。修：补上该内部对象的空实现。

教训：**只看 `pageerror` 会漏掉一整类缺陷** —— Vue 的渲染异常走 `console.error`，两处都要收。

---

## §0‴ 第五轮修复的根因细节（品牌 + 首页视觉）

### 0‴.1 吉祥物白底方块：模板静态路径静默指错文件（P0）

**现象**：首页吉祥物显示为「带浅灰底方块」的图，透明度失效。

**根因**：`ChatHero.vue` 写的是 `<img src="/mascot.png">`。Vue 的 asset URL 转换会把**绝对路径**交给打包器解析成项目根路径，于是命中了仓库根目录遗留的 `mascot.png`（928×928，**不透明**，1.2MB），`public/mascot.png` 那张透明图**从未被加载**——构建产物里出现的是 `assets/mascot-C5fdhgzF.png`，这个 hash 就是证据。

**修复**：

1. 品牌图改放 `src/assets/mascot.png`，用 `import mascotUrl from '@/assets/mascot.png'` + `:src="mascotUrl"`，由打包器唯一决定用哪张；
2. 删掉仓库根的两个残留（`mascot.png`、`mascot-removebg-preview.png`）与 `public/mascot*.png`，消除同名歧义；
3. `visual-check.mjs` 新增断言：把原图画进 canvas 读左上角像素 alpha，`alpha !== 0` 直接判失败——肉眼在浅色主题下看不出白底。

### 0‴.2 首页「难看」的三个具体成因

| # | 现象 | 根因 | 修复 |
|---|---|---|---|
| 1 | 分类胶囊是绿/蓝/橙三色，与全局蓝色强调色打架 | `categories` 里硬编码了 `tone/gradient/activeBg` 三套色，选中态用各自的主色填充 | 删掉三色配置，选中态统一 `var(--accent)`；断言「分类选中态跟随全局强调色」 |
| 2 | 吉祥物糊、位置怪（挤在技能行右侧） | 用的是 `public/mascot-side.png`（**192px**）却被拉到 110px 显示，且与技能 chip 争同一行 | 换 384px 透明原图，提到标题上方做主视觉，技能行不再放图 |
| 3 | 标题整段看不见 | `.chat-hero` 是 `overflow: hidden`，内容高于窗口时直接裁掉顶部 | 改 `overflow-y: auto` + `margin: auto`：内容矮时居中、高时可滚 |

同时把顺序改成「品牌 → 输入框 → 场景建议」：分类与技能是输入**之后**的加速器，不该挡在输入框前面。工具条把左侧组改成自己换行、右侧组永远贴右（旧版右侧整组掉到第二行左对齐，看着像布局坏了）。

### 0‴.3 图标与品牌标记：一套真源，全部派生

原来 Dock 图标是旧的蓝色方块 + 手绘字母，界面里的品牌标记也是同一套 SVG —— 与吉祥物是两套观感。

现在**只有一张真源**（`assets/brand/mascot-transparent.png`），其余全部由 `scripts/make-icons.py` 派生：macOS `.icns`（16→1024）、Windows `.ico` + Square*Logo、Android mipmap（圆角/圆形/自适应前景）、`favicon.png`、界面内 `src/assets/mascot.png`。圆角按 macOS 规范取边长 22.37%，主体占 74% 高度、底部留 10%。

完整参数、踩坑与回归断言见 [BRAND.md](./BRAND.md)。

### 0‴.4 本轮验证证据

```
vue-tsc --noEmit     通过
vite build           通过
cargo check          通过
vitest               125 passed（12 files）
visual-check.mjs     21/21 PASS（新增 8 条：图标 alpha/尺寸、icns+ico 存在、品牌图 ≥2x、
                                   透明底 alpha=0、品牌图唯一、强调色单一、深浅主题背景切换）
```

---

## §0′ 前三轮修复的根因细节

### 0.1 导航被"单开分组"，不是融合

**问题**：上一轮把 四类能力做成了左侧独立的「融合」分组（多智能体团队 / 记忆层 / 技能市场池 / 浏览器自动化）。这不是融合，是并列，且与该能力本应所属的既有菜单（专家·技能·连接器 / 资料库）语义重复。

**修复**：能力回到它们本应属于的父级菜单，作为该页的一个 tab：

| 原独立菜单项 | 现归属 | 实现方式 |
|---|---|---|
| 多智能体团队 | 能力中心 `/capabilities` | 新增「团队」tab，内嵌 `TeamsView` |
| 技能市场池 | 能力中心 `/capabilities` | 新增「市场池」tab，内嵌 `SkillPoolView` |
| 浏览器自动化 | 能力中心 `/capabilities` | 新增「浏览器」tab，内嵌 `BrowserView` |
| 记忆层 | 资料库 `/library` | 新增「记忆」tab，内嵌 `MemoryView` |

左侧主导航恢复为 4 项（插件 / 项目 / 专家·技能·连接器 / 资料库）。`/agent-ops/*` 四个旧路径保留为**兼容重定向**（带 `?tab=` / `?view=`），不再是主导航项。

### 0.2 下拉菜单被压成竖排（截图"快 / 速"）

**问题**：`AppSelect` 的菜单用 `left:0; right:0`，宽度被钳死为触发器宽度。思考深度选择器宽 72px，下拉里的「快速 / 标准 / 深度 + 长描述」被挤成竖排，视觉错乱。

**修复**（`src/components/ui/AppSelect.css`，全局 UI Kit，所有下拉受益）：
```css
.menu { min-width: 100%; width: max-content; max-width: 320px; }
.opt, .opt-label, .opt-hint { white-space: nowrap; }
```
同时 `.app-select` 的 `min-width: 140px` 改为仅在**未显式传 width** 时生效（`:not([style])`），避免反向撑大窄控件。

### 0.3 首页两张卡片孤立在输入框外

**问题**：首页「选择工作空间」「默认权限」是输入框下方的两张独立大卡片，与对话动作割裂。

**修复**：`ChatHero` 改为**输入框内底部操作条**——左半为上下文（附件 / 工作空间 / 目录 / 权限），右半为执行控制（思考深度 / 语音 / 发送）。同时修正目录选择器：`open()` 改为在 `ChatHero` 内 `await`，「正在选择…」才真实可见（此前 `emit` 同步返回，状态瞬间闪回）。

### 0.3b 全局 CSS 污染（用真实渲染截图才发现）

**问题**：`src/styles/agent-ops.css` 以**全局**方式引入了通用类名 `.tool-btn`，且定义为 30×30 图标按钮（`width/height/display:grid;place-items:center`）。能力中心自己的 `.tool-btn` 是带文字的普通按钮、**未定义宽高**，于是被全局规则接管：`刷新` 与 `+ 添加技能` 被压成方块、文字竖排换行。资料库同名的 `.tool-btn` 同样受影响。

**为什么之前没发现**：`vue-tsc` / `vite build` 都通过——这是纯运行时视觉缺陷，静态检查无法捕获。

**修复**（`src/styles/agent-ops.css`）：
- `.tool-btn` / `.badge` / `.muted` 全部限定进 `.agent-ops` 容器（`.agent-ops .tool-btn` 等）。
- 对话框内容经 teleport 渲染到 body、不在 `.agent-ops` 内，故新增专属名：表单行 `.dialog-row → .aops-row`、次要按钮 `.aops-plain`（`.dialog-row` 资料库也在用，全局定义会串样式）。
- 3 个视图的模板同步改用新类名。

**回归证据**（Chrome 真实渲染断言）：能力中心 `.tool-btn` 宽度由被压制的 30px 恢复为 **52px**；运行层视图内图标按钮仍为 **30px**（未被误伤）。

### 0.3c 浏览器预览暴露底层 TypeError

**问题**：非 Tauri 运行时下 `invoke` 抛 `Cannot read properties of undefined (reading 'invoke')`，被视图 catch 后**原样显示在界面上**（绿色/红色状态行），用户看到一串无意义报错。

**修复**：
- `src/composables/useAgentOps.ts` 加运行时守卫：**读**返回空值（页面走空态，解释交给顶部横幅）；**写**抛可读中文错误（写操作确实没发生，不能假装成功）。
- `src/composables/useLibrary.ts` 的 `describeLibraryError` 识别该底层错误，转为「需在桌面 App（pnpm tauri dev）中运行…」，不再退化成无所指的「操作失败」。
- 资料库「记忆」tab 下隐藏与本题无关的资料库错误行与检索框。

### 0.4 内嵌样式错乱

**问题**：运行层视图自带页面级容器（`height:100%` + 页面 padding + `max-width:1100px`），内嵌进能力中心后与外层 padding 叠加、且出现两个同名标题。

**修复**：
- 四个视图新增 `embedded` prop；`embedded` 时容器降级为 `height:auto; padding:0; max-width:none`。
- 内嵌 tab 时外层不再渲染 `.market-title`，改用内嵌视图自带的「标题 + 说明」。
- `TeamsView` 对话框内的原生 `<input>` / `<select>` 换成 `AppInput` / `AppSelect`，与全站 UI Kit 一致（原生控件此前无样式）。

---

### 0.5 模型配置「测试连接」永远失败（P0 阻断根因）

**症状**（截图）：设置 → 模型配置 → 点「测试连接」，红字
`Agnes-2.0-Flash: 无法连接到 openai 服务端: error sending request for url (https://api.apihub.agnes-ai.com/v1)`

**根因**：`src-tauri/Cargo.toml` 里

```toml
reqwest = { version = "0.13", default-features = false, features = ["json"] }
```

`default-features = false` 会连带关掉 `default-tls`，而 `features` 里也没有任何 TLS 后端。
**依赖树里一个 TLS crate 都没有**，因此 reqwest 无法完成 TLS 握手 —— 任何 `https://` 请求
在**发出前**就失败，报错正是 `error sending request for url (…)`（不是 DNS 错、不是证书错）。

**影响面**（本仓所有出网请求，不止模型测试）：
`settings_test_model`、`skills_install_from_url`（远端技能安装）、`extensions_install_from_url`（远端扩展安装）。

**证据 1 —— 依赖特性对比**（同一 `Cargo.toml`，只切 features）：

```
AFTER  : reqwest v0.13.5 __rustls,__rustls-aws-lc-rs,__tls,http2,json,rustls,system-proxy
BEFORE : reqwest v0.13.5 json
BEFORE : TLS crate 计数 = 0
```

**证据 2 —— 独立 https 冒烟**（临时集成测试，验证后已删除）：

```
TLS_OK status=200 OK        # features = ["json","rustls","system-proxy","http2"]
```

**修复**（`src-tauri/Cargo.toml`）：

```toml
features = ["json", "rustls", "system-proxy", "http2"]
```

- `rustls`：用系统信任库校验（`rustls-platform-verifier`），企业自签 CA 也能过；
- `system-proxy`：读取系统代理设置（公司网络/代理环境必需）；
- `http2`：多数 OpenAI 兼容网关默认走 HTTP/2。

> ⚠️ 注意：`error sending request` 这类错误**容易被误判为「网络不通 / 服务地址写错」**，
> 实际是构建期的 feature 缺失。排查同类问题先看 `cargo tree -f "{p} {f}" | grep reqwest`。

---

## §0″ 第四轮修复：首页输入 / 目录 / 模型 / 实时用量（截图反馈）

用户反馈原文：「这里中间都没办法输入字。我要选择一个目录。然后要选择一个模型吧。这里都不对。
还有旁边左下角这个显示也不对吧。这块要实时显示 token 那些东西吧。都没有。」

逐条对应根因与修法：

### 0″.1 中间输入框打不进字（阻断级）

**根因**：`ChatHero.vue` 的 `<AppTextarea :disabled="!cwd">`。首页 Hero 只在「没有活动项目」时出现，于是这个条件恒等于 `disabled` —— 首页输入框**永远**是灰的，用户看到的就是一块点不动的区域。

**为什么之前没发现**：`vue-tsc` / `vite build` / `vitest` 全绿。这是纯交互缺陷，静态闸门抓不到；`visual-check` 现在补了断言（见 §10）。

**修法**：
- 去掉 `:disabled`，输入框始终可输入。
- **未绑定目录时点发送**：把这句话暂存到 `ChatView.pendingHero`，拉起原生目录选择器 → 登记为项目 → `watch(cwd)` 里把暂存的那句补发出去。
- 编排放在 `ChatView` 而不是 `ChatHero`：`cwd` 一旦就位，Hero 立即卸载（`showHero` 计算属性），组件自己没机会「选完再发」。
- 用户取消选择时：清空 pending 并给出**非阻塞**提示（`alert()` 在 Tauri 里会卡住 webview，已全部换成顶部提示条）。

### 0″.2 选择模型

**根因**：模型只能在设置页配置，首页与对话头部都没有入口 —— 用户无从知道当前用的是哪个模型，也无从切换。

**修法**：新增 `src/components/chat/ModelSwitcher.vue`：
- 读 `settings_load` 的 `models`（只列 `enabled`），展示为 `名称 / provider · model`。
- 切换 → `settings_save`（读回整份设置再改一个字段，避免把主题/语言写丢）→ `pi_restart`。
- **为什么必须重启内核**：Pi 只在 spawn 时读 provider/model，热改不生效。选择器 title 里已写明这一点。
- 一个模型都没有时，控件退化成「配置模型」按钮 → 跳设置页，而不是一个空下拉。

### 0″.3 左下角显示的不是用量

**根因**：`Sidebar` 底部读 `billing_status`，而该项目没有统一计费接口 —— 没有 `billing.json` 时后端返回**硬编码**的 `balance=96.28 / today=2.4201`，前端照实渲染成「余额 ¥96.28」。这是 UI 在撒谎。

**修法**：
- 新增 `src/composables/useUsageStore.ts`：**模块级单例**订阅 `pi://event`，实时统计真实用量。
  - 侧栏是布局级、会话页是路由级，`provide/inject` 跨不过去，所以用单例而不是注入。
  - 两个口径分开记：`session`（内核进程内累计，重启归零）与 `run`（跨内核重启结转累加）。
  - 内核重启会让累计值回退 → 检测到回退就把上一段结转进 `run`，数字不会凭空消失。
- 新增 `src/components/layout/UsageCard.vue`：提示词 / 输出 / 总计 / 花费 + 调用次数 / 轮次 / 更新时间。**没有数据时显示「还没有用量数据」，不填占位数字。**
- 余额只在用户真的写了 `billing.json`（`demo === false`）时才出现，否则只留一个「未接入余额计费」的说明入口。

### 0″.4 目录入口

原来只有一个 28×28 的图标按钮，看不出用途。现在：已绑定项目显示「换目录」，未绑定时显示虚线高亮的「选择目录」，并在提示行说明「未选目录时，点发送会先让你选一个工作目录」。

### 0″.5 与参考实现的取舍（取最优、去劣势）

| 维度 | 参考实现的做法 | 本项目取法 |
|---|---|---|
| 首页输入 | 输入框常驻可打字，缺前置条件时在**动作时**补，不在**渲染时**禁 | 采纳：发送时再补目录，输入框不锁 |
| 模型切换 | 头部常驻模型选择，切换后需重启会话 | 采纳；并明确写出「会重启内核」这一代价 |
| 用量展示 | 底部常驻实时 token / 花费 | 采纳，但**只用内核真实上报值**，无数据就显示等待，不造数 |
| 目录/工作区 | 下拉选已有工作区 + 一个新建入口 | 采纳：下拉（已有）+ 显式「选择目录」（新建/绑定）并存 |
| 侧栏底部 | 展示账户余额 | **不采纳**：本项目没有统一计费后端，凭空显示余额属于撒谎，改为「未接入余额计费」入口 |

---

## §1 对话 ChatView（`/chat`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| **落地页 → 会话流（两段式）** | 发出第一条消息 | 纯前端（`shouldShowHero`） | ✅（本轮重做，见 §0⁸.1；选完项目仍停在落地页） |
| **过程抽屉：会话树 / 轨迹 / 工作流 / 连接器** | 点击 `轨迹` 按钮 | 纯前端 + `pi://event`（轨迹面板） | ✅（本轮新增，见 §0⁸.2；默认收起，收起时内容不挂载） |
| **轨迹抽屉徽标：工具调用计数** | 自动 | `pi://event` → `usePiEvents.stats.calls` | ✅ |
| **头部：工作目录（项目与目录合一）** | 点击/选择 | `project_active` / `project_set_active` / `tauri_plugin_dialog` | ✅（需 Tauri，见 §0⁗.2） |
| **头部模型选择器** | 选择 | `settings_load` / `settings_save` / `pi_restart` | ✅（需 Tauri） |
| 中断本轮 | 点击 | `pi_stop` | ✅（需 Tauri） |
| 发送消息 / 多轮对话 | 输入+发送 | `pi_send` / `pi_call` | ❓ 依赖 Pi 内核已配置并连接 |
| 切换思考深度（快速/标准/深度） | 选择 | `pi_call set_thinking_level` | ✅（需 Tauri，不阻塞主线程） |
| 会话树分叉 | 点击抽屉 | `pi_call get_tree` / `fork` | ✅（需 Tauri） |
| ~~左侧面板：文件 / 会话树 / 轨迹 / 工作流 / 连接器~~ | — | — | **已迁走**：过程类进抽屉，文件树进项目详情页（§0⁸.2） |
| ~~右侧面板：浏览器 / 文件编辑器 / 终端~~ | — | — | **已迁走**：全部进项目详情页（§0⁸.2） |

**落地页 Hero（未发出第一条消息时，含已选项目）**

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| **选完项目仍停在落地页** | 选择项目/目录 | 纯前端 | ✅（本轮修复，见 §0⁸.1） |
| 切换分类（日常办公 / 代码开发 / 设计创意） | 点击 | 纯前端 | ✅ |
| 技能 chip → 填入草稿 | 点击 | 纯前端 | ✅ |
| **输入框可直接打字（无需先选项目）** | 输入 | 纯前端 | ✅ |
| **未绑定目录时点发送 → 自动拉起目录选择 → 选完自动补发** | 点击 | `tauri_plugin_dialog` → `project_add` → `project_set_active` → `pi_start(cwd)` | ✅（需 Tauri，**待真机验证** L） |
| **工作目录：一个控件同时管「切项目」与「挑本地目录」** | 点击/选择 | `project_set_active` / `tauri_plugin_dialog` | ✅（需 Tauri，见 §0⁗.2） |
| **选择器等待态 + 取消 / 超时复位** | 自动 | `pickDirectoryGuarded()`（120s 超时 + 代际丢弃） | ✅（单测覆盖，见 §0⁗.1） |
| **输入框内：选择模型** | 选择 | `settings_load` / `settings_save` / `pi_restart` | ✅（切换会重启内核，明细只在 title/下拉项） |
| **输入框内：切换默认权限（角色）** | 选择 | `role_current` / `role_set` | ✅（需 Tauri） |
| 思考深度 / 发送 | 点击 | `pi_start` / `pi_send` | ❓ 依赖内核 |

**本页问题**
- 「发送 / 思考深度」依赖内核已配置并连接（**❓ 需真机**）。
- 切换模型会重启内核，当前会话上下文随之中断（**内核约束 K**）。
- 浏览器预览下「轨迹」面板无事件流（没有内核），属预期，不是缺陷。
- 「换目录」的完整链路（选目录 → 登记 → 内核重启到新目录）只能在真机验证（**O**）。
- 附件入口已按「不留假入口」原则**删除**；接入资产域时再作为真实功能加回。
- 「新会话」只清空**当前会话视图**：内核进程是否随之重启由 `pi_stop/pi_start` 决定（**❓ 待真机确认**）。

**侧栏（布局级，全站可见）**

| 功能点 | 触发 | 数据源 | 状态 |
|---|---|---|---|
| 项目列表 / 排序 / 设为活动项目 | 点击 | `projects_list` / `project_active` / `project_set_active` | ✅（需 Tauri） |
| **实时用量卡：提示词 / 输出 / 总计 / 花费** | 自动 | `pi://event` → `useUsageStore`（模块级单例） | ✅（本轮新增） |
| **调用次数 / 轮次 / 更新时间** | 自动 | 同一条事件流（`classifyEvent`） | ✅（本轮新增） |
| 余额 / 今日花费 | 自动 | 仅当 `app_config_dir/billing.json` 存在真实数据时展示 | ✅（本轮去掉硬编码演示值） |

---
## §2 项目 ProjectsView（`/projects`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 新建项目 | 点击 | `project_add` | ✅（需 Tauri） |
| 打开项目工作台 | 点击 | 路由 `/projects/:id` | ✅ |
| 归档 / 恢复 | 点击 | `project_archive` / `project_unarchive` | ✅（需 Tauri） |
| 从模板新建 | 点击 | `projects_templates` + `project_add` | ✅（需 Tauri） |
| 删除项目（二次确认） | 点击 | `project_remove` | ✅（需 Tauri） |
| 选择目录 | 点击 | `tauri_plugin_dialog` | ✅（需 Tauri） |

**本页问题**
- 无阻塞问题：归档 / 绑定目录 / 任务上下文均有对应已注册命令。
- 「删除项目」有二次确认，未发现误删路径。

---
## §3 项目工作台 ProjectWorkspace（`/projects/:id`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 返回列表 / 进入对话 | 点击 | 路由 / `pi_*` | ✅ |
| 绑定目录 | 点击 | `project_set_path` | ✅（需 Tauri） |
| 概览 / 配置 / 工作项 / 资产 / 引用 / 会话 Tab | 点击 | 纯前端 | ✅ |
| **文件 tab：文件树 + 编辑器（原对话页右栏）** | 点击 | `fs_read_dir` / `fs_read_file` / `fs_write_file` | ✅（本轮迁入，见 §0⁸.2；需 Tauri） |
| **终端 tab（原对话页右栏）** | 点击 | `pi_call` 终端通道 | ✅（本轮迁入；需 Tauri） |
| **浏览器 tab（原对话页右栏）** | 点击 | `pi://event` 浏览器事件流 | ✅（本轮迁入；需 Tauri） |
| **未绑定目录时点工具 tab** | 点击 | 纯前端 | ✅ 如实提示「先绑定目录」，不渲染空壳 |
| 保存配置 | 点击 | `project_update_config` | ✅（需 Tauri） |
| 工作项新增 / 删除 | 点击 | `project_add_work_item` / `project_remove_work_item` | ✅（需 Tauri） |
| 资产关联 / 解除 | 点击 | `project_add_asset` / `project_remove_asset` | ✅（需 Tauri） |
| 引用新增 / 移除 / 绑定会话 | 点击 | `project_link_task` / `project_task_context` | ✅（需 Tauri） |

**本页问题**
- 无阻塞问题；`?view=` 直达五个 tab 正常。
- Office 预览已接：docx/xlsx 直接渲染，pptx/pdf 降级提示用「原件」打开（12 MiB 上限）；其余二进制（图片等）预览未做。
- 「记忆」tab 下已隐藏与本页无关的资料库检索框与错误行（§0.3c 修复项）。
- 文件 / 终端 / 浏览器三个 tab 需要项目已绑定目录（**❓ 需真机**验证 FS 与终端通道）。

---
## §4 资料库 LibraryPanel（`/library`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| Tab 切换：资料库 / 搜索 / 最近 / 输出 / **记忆** | 点击 | 纯前端（`?view=` 可直达） | ✅ |
| 列表 / 树 / 统计 | 挂载 | `library_list` / `library_tree` / `library_stats` | ✅（需 Tauri） |
| 搜索 | 输入 | `library_search` | ✅（需 Tauri） |
| 读 / 写 / 重命名 / 移动 / 删除 | 点击 | `library_read` / `library_write` / `library_rename` / `library_move` / `library_remove` | ✅（需 Tauri） |
| 新建 / 导入 / 发布 | 点击 | `library_create` / `library_import` / `library_publish` | ✅（需 Tauri） |
| 启停 / 修订 / 回滚 / 原件 | 点击 | `library_set_enabled` / `library_revisions` / `library_rollback` / `library_open` | ✅（需 Tauri） |

### §4.1 记忆（内嵌 `MemoryView`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 非 Tauri 运行时横幅 | 自动 | — | ✅ |
| 刷新列表 | 点击 | `agent_memory_list` | ⚠️ 仅 Tauri |
| 写入记忆（内容 + 标签） | 点击 | `agent_memory_store` | ⚠️ 仅 Tauri |
| 记忆召回（对话内） | `/memory` `memory_recall` | Pi extension `agent-memory.ts` | ❓ 关键词/全文匹配，非语义向量 |

**本页问题**
- 六个 tab 的几何与文案已用真实渲染验证（§0.3b 的污染修复即在此页发现）。
- 技能安装后需重启内核才被 Pi 枚举（**已知边界 E**）。
- 连接器「注入 Pi」只把工具名写进白名单，MCP 工具对 Pi 进程实际不可见（**未接 J**）。
- 「市场池」无服务端 catalog，是本地池（**未实现 G**）。

---
## §5 能力中心 CapabilitiesView（`/capabilities`）—— 专家 · 技能 · 连接器 · 团队 · 市场池 · 浏览器

> 用户指出的"上面要融合的专家那块"。本轮把团队 / 市场池 / 浏览器三个运行层能力并入本页 tab。

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| Tab 切换：专家 / 技能 / 连接器 / **团队** / **市场池** / **浏览器** | 点击 | 纯前端（`?tab=` 可直达） | ✅ |
| 技能搜索 | 输入 | 纯前端过滤 | ✅ |
| 专家：新建草稿 | 点击 | `expert_draft_save` | ✅（需 Tauri） |
| 专家：选草稿 → 编辑器 | 点击 | `expert_draft_load` | ✅（需 Tauri） |
| 专家：保存 / 发布（四步确认） | 编辑器 | `expert_draft_save` / `expert_validate` / `expert_request_confirmation` / `expert_confirm` / `expert_publish` | ✅（需 Tauri） |
| 技能：添加（本地路径） | 点击 | `skills_install` | ✅（需 Tauri） |
| 技能：从链接安装 | 点击 | `skills_install_from_url` | ✅（需 Tauri） |
| 技能：卸载 | 点击 | `skills_uninstall` | ✅（需 Tauri） |
| 技能：刷新 | 点击 | `skills_list` + `tools_list` | ✅（需 Tauri） |
| 连接器：实例启停 / 编辑 / 选择 / 应用作用域 | ConnectorPanel | `connectors_*` | ✅（需 Tauri） |

### §5.1 团队（内嵌 `TeamsView`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 非 Tauri 运行时横幅 | 自动 | — | ✅ |
| 刷新列表 | 点击 | `agent_teams_list` | ⚠️ 仅 Tauri |
| 新建团队（打开对话框） | 点击 | — | ✅ |
| 读取成员候选（专家/技能/连接器） | 打开对话框 | `experts_list` / `skills_list` / `connectors_list` | ⚠️ 仅 Tauri |
| 候选成员点选 / 取消 | 点击 | 纯前端 | ✅ |
| 协调策略选择（顺序/并行/辩论） | 选择 | 纯前端（`AppSelect`） | ✅（本轮改为 UI Kit 控件） |
| 创建团队 | 点击 | `agent_team_create` | ⚠️ 仅 Tauri |
| 团队调度（对话内） | `/team` `team_dispatch` | Pi extension `agent-teams.ts` | ❓ 依赖本机 `pi` 子进程 |

### §5.2 市场池（内嵌 `SkillPoolView`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 非 Tauri 运行时横幅 | 自动 | — | ✅ |
| 刷新列表 | 点击 | `agent_skillpool_list` | ⚠️ 仅 Tauri |
| 发布技能（名/描述/正文） | 点击 | `agent_skill_publish` | ⚠️ 仅 Tauri |
| 技能安装（对话内） | `/skills-market` `skill_pool_install` | Pi extension `agent-skill-pool.ts` | ❓ 依赖内核技能目录枚举 |

### §5.3 浏览器（内嵌 `BrowserView`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| 非 Tauri 运行时横幅 | 自动 | — | ✅ |
| 刷新会话状态 | 点击 | `agent_browser_status` | ⚠️ 仅 Tauri |
| 在真实浏览器打开网址 | 点击 | `agent_browser_open` | ⚠️ 仅 Tauri |
| 页面抓取（对话内） | `/browser` `browser_fetch` | Pi extension `agent-browser-session.ts` | ❓ Node fetch |
| 无头截图（对话内） | `/browser` `browser_screenshot` | Pi extension `agent-browser-session.ts` | ❓ 依赖本机 chromium，无则如实报不可用 |

**本页问题**
- 无真实 catalog 服务端，「发现」页为本地兜底 + 直链安装（**未实现 G**）。
- 「从 URL 安装扩展」此前会因无 TLS 必然失败，已随 §0.5 修复。

---
## §6 插件 PluginsView（`/plugins`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| Tab：发现 / 已装；标签筛选 | 点击 | 纯前端 | ✅ |
| 复制内核与扩展诊断 | 点击 | 剪贴板 | ✅ |
| 启用全部 / 扩展启停 | 点击 | `tools_activate` | ✅（需 Tauri） |
| 主题选择 | 点击 | 纯前端（持久化） | ✅ |
| 从 URL 安装扩展 | 点击 | `extensions_install_from_url` | ✅（需 Tauri） |

**本页问题**
- 「测试连接」失败根因已修（**§0.5**），但提示文案仍偏乐观：404/401 也显示「连接正常」，建议标注「未校验鉴权与模型名」（**设计缺陷 B**）。
- 模板 `inputMap[m.id].temperature` 直接取属性；当前所有入口都会先 `syncInputMap`，暂无复现，但缺条目即渲染期抛错、整页失活，建议加固（**潜在缺陷 C**）。
- 模型保存后会调 `pi_restart`，内核未运行时后端跳过，前端文案已区分。

---
## §7 设置 SettingsView（`/settings`）

| 功能点 | 触发 | 后端命令 | 状态 |
|---|---|---|---|
| Tab：模型 / 工具 / 关于 | 点击 | 纯前端 | ✅ |
| 模型展开 / 显示密钥 | 点击 | 纯前端 | ✅ |
| 测试模型连通性 | 点击 | `settings_test_model` | ✅（需 Tauri） |
| 新增模型 / 保存 | 点击 | `settings_load` / `settings_save` | ✅（需 Tauri） |
| 工具开关 | 点击 | `tools_list` / `tools_activate` | ✅（需 Tauri） |

---

## §8 兼容路由（不再是主导航）

| 旧路径 | 重定向到 | 说明 |
|---|---|---|
| `/agent-ops/teams` | `/capabilities?tab=team` | 团队能力 |
| `/agent-ops/skills` | `/capabilities?tab=market` | 技能市场池 |
| `/agent-ops/browser` | `/capabilities?tab=browser` | 浏览器自动化 |
| `/agent-ops/memory` | `/library?view=memory` | 记忆层 |

---

## §9 Pi 内核与目录执行闭环

用户要求"以 Pi 为核心，能加载个目录，执行跑起来"。链路（已在代码中闭环）：

```
首页点「目录」→ 原生选择器取绝对路径
   → ChatHero emit('pick-directory', dir)
   → ChatView.onPickDirectory(dir)
   → createProject(name, dir)          [project_add + project_set_path]
   → project_set_active(id)
   → cwd.value = path  → showHero=false（进入三栏对话页）
   → watch(cwd) → pi_start(cwd)        [Rust: cmd.current_dir(cwd)]
   → 输入 → pi_send(prompt) → pi://event 流式事件
   → 左侧「轨迹」tab 实时渲染事件时间线
```

关键实现点（`src-tauri/src/pi_bridge.rs`）：
- `pi_start` 按 `cwd + provider + model` 做启动签名，签名不变直接复用已跑子进程（同项目内反复调用是空操作，不丢会话）。
- `PI_CODING_AGENT_DIR` 指向 app 配置目录，保证技能发现 / `defaultTools` / `models.json` 与外壳读写同一份。
- `--extension` 逐个挂载 `pi-manifest.json` 声明的扩展（当前登记 10 个：8 个 `agent-*` + `role-inject` + `sandbox-env`；数量以 `node scripts/check-extensions.mjs` 输出为准）。

---

## §10 验证分级

> 本表只说明各级别的**验证方法与判定口径**；具体通过数一律以闸门实跑输出为准（文档不写死数字，避免随时间腐化）。
> 复现：`pnpm typecheck` · `pnpm build` · `pnpm test` · `node scripts/visual-check.mjs` · `node scripts/check-extensions.mjs` · `node scripts/check-skills.mjs` · `cd src-tauri && cargo check && cargo test`

| 级别 | 方法 | 结果 |
|---|---|---|
| L1 类型 | `pnpm typecheck`（vue-tsc --noEmit） | ✅ 通过，无类型错误（以闸门输出为准） |
| L2 构建 | `pnpm build`（vite build） | ✅ 构建成功（以闸门输出为准） |
| L3 Rust | `cd src-tauri && cargo check` | ✅ Finished，无错误（含 `agent_ops.rs` 重命名后） |
| **L3c Rust 单测** | `cd src-tauri && cargo test` | ✅ 全绿（含「阻塞式命令必须声明 `async`」源码级守卫；通过数以闸门输出为准） |
| **L3b 出网能力** | `cargo tree -f "{p} {f}"` 特性对比 + 独立 https 冒烟测试 | ✅ 修复前 TLS crate `0` → 修复后 `200 OK`（见 §0.5） |
| **L4 真实渲染** | **本机 Chrome 渲染 `dist` 产物，对 11 条路由截图 + 程序化几何断言 + 全流程交互断言（打桩 Tauri IPC）** | ✅ 全绿，见下表（条数以闸门输出为准） |
| **L4b 组件级** | `pnpm test`（vitest：jsdom 真实挂载 + 源码级版式守卫） | ✅ 全绿（新增 `tests/chatStage.spec.ts` 等，均做 RED 验证；通过数以闸门输出为准） |
| L5 GUI 真机点检 | `pnpm tauri dev` 手动点击（含 Tauri IPC 生效后的真实读写） | ❓ 无头环境无法执行，需人工复核 |

**L4 程序化断言结果**

| 断言 | 观测值 | 判定 |
|---|---|---|
| 左侧主导航项 | `["插件","项目","专家 · 技能 · 连接器","资料库"]` | ✅ 无「融合」分组 |
| 主导航是否含遗留分组 | `HAS_LEGACY_GROUP=false` | ✅ |
| 思考深度下拉：触发器 / 菜单宽度 | `72px / 172px` | ✅ 菜单宽于触发器，不再竖排 |
| **首页输入框是否可输入 / 能否真收到键入内容** | `disabled=false` / `value="冒烟测试"` | ✅ 修复生效（本轮新增断言） |
| **首页工作目录入口数（项目与目录已合并）** | `count=1`，旧 `.bar-pick` `count=0` | ✅（本轮新增断言） |
| **目录菜单能否真的展开 / 收起** | `visible=true` → `Escape` 后 `count=0` | ✅（本轮新增断言） |
| **目录菜单几何：是否在视口内 / 是否对齐触发器** | `menu=(485,542) 300x108 vp=1440x900` / `menu.x=485 = trigger.x` | ✅（本轮新增；`isVisible()` 不看屏内位置，只看几何） |
| **菜单里是否有「选择本地目录…」** | 文案命中 | ✅（本轮新增断言） |
| **模型名后是否重复显示 provider** | `.ms-hint count=0` | ✅（本轮新增断言） |
| **首页是否还有无功能的附件按钮** | `.bar-btn count=0` | ✅（本轮新增断言） |
| **侧栏实时用量卡是否存在 / 无数据时是否如实说明** | 存在 / 文案含「还没有用量数据」 | ✅ |
| **侧栏是否仍展示写死的演示余额** | 不含 `96.28` 与「演示」 | ✅ |
| 能力中心 `.tool-btn` 宽度 | `52px`（曾因全局污染被压成 30px） | ✅ 修复生效 |
| **全流程：无目录项目是否出现在菜单里并说明缺什么** | 文案命中「产品需求全流程」+「未绑定目录 · 点此选择文件夹」 | ✅（本轮新增；此前菜单直接崩掉） |
| **全流程：点无目录项目是否真的绑上目录** | `project_set_path({"id":"p-flow-a","path":"/tmp/flow-demo-repo"})` + `project_set_active` 被调用 | ✅（本轮新增） |
| **全流程：绑定后是否进入对话界面 / 头部显示当前项目** | ~~`hero=0`~~ → **`hero=1`（仍在落地页）** + 落地页选择器 `label="产品需求全流程"` | ✅（本轮**改判式**修正：老断言把「空会话」当正确结果） |
| **全流程：对话页两侧是否还有常驻文件树 / 终端 / 浏览器** | `.chat > .left, .chat > .right count=0`（落地页与会话流各验一次） | ✅（本轮新增） |
| **全流程：发出第一条消息后是否才离开落地页** | `hero=0`，头部 `label="pi-workbench"` | ✅（本轮新增） |
| **全流程：过程抽屉是否默认收起、点击展开、含四个面** | `0 → 1`，tab 文案 `会话树/轨迹/工作流/连接器` | ✅（本轮新增） |
| **全流程：侧栏项目行的「工作台」入口** | `url=...#/projects/p-flow-b` | ✅（本轮新增） |
| **项目详情页：文件 / 终端 / 浏览器三个工具面** | tab `项目配置/计划项/关联资产/活动/文件/终端/浏览器`；`.fws-tree`+`.fedit` / `.term` / `.agent-browser` 各渲染 1 个 | ✅（本轮新增） |
| **全流程：「新会话」是否回到落地页** | `0 → 1`（去掉路由 key 时实测 `0 → 0`，RED 已验） | ✅（本轮新增） |
| **全流程：侧栏切项目对话页是否跟着换** | `label="pi-workbench"`（`/chat` 已挂载，未重新挂载） | ✅（本轮新增） |
| **全流程：从项目页返回对话页工作目录是否保持** | `label="pi-workbench"`（重新挂载 + 活动项目未变） | ✅（本轮新增） |
| **输入框聚焦后是否还有内层细框 / 外层反馈是否仍在** | `textarea boxShadow=none` / 容器边框 `rgb(226,230,236) → rgb(37,99,235)` | ✅（本轮新增） |
| **全流程：是否有渲染期崩溃** | 无（`pageerror` + `console.error` 双通道收集） | ✅（本轮新增） |
| **侧栏是否仍展示写死的演示余额** | 不含 `96.28` 与「演示」 | ✅（本轮新增断言） |
| 能力中心 `.tool-btn` 宽度 | `52px`（曾因全局污染被压成 30px） | ✅ 修复生效 |
| 运行层视图内 `.tool-btn` 宽度 | `30px` | ✅ 未被误伤 |

> L4 说明：浏览器预览没有 Tauri IPC，因此页面上的**读写类**功能仍走空态/横幅（这正是 §0.3c 的修复目标）；
> L4 验证的是**版式、导航结构、控件几何、错误降级文案**，读写落盘仍需 L5。

**结论**
- 本仓命名已与任何外部平台解耦（§0.0）；文档中「参考基线」只用于取舍讨论，不是依赖。
- **四个 P0 根因已修复**：
  1. **模型配置「测试连接」永远失败** —— `reqwest` 缺 TLS feature，全仓 https 出网不可能成功（§0.5）；
  2. **全局 CSS 污染** —— `agent-ops.css` 的 `.tool-btn` 把能力中心/资料库的带文字按钮压成 30px 方块（§0.3b）；
  3. **首页输入框永远打不进字** —— `:disabled="!cwd"` 在首页恒为真（§0″.1）；
  4. **换目录后整个窗口卡死** —— 阻塞式 `pi_call` 跑在主线程，最长按住 UI 120 秒（§0⁗.1）。
- 另有 15 处 P1/P2 缺陷已修：浏览器预览暴露底层 `TypeError`、下拉菜单竖排、能力单开导航分组、内嵌双层 padding 与重复标题、团队对话框原生控件无样式、目录选择器反馈态、首页缺模型选择器、左下角展示硬编码演示余额、设置页 `inputMap` 缺条目失活、目录入口只有图标无文字、`alert()` 阻塞 webview、首页三色分类、吉祥物白底与裁切、Dock 图标未随品牌更新、操作条重复入口（模型名重复提示 / 无功能附件按钮 / 项目与目录两个控件）。
- 左侧导航已无孤立分组；四类运行层能力作为 tab 归入它们语义所属的菜单。
- 首页输入框可直接打字；未绑定目录时点发送会先选目录再自动补发；工作目录与项目合并为单一控件；模型可在首页/头部直接切换；侧栏底部为内核真实上报的实时用量。
- 所有页面功能点均有对应且已注册的 Tauri 命令，逻辑闭环完整。
- **仍未修复项**见 §0.2（B/E/F/G/H/I/J/K/L/M/N/O/P/Q）——逐条列出原因与建议，不含模糊表述。

**仍未验证（需真机）**：
1. `pnpm tauri dev` 下的端到端点检（含 `?tab=` 直达与内嵌切换）；
2. TLS 修复后**真实模型端点**的「测试连接」结果；
3. **「换目录」完整链路**：选自新目录 → 登记项目 → 内核重启到新目录，且界面全程不冻结；
4. **首页「先选目录再发送」**（选到目录 → 自动补发；取消 → 草稿保留）；
5. **模型切换后内核重启**是否如实换到新模型（`models.json` 落盘 + spawn 参数）；
6. 侧栏用量卡在真实对话中的数字增长与「内核重启结转」；
7. 多智能体真实多轮调度（依赖本机 `pi` 子进程）；
8. 浏览器无头截图（依赖本机 chromium）；
9. 记忆召回为关键词/全文匹配，语义 RAG 属后续阶段。

---

## §0¹⁰ 代码库索引：从「只转圈」到「真遍历+真建库」（第十轮）

**用户痛点（第九轮收尾后反馈）**：对话页底部虽然有了状态行，但「只加了个 loading，其他啥也没做——既没有遍历文件，也没给项目生成 codebase-memory-mcp 的 db」。即：索引动作从未真正发生，状态是假的。

**根因**：此前没有把「项目目录」与 `codebase-memory-mcp index_repository` 接通。缺三样东西：
1. 后端没有命令去真正跑 `index_repository`（遍历 + 建库）；
2. 前端没有在「项目激活/绑目录」时触发索引，也没有把后端结果落盘展示；
3. Pi 侧没有工具去查这个库，索引建了也无法被对话消费。

**修复（全部已落地 + 验证）**：

| 层 | 文件 | 改动 |
|---|---|---|
| 后端 | `src-tauri/src/codebase.rs`（新增） | `project_index_codebase`（async，spawn_blocking 跑 CLI，不阻塞 UI）+ `project_index_status`（只读状态）。`find_binary` 优先 `CODEBASE_MEMORY_MCP_PATH`→PATH→常见安装位；输出截取首个 `{` 到末个 `}` 规避 deprecation warning 前导行；`isError` 透传。 |
| 后端 | `src-tauri/src/projects.rs` | `Project` 增 `codebase_project_name/nodes/edges/indexed_at/error` 五字段；新增 `pub(crate) fn set_codebase_status`（因 `ProjectStore.projects` 私有，索引结果统一在此写入）；`Project` 构造处补字段。 |
| 后端 | `src-tauri/src/lib.rs` | `mod codebase;` + 注册两个命令。 |
| 前端 | `src/composables/useProject.ts` | 增 `CodebaseIndexStatus` 接口、`codebaseIndexing`/`codebaseStatus` 共享 ref、`indexProjectCodebase`/`refreshCodebaseStatus` 封装。 |
| 前端 | `src/views/ChatView.vue` | `maybeIndexProject(id)`：项目落到有目录后先读后端状态，**仅当 `none` 才真正触发索引**；`onBindDirectory` 换目录时显式重建索引；`ComposerStatus` 传 `:project-id`。 |
| 前端 | `src/components/chat/ComposerStatus.vue` + `.css` | 新增**常驻**代码库状态行：索引中（转圈）/ 已索引 N 节点·M 边（重建）/ 失败（重试）/ 未索引（索引），始终可见，专门回答「有没有在跑、查没查」。 |
| Pi | `src-tauri/extensions/agent-codebase.ts`（新增） | 注册 `codebase_status` / `codebase_search` / `codebase_architecture` / `codebase_query` 四工具，经 `list_projects` 用 cwd realpath 解析项目名后调 `search_code`/`get_architecture`/`query_graph`。 |
| 配置 | `src-tauri/pi-manifest.json`（原 `capabilities.json`，后拆分为 Tauri ACL `capabilities/default.json` + 本清单） | extensions 列表加入 `agent-codebase.ts`。 |

**验证证据**（通过数一律以闸门输出为准；复现：`pnpm typecheck` / `pnpm build` / `pnpm test` / `node scripts/visual-check.mjs` / `cd src-tauri && cargo check && cargo test`）：
- `cargo check` ✅；`vue-tsc --noEmit` ✅；`vite build` ✅；`vitest` 全绿 ✅；`verify:ui`（visual-check.mjs）全绿 ✅（全流程已含 `project_index_codebase` IPC 调用）。
- **真实建库实测**：对 `/Users/tatsuma/Documents/GIT/pi-workbench` 跑 `index_repository` → `nodes: 3130 / edges: 8836 / status: indexed`。证明「遍历文件 + 生成 db」确为真实发生，非 loading 假象。（该数字为当次实测快照，重复执行以输出为准。）
- 扩展 `.ts` 经 `tsc --noEmit` 零错误。

**真机（L5）待补**：`pnpm tauri dev` 下点击「索引/重建」按钮的真实进度回流；大模型对话中 `codebase_search` 回灌上下文的实际命中质量。
