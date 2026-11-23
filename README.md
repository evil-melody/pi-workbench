# Pi Workbench

Tauri 2 + Vite + Vue 3 桌面工作台，以 [Pi](https://pi.dev)（极简 agent harness）的 **RPC 模式 + extension 插件** 作为唯一 Agent 内核。

> 定位：**以 Pi 为唯一内核**的渐进式 Agent 宿主 —— 工作台把「项目 / 资料库 / 专家 / 技能 / 连接器 / 团队 / 记忆」都做成可管理的一等公民，能力以 **Pi extension** 形式插件化接入，同时提供 **Rust 后端 + Vue 面板**，让同一份状态既是模型可调用的工具，也是人可直接管理的界面。

## 架构

```
Vue 工作区  ──invoke──>  Tauri(Rust)  ──stdio JSON──>  pi --mode rpc（微内核）
   │                          │                              │
   │                          ├─ proactive.rs  主动任务账本 / 调度 / 收件箱
   │                          ├─ mcp.rs        MCP Gateway（stdio JSON-RPC 客户端）
   │                          ├─ agent_ops.rs  运行层状态（团队 / 记忆 / 技能池 / 浏览器会话）
   │                          └─ fs / terminal / projects / library / connectors
   └──event<──────────────────┘   Pi 事件流（message_update / tool_call / agent_settled …）
```

- **Pi 内核**：Tauri 启动 `pi --mode rpc --no-session --extension <sandbox-env.ts> --extension <role-inject.ts> …`，扩展清单以 `pi-manifest.json#extensions` 为单一真源（共 10 个扩展）
- **Pi extension 层**：`src-tauri/extensions/` 下的 `sandbox-env.ts`（声明式沙箱接缝）、`role-inject.ts`（专家角色注入）、`agent-teams.ts` / `agent-memory.ts` / `agent-skill-pool.ts` / `agent-browser-session.ts`（团队 / 记忆 / 技能池 / 浏览器会话）、`agent-codebase.ts`（代码库索引）、`agent-guard.ts` / `agent-tool-gate.ts`（工具守卫与硬审批）、`agent-mcp-bridge.ts`（MCP 桥接）随内核激活
- **专家角色**：`role-inject.ts` 每轮把当前角色追加到 Pi 系统提示，角色由 `roles.rs` 管理（详见 [docs/roles.md](docs/roles.md)）
- **运行层状态**：`agent_ops.rs` 与 `agent-*.ts` 读写同一份 `.pi/<kind>/` 磁盘状态，人面与 agent 面一致
- **沙箱**：目前只有 extension 接缝 —— 由 `sandbox_list` / `sandbox_run` 两个 Pi 工具暴露给模型，读工作区 `.pi/sandboxes/<id>/`；无 Rust 侧沙箱模块，也没有对应面板。目录为空时工具如实报 0 个环境；`sandbox_run` 在无就绪环境（未声明 / 未构建）时直接拒绝执行（fail-closed），不回退宿主 PATH

## 运行

```bash
# 必须装 agent harness，不是计算 π 的那个同名包！
npm install -g @earendil-works/pi-coding-agent
pi --version          # 期望 0.87.x

pnpm install
npm run app:dev       # 拉起桌面 App（前置校验 pi/cargo/端口，缺什么直接报）
```

`npm run app:dev` 内嵌环境前置校验：Node 版本、pi 内核版本（与 `package.json#piVersion` 比对）、
cargo 工具链、1420 端口占用。**版本不符直接失败，不做静默降级。** 其余入口：

```bash
npm run app:dev:web   # 浏览器开发服务器：只验证 UI，内核不可用（页面会提示）
npm run app:check     # 环境 → cargo check → pnpm build 全量校验
npm run app:preflight # 只跑前置检查
npm run verify:ui     # 真实渲染巡检（无头 Chrome 跑 dist：截图 + 几何断言）
npm run verify:pages  # 全页自动巡检：14 路由 × 明暗 × 3 断点 = 84 张截图 + 缺陷探测（横向溢出/出视口/破图/超小字/文字裁切/空壳页）
npm run verify:flow   # 端到端流程验证：协议/门控/记忆/检查点 harness + 真内核 E2E + 专家协作链路模拟（195 项断言）
```

`verify:pages` 的文字探测用 Range 实测字形宽度，不用 `scrollWidth`——后者把尾部 padding 计入并向上取整，会产生成片假阳性；`overflow: visible` 报「外溢压邻居」，`hidden` 且无 ellipsis 才报「真裁切」，两者修法不同。

`verify:flow` 覆盖完整链路：P1 协议与命令闸门 → P2 工具分类与 MCP 加固 → P3/P4 记忆评分与事件流 → checkpoint 编辑备份 → B1/B3 真内核审批与压缩回路 → 专家协作七场景（运行节点图 / 成员分道 / 交接点 / 窄屏几何）。

> ⚠️ `npm i -g pi` 装到的是 `pi-number`（圆周率计算器，v2.0.5）。它同样会创建 `pi` 可执行文件，
> 但任何参数都只打印 `3` 就退出，且不支持 RPC —— 表现为「应用能启动、内核无反应」。
> 正确包：`@earendil-works/pi-coding-agent`。
>
> 引擎能力与分阶段路线见 [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)；
> 产品结构与工程契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
> 运行层（团队 / 记忆 / 技能池 / 浏览器会话）见 [docs/AGENT-OPS.md](docs/AGENT-OPS.md)；
> 逐页功能与已知问题见 [docs/PAGE-FUNCTION-AUDIT.md](docs/PAGE-FUNCTION-AUDIT.md)。

## 主要功能

- **对话**：Pi RPC 流式输出，每轮末尾一行 `N 步 · $成本` 收据（用量缺失且本轮被中止时改显 `已中断`）；消息与轮次带时刻，跨年只留年份，journal 回放没有本地时刻就不画时钟；右侧「轨迹」列常驻且为流水线加宽（`--chat-aside: clamp(380px,34vw,560px)`；窗宽 < 1076px 转浮层、≤851px 整屏覆盖），内核事件按「图标 / 工具+对象 / 时长」逐行排列，原始 JSON 只在展开体里，带计数徽标与自动贴底。**引用体系**：选中 assistant 正文即浮出「添加到对话」+ 批注框，引用卡进 composer 托盘（与附件并列、每条可删、悬停看原文），发送时以独立 `[引用 / quotes]` 块随 prompt 下发并带 `quotes` 富字段落 journal——回放两条通道（富字段优先 / 块解析兜底）都能还原气泡内引用卡；用户自己的选区不弹浮层（只引用回复）。**Widget 操作**：产物卡 hover 出「添加到对话」（引用产物路径，托盘显文件名）；预览层工具条支持 预览↔代码切换（文本类）、复制代码 / 复制图片（ClipboardItem blob，拒写退 data URL）、保存到本地（`dialog|save` → Rust `artifact_save_as` 拷贝）。**拖拽上传**：文件拖进窗口即出可落遮罩，松手走 `attachment_add` 落盘（与选文件同通道），hero 与会话态共用附件托盘，「只拖图不写字」合法。**粘贴图片**：剪贴板图片无路径，读成 base64 走 Rust `attachment_add_bytes` 落同一托管目录（32MiB 上限、扩展名白名单兜底）——选文件/拖拽/粘贴三条通道收口同一托盘，回放分不出图的来路；纯文本粘贴不拦。**MCP 加载进度**：对话流顶部临时条轮询连接器握手态，「正在连接 N/总数」可展开已连/未连/异常分组，全就绪显示「所有 MCP 服务已就绪」后自毁，不落历史。**编辑重开**：user 气泡 hover 出「编辑」，原位换成可编辑区（Enter 提交 / Esc 取消），提交后回滚该轮 checkpoint（还原文件 + fork 会话树）并用编辑后文本重新派发；**刷新末条**：仅最后一条回复的操作行出刷新键，撤掉该轮回复与产物、同文本重发。两者共用同一前端编排底座，回滚失败落「对话编辑/重发失败，请稍后重试」进消息流。**提问导航**：对话 ≥4 轮且容器够宽时右侧浮出刻度条（一提问一短棒、当前项更长更深），hover 或顶栏「历史提问」展开列表，点刻度/列表项定位到那条提问；滚动时高亮随「第一条未滚出视口的提问」折算，独立回放窗口（`?replay=` 深链）不出导航。**队列重排**：流式中排队的插话/排队条目可拖动排序（跨段拖 = 插话⇄排队类型转换）、键盘 ↑↓ 同语义、hover 出编辑/删除——变更走 `clear_queue` 取全文 → 快照变更 → 按新序重发的编排（内核零改，UI 仍以 `queue_update` 回推为权威）；编辑只换正文，附件/引用标记块原样带回。**回退确认产物态**：点「回到此处」弹窗即拉 `checkpoint_preview` dry-run，把受影响产物摊成「将还原（改前已存在，带第 N 轮起归属）/将被删除（该轮 `write` 新建，哨兵登记）」两组 + bash 副作用不可撤销的边界注，空改动给明确空态；确认后 rewind 按区间语义还原 ≥该轮全部备份（同文件多轮取最早），新建文件经 `.created` 哨兵删除——预览与还原共用同一收集逻辑，所见即所得。**延续问题推荐**：轮次落定后扩展从末条用户消息抽主题，产三条「接着问」chip（继续做 / 补测试 / 换角度）；点 chip 只填入草稿不自动发，可换一批或关闭。推荐源是模板（`ExtensionAPI` 无模型调用通道），经 `pi_suggest` custom entry → `entry_appended` 事件透传，内核零改。**会话树直达**：Pi 的会话是一棵树，每次提问是一个节点；顶栏「会话树」键直达抽屉页签，任意 user 行可分叉（内核 `fork` 只接受用户消息，非 user 行的分叉键禁用并写明约束），「分叉末端」一键重开末条提问。**会话转写导出**：顶栏「转写」键把当前对话摊成逐轮可读文本（角色 · 时刻 + 正文 + 工具/附件行，缺时间戳就不画时间），`.txt` 落盘与 JSON 迁移导出共用 `conversation_export` 透传；两种口径并列——JSON 给机器往返，转写给人读
- **收件箱 / 定时任务**（阶段 1 MVP）：`proactive.rs` 维护任务账本（`proactive.json`）与单调度线程，到点复用常驻 Pi 内核执行并把结论写入收件箱 + 系统通知；账本跨重启存活，上次崩在 `running` 的任务会在启动时标为 `interrupted` 并自动重排，失败按 60s × 次数退避重试（上限 3 次）。通知发出后 90 秒内应用获得焦点即视为点击，自动打开收件箱并定位到对应任务；应用已在前台时点通知不会触发焦点事件，因此不跳转。预授权可在任务卡片上编辑 bash 命令前缀与单次风险动作额度，改动即时生效；写入根固定为项目目录，越界动作直接 block 并记入 `proactive-audit.jsonl`。调度以「计划时刻 + 周期」推进，1000 周期压测零漂移（`scheduler_does_not_drift_over_1000_cycles`）。**后台驻留**：主窗口首次关闭时询问一次「驻留后台 / 直接退出」并持久化，设置页可改回每次询问；驻留态托盘菜单提供打开主窗口、暂停主动任务、下次任务状态与彻底退出；登录项默认关闭、设置页显式开启；内核空闲 5 分钟回收，任务到点自动重拉；彻底退出停调度、停内核并清理预授权策略文件；单实例插件阻止重复调度器。**边界**：外部 IM / 邮件 / webhook 触达通道未接入；应用真正退出期间不调度（无系统级守护进程）。
- **项目**：卡片式项目列表，支持归档 / 绑定目录 / 预算与工作项；进入项目工作台后 Pi 以该项目目录为 cwd 启动
- **侧栏**：双层结构——56px 图标轨道（对话/收件箱/插件/本地模型/能力/资料库 + 未读角标 + 主题/设置）+ 会话面板（新会话、项目列表带会话数徽标、运行记录按项目分组、用量卡）；按 WorkBuddy 参考图收口会话树：工作区行=文件夹图标 + 名称 + chevron + 计数 pill，子行挂竖线引导段、选中灰底、行尾绿色 A 徽标（不显示时间、不露「···」；置顶/重命名/分享/删除走行右键）；≤900px 只留轨道。进程抽屉与专家选择在切页后保留，点「新会话」才清。macOS 顶部拖拽带全页共用一条
- **资料库**：资料库 / 搜索 / 最近 / 输出 / **记忆** 五个 tab；文本可预览与回写；Office 预览已接：docx/xlsx 直接渲染，pptx/pdf 降级提示用「原件」打开（12 MiB 上限）
- **记忆**：删除进入 24 小时待撤销态，期间可在记忆页恢复；也可跳过窗口立即永久删除（二次确认 + `memory-audit.jsonl` 留痕）。到期由调度 tick 自动硬失效，召回与向量检索都按有效条目过滤。召回注入统一挂在扩展 `before_agent_start`，对话与主动任务共用同一条路径；主动任务单轮写入上限 3 条。用户画像由记忆保留标签（`profile:preference|taboo|goal|workflow=`）折叠成只读视图，不另立手工档案。词面召回评测基线见 [eval/memory-recall-100.jsonl](eval/memory-recall-100.jsonl)（`pnpm eval:memory`），本轮不接向量库
- **能力中心**：专家 / 技能 / 连接器 / **团队** / **技能池** / **浏览器** 六个 tab，默认落「专家」（侧栏入口第一位就是专家）；前三个是能力市场（专家支持从 WorkBuddy 插件目录或角色 md 导入，带预览、冲突处理与工具映射；角色四段——工作方法 / 边界 / 交付物 / 停止条件——按市场包的真实标题族映射，「标准工作流」「审查维度」「Coding Process」这类杂名不再漏），后三个是运行层面板
- **插件**：发现社区插件与本地安装入口；扩展清单取 manifest 声明 ∪ 加载/停用目录实际文件（直链安装的扩展不再看不见），**两层开关分开**——加载层把 `.ts` 在 `extensions/` 与 `extensions-disabled/` 间搬运（pi 0.87.1 无条件自动加载 agent 目录，文件位置即唯一真源；内置扩展只读、只停不删，防 seed 复活），工具层写 `defaultTools`；外装扩展可卸载；工具条「全部停用/恢复」一键排查扩展冲突，改动重启内核生效。**Pi 托管包透传（复用不重建）**：npm/git/本地目录包的源语法、落盘与持久化全部交给 `pi install|remove|update` 原样透传（`pi_pkg.rs` 只 spawn 子进程并解析 `pi list` 输出，零复刻 pi 语义）；顶栏「N 个插件可更新 / 刷新 / + 添加插件」，可更新检测走平台标准工具（npm 比 `package.json` 版本与 `npm view`、git 比本地 HEAD 与该检出 upstream 的 `ls-remote`）；发现 tab 生态四卡（pi-web-access / pi-subagents / pi-mcp-adapter / pi-plan-mode）一键 `npm:<pkg>` 安装
- **composer `+` 菜单**：1:1 WorkBuddy 召唤形态——主列 320px 紧凑卡、六行 ×46px、18px 图标列 / semibold 标签 / 值+箭头右列三列严格成列、首行「添加文件」常驻浅底；模式/专家/连接器/角色四行在主列回显当前值。子面板以 **flyout 双列**并排弹出（主列 302 + 缝 6 + 子列 300，总宽 626），视口放不下两列（<760px）时回落 drill-in：子列独占、返回头出现。六项能力（添加文件/模式/专家/技能/连接器/角色）全部接真后端，选中态只在触发器旁 chip 展示一份。专家子面板分「专家 / 专家团」两页签：专家持续生效（发送后 chip 保留，直到用户移除），只有**已发布**的专家能召唤（草稿标灰禁用，运行期 `load_expert` 只认 `.published.json`）；专家团与专家同语义——点选只绑定团队 chip（团名回显、移除键解绑，输入框不露内部 id），发送时由前端转成 `team_dispatch` 工具调用指令（不拼 `/team dispatch` 命令——命令通道不产 `agent_settled`，会卡 180s），与工具共用同一条真实调度路径——真实执行后台化：只同步写 `run_start` 并返回运行号，成员在独立子进程跑，「智能体」面板每 4s 轮询运行日志自动收敛；队长人设补本仓真入口提示（成员键 `e:<专家Id>`，不许代写成员产出）。专家列表按 id 去重，发布后不再出现两张同款卡。运行中步骤条按内核 `runId` 聚合工具调用，不再因 `turn_start` 晚到误报「共 0 步」
- **设置**：1:1 WorkBuddy 三组侧栏（设置 / 功能 / 数据与安全）+ 顶部搜索，共 18 项——截图 15 项全量补齐（通用、个人主页、套餐与积分、外观、快捷键、个性化、记忆与进化、智能体、模型、助理、设备连接、对话流、数据导入、数据管理），另保留我方原有桌面与启动、工具激活、关于；无账户/计费体系的两项给本机说明并指向真实入口，不造空开关。通用含界面语言、自动归档、模型下载源；外观与个性化含主题浅色/深色/跟随系统、字号四档等比缩放 `--fs-scale`；高级权限为完全访问 fail-closed。内联字段走 88px 标签列 + 控件列的定宽网格，控件左缘不随标签字数漂移

- **视觉精细化基线**：浅色弱化墨 `#666c78`（页面底 4.57:1，过 WCAG AA 小字门槛）；系统提示条走整行容器、左缘与顶部横幅齐平；六个能力页标题统一在标签栏上方且不重复；项目工作台工具页内容左缘与页签对齐；390px 抽屉六个页签完整可读；连接器删除图标未二次确认前保持中性无红框；无效令牌 `--r-md` / `--font-mono` 已从源码清除，圆角与中英文等宽字体统一走 `--r` / `--mono`；导航选中态有蓝色左边标记、composer 聚焦有焦点光圈；侧栏品牌名与设置标签列的长文本有 ellipsis 收口，不撑破容器；**对话页内容列（消息流 / 步骤行 / 提示条 / 输入浮卡）共用 `--chat-pad`，与 `--chat-col` 封顶后等宽对齐**——「消息全宽而输入框收窄」的旧口径已废弃；**页面壳定律**：所有内容页壳统一 `max-width: var(--page-max)` 居中，宽屏下各页内容边线落在同一条线上，切页不跳位。以上均有 `visual-check` 几何/静态断言守护

## 专家角色

对话页顶部与首页输入框内都可切换「专家角色」，决定 Pi 每轮采用哪段系统提示。切换即时生效（重写项目级 `.pi/roles/current.md`），无需重启内核。

内置：`general`（通用助手，结论先行 + 依据到行号）、`aider-programmer`（Aider 范式编程搭档：repo map 先行、最小 diff、测试驱动、原子提交、只读优先）。

自定义角色 = 在 `~/Library/Application Support/com.piworkbench.app/roles/<id>.md` 放一个 md，首行 `<!-- role: <id> | <名称> -->`，正文即提示词。详见 [docs/roles.md](docs/roles.md)。

## 技能与工具

**技能（Skill）** 是「说明 + 脚本 + 资源」的组合：Pi 启动时只把 `name` 与 `description` 放进系统提示，
命中任务时才读 `SKILL.md`。技能面板有两个来源：

- **磁盘扫描** `<agent-dir>/skills/`（即 `~/.pi/agent/skills/`）与项目 `.pi/skills/`，由 `skills.rs` 递归发现。
- **内核回报** 向 Pi 发一次 `get_commands`，拿到 `source: skill | prompt | extension` 三类命令及其路径与作用域。

导入时先预检 frontmatter：`name` 只允许小写字母、数字、单连字符且 ≤ 64 字符，`description` 必填且 ≤ 1024 字符。
**Pi 对畸形技能是静默跳过**（实测：一个 `name: BAD_Name` 的技能不会让内核报错，但也永远不会被加载），
所以校验前移到安装期，避免「装了却以为生效」。安装后需点面板上的「重启内核」，`pi_start` 才会重新枚举技能目录。

**工具**由 `<agent-dir>/settings.json` 的 `defaultTools` 决定（默认值 `read, bash, edit, write`）。
设置页「工具激活」写入白名单后会调用 `pi_restart` **原地重启内核**（用上次的 cwd 重建），改动立即生效；
可选工具全集来自能力清单 `tools.builtin`，由 `tools_list` 返回的 `catalog` 字段提供，前端不写死工具名。
连接器面板的「注入 Pi」把该 server 的工具名并入白名单。
边界：MCP server 跑在 Tauri 侧，Pi 进程拿不到这些工具，白名单目前只保证名字进内核配置，
真正的可见性还需要一条 Tauri→Pi 的 extension 桥接。

**模型**同样在启动时注入：设置页保存模型配置后也会触发 `pi_restart`，新 provider / model / api-key 在新进程里生效。

能力清单 `src-tauri/pi-manifest.json` 是这三块的单一真源，启动时加载并校验（含 `pi` 版本与清单钉住版本是否一致）。
它与 Tauri 的权限体系（`src-tauri/capabilities/default.json`）是两套机制，2026-10-17 起已拆分为两个文件，不再混写。

## 构建校验

```bash
npm run app:check     # 环境前置 + cargo check + 前端构建
pnpm run typecheck    # vue-tsc 类型检查
pnpm build            # 前端 → dist
cargo check           # Rust 后端
cargo test            # Rust 后端单测（projects / library / skills / pi_bridge 等）
pnpm run verify:ui    # 真实渲染巡检（需本机 Chrome）
```

> 注意：Rust 工具链装在 `~/.cargo/bin`，不在默认 PATH。若 `cargo` 报 command not found，
> 先 `export PATH="$HOME/.cargo/bin:$PATH"` 再执行桌面模式命令。

## 状态

- ✅ 对话流式（Pi RPC）、文件树、终端、项目管理
- ✅ MCP Gateway：动态 `tools/list` 聚合 + `tools/call` 转发（连接器面板）
- ✅ 专家角色：内置 `general` / `aider-programmer`，下拉切换，md 文件可扩展
- ✅ 技能：磁盘扫描 + 内核 `get_commands` 双来源，frontmatter 预检后落盘，重启内核生效
- ✅ 工具白名单：`defaultTools` 注入 / 取回，改完自动 `pi_restart` 生效；可选集由后端 `catalog` 给出
- ✅ 模型配置：写入内核启动参数，保存后自动重启内核生效；连通性自测走系统信任库 + 系统代理
- ✅ 运行层：团队 / 记忆 / 技能池 / 浏览器会话，面板与 Pi 工具共用同一份 `.pi/<kind>/` 状态（端到端落盘需在 `pnpm tauri dev` 内确认）
- ✅ 生命周期：全局运行态 / 审批监听 / console 桥接在根组件卸载时统一收口，无残留计时器或全局方法覆盖
- ✅ 能力清单 `pi-manifest.json` 加载与校验（含内核版本对齐），扩展清单是其唯一依据
- 🟡 沙箱：仅 Pi extension 工具接缝（`sandbox_list` / `sandbox_run`）；无 Rust 模块、无 UI 面板
- 🟡 Pi extension 插件层已接入（代码与语法校验通过；端到端加载待人工在 `pnpm tauri dev` 中确认）
- ✅ 资料库已接 fs（文本预览与回写）；Office 预览：docx/xlsx 渲染，pptx/pdf 降级提示用「原件」打开（12 MiB 上限）；技能安装需重启内核
- ✅ 路径穿越防护：文件接口以活动项目为根，软链逃逸一并拦截
- ✅ MCP JSON-RPC id 全局唯一，多 server 并存不再错配响应
- 🔜 下一步见 [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)：
  Pi RPC 全双工 → 会话树 UI（Pi 原生 `get_tree`/`fork`）→ MCP 工具注入 → 沙箱执行重定向 → 环境快照绑定会话节点

## 目录

```
├── docs/
│   ├── ARCHITECTURE.md              # 产品结构与工程契约
│   ├── AGENT-OPS.md                 # 运行层：团队 / 记忆 / 技能池 / 浏览器会话
│   ├── PAGE-FUNCTION-AUDIT.md       # 逐页功能审计与已知问题
│   ├── IMPLEMENTATION-PLAN.md       # 内核能力落地路线
│   ├── roles.md                     # 专家角色机制与新增角色的写法
│   └── alignments/                  # 历史对齐记录（归档）
├── src/                             # Vue 前端（对话 / 项目 / 资料库 / 能力中心 / 设置）
└── src-tauri/
    ├── extensions/                  # Pi 扩展（10 个，清单见 pi-manifest.json#extensions）
    │   ├── sandbox-env.ts           # 声明式沙箱环境 + 企业能力接缝
    │   ├── role-inject.ts           # 角色注入（before_agent_start → addendum 段）
    │   ├── agent-teams.ts           # 团队编排（create / dispatch / status）
    │   ├── agent-memory.ts          # 长期记忆（store / recall）
    │   ├── agent-skill-pool.ts      # 技能池（publish / list / install）
    │   ├── agent-browser-session.ts # 浏览器会话（open / fetch / screenshot）
    │   ├── agent-codebase.ts        # 代码库索引（index / status）
    │   ├── agent-guard.ts           # 工具守卫（bash 命令拦截）
    │   ├── agent-tool-gate.ts       # 硬审批（ctx.ui.confirm → 前端批准横幅）
    │   └── agent-mcp-bridge.ts      # MCP 桥接（mcp__ 工具转发）
    ├── capabilities/
    │   └── default.json             # Tauri ACL（Tauri 原生权限机制）
    └── src/
        ├── mcp.rs                   # MCP Gateway
        ├── agent_ops.rs             # 运行层状态读写（与 extension 共根）
        ├── roles.rs                 # 专家角色注册表（内置 + 用户 md + 切换落盘）
        ├── skills.rs                # SKILL.md 解析 / 扫描 / 安装 + 内核 get_commands 合并
        ├── tools.rs                 # defaultTools 白名单注入 / 取回 / 可选集
        ├── models.rs                # 模型配置 → 内核启动参数
        ├── capabilities.rs          # pi-manifest.json 加载与校验
        ├── pi_bridge.rs             # Pi RPC 桥（启动 / 复用 / 重启 / 注入内置 extension）
        ├── fs.rs / terminal.rs / projects.rs / state.rs
        └── pi-manifest.json         # 能力清单单一真源（含扩展清单）
```
