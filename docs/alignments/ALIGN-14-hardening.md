# ALIGN-14 —— 全模块半成品清理与补齐

> 本轮不做版式重做，只做一件事：**把每个模块里的假开关、空壳按钮、假数据、僵尸代码全部过一遍并修掉**。
> 逐项给「改前是什么 / 改后是什么 / 证据」。

## 1. 逐模块审查结果

| 模块 | 改前状态（半成品） | 本轮处理 | 状态 |
|---|---|---|---|
| 左栏「工作流」 | 4 个硬编码阶段，`progress` 从活动相位反推，永远显示同样四步 | 改为解析 Pi 回复里的 markdown 复选框（`src/utils/todoList.ts`），显示真实任务清单；无清单时给空态提示而不是假四步 | ✅ |
| 左栏「会话树」 | `auto-refresh` 只是 onMounted 刷一次，后台继续写会话也看不到 | 15s 轮询，切走面板即停（onUnmounted + watch） | ✅ |
| 左栏「轨迹」 | 已接真实 `pi://event` | 未改动；note 明确说明「相位仍是流式状态的降级推断，细节以本列表为准」 | ✅ |
| 右栏「智能体浏览器」 | 「前往」只写一条留痕事件；「返回」按钮无任何行为；「适配切换」只改按钮文字；「回车/删除」是假动作 | 「前往」调 `browser_open` 真开系统浏览器；「返回」回退访问历史；适配切换改为真实紧凑行距；删除两个假按钮 | ✅ |
| 右栏「文件」面板 | 「保存」之外没有重载/复制路径/外部打开，改坏了无法回退 | 新增重载 / 复制路径 / 外部打开 / 脏标记提示 / 操作回执 | ✅ |
| 右栏「终端」 | 无 cwd、无执行态、无清屏、无历史 | 新增目录头、执行中指示、清空按钮、↑↓ 命令历史 | ✅ |
| 左栏「资料库」 | 4 个 tab 里 3 个是空壳：搜索等于 library、最近/输出没有内容 | 搜索=扁平匹配文件列表；最近=localStorage 最近打开；输出=localStorage 最近写入；预览换 AppTextarea 并加未保存标记 | ✅ |
| 侧边栏工作区 | 排序按钮跳 /projects（假）；「设置」跳项目页（假） | 排序切换真实生效；设置改为打开「关于」弹窗（版本/内核/外壳） | ✅ |
| 侧边栏余额 | 后端返回写死的数字（96.28 / 早场时段） | UI 加「演示」角标 + hover 说明「内核未接入计费接口」，不再假装是真实用量 | ✅ |
| 插件市场 | 「安装」「评论」无任何行为；主题/收藏/高级三个 tab 与发现页内容一样；「全部更新」「导出日志」是空壳 | 本地扩展行→启用/禁用（`tools_activate`）；市场行明确禁用并标注「示例数据」；主题/收藏给明确空态；「全部启用」真实生效；「导出日志」改为真实复制诊断信息；删除评论按钮 | ✅ |
| 能力中心 | 二级 tab「本地技能 / SkillHub」写死 active，点不动；卡片右上角安装按钮无行为；连接器和技能的 checkbox 用原生 `<input type=checkbox>` | 二级 tab 可切；SkillHub 给明确说明而非假列表；右上角改为技能卸载 / 连接器断开（均带二次确认）；全部原生 checkbox 换 `AppCheckbox` | ✅ |
| 后端技能 | 只有 install，没有 uninstall | 新增 `skills_uninstall`，只删 `<技能目录>/<name>/SKILL.md` 这一种形态 | ✅ |
| 僵尸代码 | `useSandbox.ts` 无任何消费者；`useSkills.skillsList`、`useArtifacts.scanning` 导出后无人使用 | 删除这三项 | ✅ |
| Rust 警告 | artifacts.rs 测试里 9 处多余分号 | 清理，`cargo test` 现 0 warning | ✅ |

## 2. 后端实现逻辑（新增/改动）

### 2.1 `src-tauri/src/browser.rs`（新增）

Pi 内核没有 browser session 能力，面板上的「前往」原本只能留痕。新增命令让它成为真实动作：

- `normalize_url(raw) -> Result<String,String>`
  - 显式带 scheme 时（含 `:`）只放行 `http://` / `https://`，其余（`javascript:` / `file:`）直接拒绝；
  - 不带 scheme 时补 `https://`；
  - 判 scheme 必须在补 `://` **之前**：否则 `javascript:x` 会被补成 `https://javascript:x` 绕过校验（这条是本轮测试先红后绿抓出来的）。
- `browser_open(url)`：按平台调默认处理器（macOS `open` / Windows `cmd /c start` / Linux `xdg-open`），结果只返回规范化后的 URL。
- 4 条单测覆盖补协议、保留显式协议、去空白、拒绝非 http(s)。

### 2.2 `src-tauri/src/skills.rs`（新增 `skills_uninstall`）

- 卸载目标与 `skills_install` 落盘位置严格对称：先项目级 `.pi/skills/<name>/SKILL.md`，再用户级 `<agent-dir>/skills/<name>/SKILL.md`；
- 名字含 `/`、`\`、`..`、空串 → 直接拒绝，避免路径穿越；
- 删完 `SKILL.md` 后目录**空了才删目录**，用户自己的东西留在里面；
- 只认这一种形态，手工放到别处的技能会被明确拒绝（错误信息里写明）；
- `needs_restart = true`：内核启动时才枚举技能目录。

### 2.3 `artifacts.rs` 警告清理

测试里 9 处 `let d = tmpproj("x");;` → `let d = tmpproj("x");`，`cargo test --lib` 已无 warning。

## 3. 与 Pi 内核的融合改造

1. **任务清单不再自造协议**：`上游待办事件类型` 是 参考实现 侧的类型，Pi 侧没有等价事件。因此复用内核**已经在输出里写过的** markdown 复选框，前端解析——面板内容随内核输出变化，而不是写死阶段。勾选只作用于当前视图，不回写，UI 里写明。
2. **浏览器能力边界写进 UI**：面板底部直接说明「没有内嵌 WebView，前往会用系统浏览器打开」。「前往」是真实动作（系统默认应用），返回只回退本面板访问记录，不做伪装。等内核具备 browser session 能力后再换内嵌页面。
3. **扩展启用/禁用复用 `tools_activate`**：`ExtensionInfo.enabled` 的定义就是「它的工具是否都在 settings.json 的 `defaultTools` 里」，所以 UI 不维护第二份开关状态，改的是同一处事实来源，不会出现两处各说各话。
4. **连接器断开复用已有的 `mcp_disconnect`**：命令本来就在，只是前端没接线，本轮接通。
5. **技能卸载对称安装**：装到哪卸到哪，作用域判定与 install 完全一致。

## 4. 验证证据

| 项 | 结果 |
|---|---|
| `npx vue-tsc --noEmit` | ✅ 无错误 |
| `npx vite build` | ✅ built in 6.28s，137 modules |
| `npx vitest run` | ✅ 7 files / **66 tests passed**（新增 `tests/todoList.spec.ts` 8 例，先 RED 后 GREEN） |
| `cargo test --lib` | ✅ **66 passed** / 0 failed，warning 0 |
| `npm run app:preflight` | ✅ pi 0.87.1、cargo 1.98.1、端口 1420 空闲 |
| `npm run check:matrix` | ✅ 技能清单 + 2 个扩展通过 |

> 注：`rtk` / `graphify` CLI 在本次会话中不可用（`command not found`），代码定位改用 Read/Grep 直接回退；`graphify update .` 未执行。

## 5. 本轮新增/修改文件

新增：`src/utils/todoList.ts`、`tests/todoList.spec.ts`、`src/version.ts`、`src-tauri/src/browser.rs`
删除：`src/composables/useSandbox.ts`
修改：`ChatView.vue/.css`、`WorkflowPanel.vue/.css`、`SessionTree.vue`、
`AgentBrowserPane.vue/.css`、`TerminalPanel.vue/.css`、`Sidebar.vue/.css`、`PluginsView.vue/.css`、
`CapabilitiesView.vue`、`LibraryPanel.vue/.css`、`useSkills.ts`、`useArtifacts.ts`、
`skills.rs`、`lib.rs`、`artifacts.rs`

## 6. 剩余项（下一轮）

1. SkillHub 远端市场 API（需 pi 内核或自建市场服务提供接口）
2. 社区市场安装链路（远端下载 + 落盘 + 注册）
3. 诊断面板（可选，原型无强对应页面）
4. Rust 侧 `sandbox.rs`（5 个命令 + `SandboxState`）已无前端消费者，可在确认不再需要后整体下线
5. `billing_status` 仍为写死值，等计费接口就绪后替换
