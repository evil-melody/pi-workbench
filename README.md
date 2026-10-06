# Pi Workbench

Tauri 2 + Vite + Vue 3 桌面工作台，以 [Pi](https://pi.dev)（极简 agent harness）的 **RPC 模式 + extension 插件** 作为唯一 Agent 内核。

> 定位：**以 Pi 为唯一内核**的渐进式 Agent 宿主 —— 工作台把「项目 / 资料库 / 专家 / 技能 / 连接器 / 团队 / 记忆」都做成可管理的一等公民，能力以 **Pi extension** 形式插件化接入，同时提供 **Rust 后端 + Vue 面板**，让同一份状态既是模型可调用的工具，也是人可直接管理的界面。

## 架构

```
Vue 工作区  ──invoke──>  Tauri(Rust)  ──stdio JSON──>  pi --mode rpc（微内核）
   │                          │                              │
   │                          ├─ mcp.rs        MCP Gateway（stdio JSON-RPC 客户端）
   │                          ├─ agent_ops.rs  运行层状态（团队 / 记忆 / 技能池 / 浏览器会话）
   │                          └─ fs / terminal / projects / library / connectors
   └──event<──────────────────┘   Pi 事件流（message_update / tool_call / agent_settled …）
```

- **Pi 内核**：Tauri 启动 `pi --mode rpc --no-session --extension <sandbox-env.ts> --extension <role-inject.ts> …`，扩展清单以 `capabilities.json#extensions` 为单一真源
- **Pi extension 层**：`src-tauri/extensions/` 下的 `sandbox-env.ts`（声明式沙箱接缝）、`role-inject.ts`（专家角色注入）、`agent-*.ts`（团队 / 记忆 / 技能池 / 浏览器会话）随内核激活
- **专家角色**：`role-inject.ts` 每轮把当前角色追加到 Pi 系统提示，角色由 `roles.rs` 管理（详见 [docs/roles.md](docs/roles.md)）
- **运行层状态**：`agent_ops.rs` 与 `agent-*.ts` 读写同一份 `.pi/<kind>/` 磁盘状态，人面与 agent 面一致
- **沙箱**：目前只有 extension 接缝 —— 由 `sandbox_list` / `sandbox_run` 两个 Pi 工具暴露给模型，读工作区 `.pi/sandboxes/<id>/`；无 Rust 侧沙箱模块，也没有对应面板。目录为空时工具如实报 0 个环境并退回宿主 PATH

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
```

> ⚠️ `npm i -g pi` 装到的是 `pi-number`（圆周率计算器，v2.0.5）。它同样会创建 `pi` 可执行文件，
> 但任何参数都只打印 `3` 就退出，且不支持 RPC —— 表现为「应用能启动、内核无反应」。
> 正确包：`@earendil-works/pi-coding-agent`。
>
> 引擎能力与分阶段路线见 [docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)；
> 产品结构与工程契约见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)；
> 运行层（团队 / 记忆 / 技能池 / 浏览器会话）见 [docs/AGENT-OPS.md](docs/AGENT-OPS.md)；
> 逐页功能与已知问题见 [docs/PAGE-FUNCTION-AUDIT.md](docs/PAGE-FUNCTION-AUDIT.md)。

## 主要功能

- **对话**：Pi RPC 流式输出，左侧「轨迹」面板按时间排列内核事件（工具调用 / 结果 / 轮次 / 退出），带计数徽标与自动贴底
- **项目**：卡片式项目列表，支持归档 / 绑定目录 / 预算与工作项；进入项目工作台后 Pi 以该项目目录为 cwd 启动
- **资料库**：资料库 / 搜索 / 最近 / 输出 / **记忆** 五个 tab；文本可预览与回写，二进制与 Office 预览未做
- **能力中心**：专家 / 技能 / 连接器 / **团队** / **技能池** / **浏览器** 六个 tab，前三个是能力市场，后三个是运行层面板
- **插件**：发现社区插件与本地安装入口
- **设置**：模型配置（多模型、可切默认、连通性自测）、工具激活（`defaultTools` 白名单）、关于

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

能力清单 `src-tauri/capabilities.json` 是这三块的单一真源，启动时加载并校验（含 `pi` 版本与清单钉住版本是否一致）。

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
- ✅ 能力清单 `capabilities.json` 加载与校验（含内核版本对齐），扩展清单是其唯一依据
- 🟡 沙箱：仅 Pi extension 工具接缝（`sandbox_list` / `sandbox_run`）；无 Rust 模块、无 UI 面板
- 🟡 Pi extension 插件层已接入（代码与语法校验通过；端到端加载待人工在 `pnpm tauri dev` 中确认）
- 🟡 资料库已接 fs（文本预览与回写），二进制 / Office 预览未做；技能安装需重启内核
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
    ├── extensions/
    │   ├── sandbox-env.ts           # 声明式沙箱环境 + 企业能力接缝
    │   ├── role-inject.ts           # 角色注入（before_agent_start → addendum 段）
    │   ├── agent-teams.ts           # 团队编排（create / dispatch / status）
    │   ├── agent-memory.ts          # 长期记忆（store / recall）
    │   ├── agent-skill-pool.ts      # 技能池（publish / list / install）
    │   └── agent-browser-session.ts # 浏览器会话（open / fetch / screenshot）
    └── src/
        ├── mcp.rs                   # MCP Gateway
        ├── agent_ops.rs             # 运行层状态读写（与 extension 共根）
        ├── roles.rs                 # 专家角色注册表（内置 + 用户 md + 切换落盘）
        ├── skills.rs                # SKILL.md 解析 / 扫描 / 安装 + 内核 get_commands 合并
        ├── tools.rs                 # defaultTools 白名单注入 / 取回 / 可选集
        ├── models.rs                # 模型配置 → 内核启动参数
        ├── capabilities.rs          # capabilities.json 加载与校验
        ├── pi_bridge.rs             # Pi RPC 桥（启动 / 复用 / 重启 / 注入内置 extension）
        ├── fs.rs / terminal.rs / projects.rs / state.rs
        └── capabilities.json        # 能力清单单一真源（含扩展清单）
```
