# 全球化（i18n）设计 · 2026-11-06

> 范围：界面与系统文案的国际化（中文 / 英文）。
> 明确排除：商业化、多租户、计费、配额、多币种、汇率。
> 本文只做设计，不含代码改动。

---

## 0. 结论摘要

- 现状是**纯中文硬编码**：产品范围（前端 + Rust 非测试 + 扩展）共 **1,922 处**含中文的字面量与模板文本，去重 **1,633 条**，约 **3.6 万中文字符**。没有任何 i18n 运行时（`package.json` 无 vue-i18n / i18next），`index.html` 写死 `lang="zh-CN"`。
- 后端已预留 `AppSettings.language` 字段（`src-tauri/src/models.rs:80`），但**没有读取、没有 UI、没有落盘同步**——这是最省事的一个既有接缝。
- 词条用**中文原文作 key**（gettext 式），不新造 `chat.composer.send` 这类语义 key，从根上避免「key 变成第二套谜语」。只有极少数同字不同义的词条加显式上下文后缀。
- 前端 1,411 处里 **590 是模板文本、241 是属性文案（title/placeholder/aria-label）、580 是脚本字符串**，其中 **281 条带插值**。这部分是主体工作量，但结构统一，可脚本化抽取。
- 后端 548 条中文里 **231 条是 `#[cfg(test)]` 里的断言消息**，不参与翻译；生产代码 **317 条**，其中约 160–205 处是 IPC 错误返回。建议**错误码化**，而不是把中文错误串整体翻译。
- 托盘只有 **4 个菜单项 + 约 8 条状态行文案**，通知只有 **2 个标题模板**（`任务完成 · {title}` / `任务失败 · {title}`），后端本地化成本很低；但 `TrayHandles` 目前只持有 status / pause 两个句柄，切语言要补句柄重建。
- 扩展 194 条里 **73 条是给模型看的工具描述**（不该翻译，翻译会改变模型行为与 token），其余才是用户可见结果/报错。
- 粗略成本：**完整做到中英双语 18–24 人日**；**只做前端 + 托盘/通知、后端错误延后 10–13 人日**。
- 建议明确不做：RTL、第三方翻译平台接入、内核（Pi CLI）自身输出的翻译、模型提示词本地化。

---

## 1. 现状盘点（真实数字）

### 1.1 统计口径

用 AST 邻近的文本模式统计（脚本见附录 A）：

- `.vue` 分成 `<template>` 与 `<script>`；模板只统计**文本节点**与**含中文的属性值**，注释剔除。
- `.ts` / `.rs` 只统计**字符串字面量**，`//`、`/* */`、`<!-- -->` 注释剔除。
- `.rs` 剔除 `#[cfg(test)]` 之后的测试断言。
- `scripts/` 是开发工具，不计入产品文案。
- 「处」= 出现次数；「条」= 去重后的文案。

### 1.2 总量

| 区域 | 处 | 去重 | 说明 |
|---|---:|---:|---|
| 前端·视图 `src/views`（12 文件） | 623 | 548 | ProjectWorkspace / SettingsView / InboxView 各约 80 |
| 前端·组件 `src/components`（40 文件） | 548 | 486 | LibraryPanel 92、ExpertDraftEditor 63、ConnectorPanel 39 |
| 前端·逻辑 `src` 其余（52 文件） | 240 | 217 | piEventKind 47、useLibrary 26、useConnectors 25 |
| 后端 `src-tauri/src`（33 文件，非测试） | 317 | 274 | 原始 548，测试断言 231 剔除；4,968 字符 |
| 扩展 `src-tauri/extensions`（10 文件） | 194 | 189 | 73 条为模型侧工具描述 |
| **产品合计** | **1,922** | **1,633** | 约 3.6 万中文字符 |

前端细分（合计 1,411 处 / 1,200 去重 / 22,512 中文字符）：

| 形态 | 处 | 备注 |
|---|---:|---|
| 模板文本节点 | 590 | 含 `{{ }}` 插值 |
| 属性文案 | 241 | `title` 132、`placeholder` 55、`aria-label` 40、`label` 5、`options` 2、`alt` 1、`empty-text` 1 |
| 脚本字符串 | 580 | toast / 校验 / 空态 / 相对时间 / 事件标签 |

- 含插值的文案 **281 处（去重 275）**，是消息格式化的主要来源。
- 高频复用词：`取消` 29、`刷新` 9、`删除` 8、`保存` 7、`刚刚` 5、`检索` 5、`标准` 5、`重命名` 5。
- 平均 16 个中文字符/条，中位数 10；整句（带句读）439 条，占 16.2%。

### 1.3 后端分布（剔除测试后 317 条）

| 用途 | 数量 | 位置 |
|---|---:|---|
| IPC 错误消息 | ≈160–205 处 | 分布在 `experts.rs`、`pi_bridge.rs`、`library.rs`、`memory_store.rs`、`net.rs`、`skills.rs`、`codebase.rs` 等 |
| 内置项目模板（名称/描述/提示词） | 3 套 ≈10 条 | `projects.rs` |
| 托盘菜单 + 状态行 | 4 + ≈8 条 | `background.rs`、`proactive.rs::next_run_label` |
| 系统通知 | 2 个标题模板 | `proactive.rs:596,630` |
| 模型提示词 / 任务 prompt | ≈16 条 | `proactive.rs::job_prompt`、`memory_vec.rs` 等 |
| 解析别名 / 枚举关键字 | 22 条 | 如 `"偏好" | "禁忌"` 映射，不面向用户 |
| 仅日志 | 9 条 | `println!` / `eprintln!` / `log::` |

关键事实：

- `#[tauri::command]` 共 **141 个**，其中 **113 个**返回 `Result<_, String>`——错误串会经 `describeIpcError()` 拼成「保存设置失败：<原始中文>」直接显示在界面上（`src/composables/useRuntime.ts:27`）。**后端中文错误是用户可见的**。
- 托盘 `TrayHandles` 只保存 `status`（状态行）与 `pause`（暂停勾选）两个句柄，`open` / `quit` 文案是建菜单时一次性写入的，切换语言时无法原地更新。
- 通知的 `title`/`body` 在 Rust 里拼装（`任务完成 · {job.title}`），语言只能在发送时决定。

### 1.4 扩展文案

- 194 处 / 189 条 / 9,166 中文字符。
- 73 条是 `description` / 参数描述（模型侧）；约 35 条是用户可见报错（如 `抓取失败：…`）；其余是工具返回值里的提示与截断标记。
- 这些文件由 Pi 内核直接加载执行，不经过前端打包，**不能直接用前端的 `t()`**。

### 1.5 其他硬编码点

| 位置 | 现状 | 影响 |
|---|---|---|
| `index.html` | `lang="zh-CN"` | 首屏语义语言固定 |
| `tauri.conf.json` | `title: "Pi Workbench"` | 已是英文品牌名，无需处理 |
| `src/utils/timeAgo.ts` | `刚刚` / `N分钟前` / `N天前`，自写 | 英文需要 `N min ago` 分支 |
| `src/utils/timeAgo.ts::fmtClock` | `M月D日` / `YYYY年` | 英文需要月份名或 `MMM D` |
| `ProjectWorkspace.vue:348` | `toLocaleString('zh-CN', { hour12: false })` | 写死 locale |
| `BrowserView.vue:27`、`ProjectsView.vue:215`、`MemoryView.vue:134` | `toLocaleString()` 无 locale 参数 | 跟随系统，可能中英混排 |
| `UsageCard.vue:116-117` | `余额 ¥`、`今日 ¥` | 货币符号硬编码；本次不做多币种，只做文案 |
| 多处 `toFixed()` | 数字小数分隔符不随 locale | 英语区用户看到 `1.00` 尚可，但 `toLocaleString` 更一致 |

---

## 2. 抽取方案

### 2.1 运行时机制

| 方案 | 优点 | 代价 | 结论 |
|---|---|---|---|
| **vue-i18n v11（推荐）** | 成熟的消息编译、插值、复数、`Intl` 数字/日期格式化、缺省回退、按 locale 懒加载 | 新增 1 个依赖；需约定 key 策略 | ✅ 采用 runtime-only 构建，不用 bundler plugin |
| 自写 40 行 `t()` | 零依赖 | 复数、回退、嵌套、格式化全要自己补；英文单复数会立刻踩坑 | 备选，只在禁止新增依赖时用 |
| 编译期宏 / 提取到 JSON | 构建期校验 | 与 Vite + Tauri 双端构建链耦合，收益不足以抵消复杂度 | ❌ |

推荐 vue-i18n 的理由只有一条：本项目要处理 **281 处插值 + 英文单复数 + 运行时切换**，这三件事正是它存在的理由；自写实现会把复杂度转移到每个调用点。

### 2.2 词条组织：中文原文作 key

```ts
// 组件里
{{ t('取消') }}
{{ t('{n} 分钟前', { n }) }}
:title="t('刷新')"
:placeholder="t('给 Pi 下达编码任务…（可附带图片或文件）')"
```

- **不新造语义 key**。中文原文就是 key，也是 `zh-CN` 的显示值；`en-US` 包是「中文 → 英文」映射。
- 优点：任何人在代码里搜中文就能找到词条；漏翻时天然回退到中文；不会出现 `chat.send.btn.title` 这种没人能读的二级谜语。
- 代价与对策：
  - **同字不同义**（如 `打开` 作动词 vs 菜单项）：仅这类词条加后缀 `t('打开@menu')`，渲染时去掉 `@` 之后的部分。预计 < 20 条。
  - **改文案即失效**：中文一改，旧英文变孤儿。由覆盖率脚本列出「已失效词条」，强制同步。
  - **长句作 key**：可读性差但可 grep；长句集中在少数页面（Inbox / Memory / Experts），可接受。
- 文件组织：按领域拆包，避免单文件超 2000 行铁律：

```
src/i18n/
  index.ts            # createI18n、locale 解析、t 导出
  zh-CN/
    common.ts         # 取消/保存/删除/刷新…
    chat.ts           # ChatView、消息、过程抽屉
    library.ts        # 资料库、文件
    projects.ts       # 项目、工作台
    settings.ts       # 设置、模型、能力
    memory.ts         # 记忆、收件箱
    experiments.ts    # 浏览器、团队、技能池
  en-US/              # 与 zh-CN 同构
  format.ts           # 日期/数字/相对时间
```

- 每个领域包导出扁平的 `Record<string, string>`，`index.ts` 合并；中文包是**唯一事实源**，英文包缺项即回退。

### 2.3 非页面文案

#### a) 后端错误（141 个命令 / 113 个 `Result<_, String>`）

不翻译中文串，改成**稳定错误码 + 参数**：

```rust
#[derive(Serialize)]
pub struct IpcError {
    pub code: String,             // "library/file-too-large"
    pub params: serde_json::Value, // { "limit": 64 }
    pub detail: String,           // 原中文，仅日志/兜底
}
```

- 前端 `describeIpcError` 优先用 `t('err.' + code, params)`，查不到才显示 `detail`。
- 迁移策略：**只改命令边界**（141 个 `#[tauri::command]`），内部函数继续 `Result<_, String>`，在 `?` 处包一层 `IpcError::from_detail`。这样 113 个签名是机械改动，不需要重写 160+ 个错误点。
- 分两批：热点命令先做（projects / library / memory / experts / capabilities / settings / pi_bridge），其余保留 `detail` 回退，覆盖率脚本跟踪。

#### b) 托盘（4 菜单项 + 8 状态行）

- `TrayHandles` 增加 `open` / `quit` / `tooltip` 句柄（现在只有 status / pause）。
- 语言切换时调用新增命令 `tray_relocalize`：对 4 个 `MenuItem` 逐个 `set_text()`，状态行重算，tooltip 同步。**不重建托盘**，避免图标闪烁与菜单收起。
- 状态行的相对时间（`约 N 分钟后`）继续用 Rust 侧小目录（8 条），因为它在后端刷新，跨 IPC 取文案反而更脆。

#### c) 系统通知（2 个标题模板 + job 标题）

- 标题模板走 Rust 侧同一份小目录；`job.title` 是用户数据，不翻译。
- 语言在**发送时**从 `AppSettings.language` 读取，不缓存在长生命周期结构里。

#### d) 扩展提示（194 条）

分两类处理：

1. **模型侧**（73 条工具 `description` / 参数描述）：**不翻译**。它们进入模型上下文，翻译会改变行为、增加 token，且与 UI 语言无关。
2. **用户可见结果/报错**（约 35 条 + 返回值提示）：扩展由内核直接加载，方案是注入环境变量 `PI_WORKBENCH_LANG`，扩展内置一个 20 行的 `msg()` 帮助函数读取它。**建议放到第二阶段**，一期接受「英文界面下工具输出仍为中文」这一已知缺口，并在文档标注。

### 2.4 抽取与校验工具链

沿用仓库已有的 `scripts/check-*.mjs` 习惯，新增两个脚本（设计，不在本次实现）：

- `scripts/i18n-extract.mjs`：扫描 `src/**`，输出候选词条清单（中文 + 所在文件 + 是否有插值），用于生成 `en-US` 空壳与人工翻译工单。
- `scripts/i18n-check.mjs`：
  - 组件/视图里出现 CJK 字面量 → 报错（`src/i18n/` 与注释、测试除外）。
  - `en-US` 缺项 / 多余项 / 与 `zh-CN` 不同构 → 报错。
  - 输出覆盖率：`by namespace: 已翻 / 总数`。
- 挂到 `pnpm check:matrix` 或单独 `pnpm check:i18n`，作为 CI 门禁；一期只在 `en-US` 完整度达标后开启 CJK 报错，避免大面积红。

---

## 3. 语言与区域设置

### 3.1 语言如何确定

优先级：

1. **显式设置** `AppSettings.language`（`settings.json`，后端权威）。
2. **系统语言**：`navigator.language`（前端首屏）+ Tauri 侧系统 locale（后端托盘/通知兜底）。
3. **默认 `zh-CN`**。

首屏避免闪烁：

- `index.html` 里加一段内联脚本，读 `localStorage['pi-workbench:lang']`（theme 已用同款模式，`src/theme.ts:10`），在应用挂载前写 `<html lang>` 并标记 locale。
- `settings.json` 仍是权威；localStorage 只是首屏缓存，启动后 `settings_load` 回来再校正一次。

设置页：`SettingsView` 增加「语言」一栏（跟随系统 / 简体中文 / English）。`settings_save` 目前只回写 `models` / `default_model_id` / `pi_bin`，**新增 language 前必须改为整包回写或后端 merge**，否则保存设置会清空语言。

### 3.2 切换后哪些要重载

| 对象 | 是否重载 | 方式 |
|---|---|---|
| 前端界面 | 否 | vue-i18n `locale.value` 热切换 |
| 窗口标题 / `<html lang>` | 否 | 切换时同步写 |
| 托盘菜单 | 否 | `tray_relocalize`：`set_text()` + 状态行重算 |
| 系统通知 | 否 | 发送时读当前 locale |
| Pi 内核 | **不需要重启** | 内核不持有 UI 语言；除非后续本地化扩展输出，才需要重拉扩展（届时单独评估） |
| 已生成的对话内容 | 不重译 | 历史消息保持原样，属数据不是文案 |

### 3.3 日期 / 时间 / 数字 / 时区

- **日期时间**：统一 `Intl.DateTimeFormat(locale, …)`。`ProjectWorkspace` 的 `'zh-CN'` 硬编码改为当前 locale；`hour12` 跟随 locale 默认（zh 24 小时、en-US 12 小时）。
- **相对时间**（`刚刚` / `N 分钟前`）：保留现有自写函数，改为查词条（`{n}分钟前` → `{n} min ago`）。不用 `Intl.RelativeTimeFormat`，因为它会改变现有中文措辞（`5 分钟前` vs `5分钟前`），造成视觉回归。
- **数字**：大数缩写（`1.2k` / `$0.0042`）与字节单位（`KiB` / `MiB`）保持二进制单位，小数分隔符走 `Intl.NumberFormat`。`¥` / `$` 符号是数据来源的一部分，本次不引入多币种。
- **时区**：全部按设备本地时区显示，不提供时区选择器。仅在诊断类界面（如果有）显示 `Intl.DateTimeFormat().resolvedOptions().timeZone`，避免用户对「几点」产生歧义。
- **排序/搜索**：中文列表排序目前按后端返回顺序，不做 `Intl.Collator` 改造（不在本期范围）。

---

## 4. 增量与回退

- **回退顺序**：`en-US` 缺失 → 显示 `zh-CN` 原文 → 开发模式下 `console.warn` 一次（不显示 raw key）。用户永远看不到 `chat.send.title` 这类字符串。
- **覆盖率**：`scripts/i18n-check.mjs` 按命名空间输出 `已翻/总数`，并列出：
  - 缺失项（en 缺、zh 有）
  - 孤儿项（en 有、zh 已改/删）
  - 疑似未抽取（源码含 CJK 但不在 i18n 包）
- **防「半截英文」**：
  1. 所有用户可见文案必须走 `t()`，CJK 门禁脚本兜底。
  2. 属性文案（title / placeholder / aria-label）单独列入检查，避免只翻正文漏掉悬浮提示。
  3. 后端错误统一错误码，禁止把中文 `detail` 当主文案直接展示。
  4. 英文包按命名空间完整度分批放行：某个页面 100% 才在 UI 上暴露英文入口。
- **版本演进**：中文原文即 key，改文案等价于改 key；覆盖率脚本负责列出失效翻译，翻译工单随之更新。

---

## 5. 明确不做

| 项 | 结论 | 理由 |
|---|---|---|
| RTL（阿拉伯语/希伯来语） | **不做** | 现有 CSS 大量 `left/right` 与固定宽度；真要支持需整轮逻辑属性改造，与中英双语无关 |
| 第三方翻译服务（Crowdin / DeepL / Lokalise） | **不接** | 1,633 条、两种语言，本地 JSON + LLM 初翻 + 人工校对足够；接平台反而增加账号/流程成本 |
| 多币种 / 汇率 / 计费 / 配额 | **不做** | 已明确砍掉 |
| Pi 内核（外部 CLI）自身输出翻译 | **不做** | 第三方进程，不在控制范围；其输出按原样展示 |
| 模型提示词 / 工具描述本地化 | **不做**（一期） | 属模型行为参数，不是 UI 文案；翻译会改变行为与 token |
| 文档 / README 翻译 | **不做** | 面向开发者，非产品界面 |
| 语言包热更新 / 远程下发 | **不做** | 桌面应用随包发布即可 |

---

## 6. 成本评估（人日）

| 阶段 | 内容 | 人日 |
|---|---|---:|
| P0 前置 | IPC 错误结构体 + `describeIpcError` 改造；`settings_save` 整包回写；locale 首屏缓存；`TrayHandles` 补句柄 | 3–4 |
| P1 前端基建 | vue-i18n 接入、按领域拆包、语言设置 UI、`format.ts`、切换与 `<html lang>`/标题同步 | 2–3 |
| P2 前端抽取 + 翻译 | 1,411 处 / 1,200 条 / 2.25 万字符；脚本抽取 + LLM 初翻 + 人工校对 | 下详 |
| P3 后端错误码 | 113 个命令签名机械改造；热点命令错误码映射；Rust 文案目录（托盘/通知） | 4–5 |
| P4 扩展提示 | 73 条模型侧不动；约 35 条用户可见结果 + 提示走 `PI_WORKBENCH_LANG` | 1–2 |
| P5 验证 | 中英双语走查、窄窗/长文案回归、覆盖率门禁、托盘与通知实测 | 3 |
| **合计（完整）** | | **18–24** |

翻译量估算：1,200 条前端 + ≈280 条后端 + 189 条扩展 ≈ **1,650 条 / 3.6 万字符**。按 LLM 初翻 + 人工逐条校对 150–250 条/人日，约 **7–11 人日**（已含在 P2 内）。

**最小可用（英文 UI alpha）**：P0 + P1 + 前端 P2 + 托盘/通知 → **10–13 人日**；后端错误与扩展输出保留中文兜底。

### 必须先做的前置改动

1. `settings_save` 整包语义修正（当前只回写三个字段，新增语言会被覆盖）。
2. `describeIpcError` 支持结构化错误（否则后端错误无法本地化）。
3. `TrayHandles` 补齐 open / quit / tooltip 句柄（否则切语言托盘文案不变）。
4. `index.html` 首屏 locale 注入（否则英文用户首帧闪中文）。
5. 抽取/校验脚本先落地（否则 1,400 处手工找漏，后期成本翻倍）。

---

## 7. 需要拍板的点

| # | 问题 | 建议 | 备选 |
|---|---|---|---|
| 1 | 用 vue-i18n 还是自写 `t()` | **vue-i18n**（插值/复数/回退成熟） | 零依赖自写，需自建复数与回退 |
| 2 | 词条 key 用中文原文还是语义 key | **中文原文作 key** + 极少数 `@context` 后缀 | 语义 key，需额外出维护文档 |
| 3 | 后端错误是否全量错误码化 | **先热点命令（约 60% 用户可见错误）**，其余保留中文 detail | 一次性 113 个命令全改，+3 人日 |
| 4 | 默认语言 | **跟随系统**，系统非中文时默认 en-US，否则 zh-CN | 默认 zh-CN，英文需手动切 |
| 5 | 扩展用户可见输出是否一期覆盖 | **一期不覆盖**，标注已知缺口 | 一期覆盖，+1–2 人日，且需内核重启扩展 |
| 6 | 切换语言是否重启内核 | **不重启** | 若本地化扩展输出则需重启 |
| 7 | 英文相对时间措辞 | 保留现有结构（`5 min ago`） | `Intl.RelativeTimeFormat`（措辞会变） |
| 8 | RTL / 第三方翻译平台 | **都不做** | 后续单独立项 |

---

## 附录 A：统计方法

- 遍历 `src/`、`src-tauri/src/`、`src-tauri/extensions/`，按扩展名解析：
  - `.vue`：`<template>` 文本节点 + 含中文属性值 + `<script>` 字符串字面量。
  - `.ts` / `.rs`：剔除注释后的字符串字面量。
  - `.rs`：剔除 `#[cfg(test)]` 之后的断言消息。
- 排除 `scripts/`（开发工具）、`node_modules`、`target`、`dist`。
- 插值统计：字符串中含 `{{` 或 `${`。
- 口径为「出现次数」与「去重文案数」，两者分别列出，避免用去重数低估改造点。

## 附录 B：关键文件索引

| 文件 | 作用 |
|---|---|
| `src/components/chat/TraceDrawer.vue` | 过程抽屉，4 个标签，窄窗溢出样本 |
| `src/composables/useRuntime.ts:27` | `describeIpcError`，后端错误展示唯一口径 |
| `src/utils/timeAgo.ts` | 相对时间与时钟格式，中文写死 |
| `src/utils/piEventKind.ts` | 47 条事件标签 |
| `src-tauri/src/models.rs:74-85` | `AppSettings`，已有 `language` 字段 |
| `src-tauri/src/background.rs:145-180` | 托盘菜单与句柄 |
| `src-tauri/src/proactive.rs:213-232,518-519,596,630` | 托盘状态行、通知 |
| `src-tauri/src/projects.rs:77-90` | 内置项目模板 |
| `src-tauri/extensions/*.ts` | 扩展工具描述与结果文案 |
