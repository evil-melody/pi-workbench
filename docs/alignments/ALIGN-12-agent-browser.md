# 12 · 智能体浏览器接真实事件流

> 对齐对象：`外部参考实现` 的 `AgentBrowserPage.tsx` / `BrowserSessionPane.tsx`（右侧「智能体浏览器」面板）
> 目标：把面板从**静态占位**改成**消费 `pi://event` 的真实事件流**

---

## 1. 现状与约束（不臆造能力）

| 项 | 实际情况 | 证据 |
|---|---|---|
| 内核事件通道 | 只有 `message_update` / `agent_settled` / `process_exit` 三类，桥**原样透传** | `src-tauri/src/pi_bridge.rs:81` `emit("pi://event", json)` |
| 浏览器会话能力 | 后端**无** `browser_open/type/back` 等命令，`src-tauri/src` 内无 `browser` 相关实现 | Grep `browser` 无命中 |
| 面板此前状态 | 地址栏 `setTimeout` 假 busy，viewport 恒为占位 | 旧 `AgentBrowserPane.vue` |

因此本次范围严格限定为：**事件流真正打通**；浏览器操作（打开/输入/回车）如实标注为「仅留痕」，不做假动作。

## 2. 方案：形状驱动的归一化

内核事件命名在不同版本间会变（`turn/start` vs `turn_start` vs `toolCall`）。硬编码事件名会导致内核一升级面板就失灵。

`src/utils/piEventKind.ts` 采用三级判定：

1. **事件名收敛**：小写 + 去 `_-/` 后查别名表（`turn/start`、`turn_start`、`turnStart` → `turn_start`）
2. **字段形状推断**：无匹配事件名时，按 `tool` / `status` / `args` / `output` 判断（`{ tool:'read', status:'started' }` → `tool_call`、`{ output:'...' }` → 结果类）
3. **unknown 兜底**：归入 `other` 并保留原始 `type`，不静默丢弃 —— 新事件能被看见，便于后续纳管

这一层是纯函数、不依赖 Tauri，可单测覆盖。

## 3. 新增/改动文件

| 文件 | 职责 |
|---|---|
| `src/utils/piEventKind.ts` | `classifyEvent(raw) → PiEventRow \| null`，归一化 + 截断详情 |
| `src/composables/usePiEvents.ts` | 独立订阅 `pi://event`，**定长环形缓冲**（默认 300）+ `stats` 统计 + `push/note/reset` |
| `src/components/chat/AgentBrowserPane.vue` / `.css` | 面板主体改写为事件时间线；保留 参考实现 的 header / 地址栏 / 底部输入版式 |
| `src/views/ChatView.vue` | 右栏传入 `:streaming="streaming"` |

**与 `usePi()` 分开订阅**：一个管消息列表，一个管轨迹面板，互不阻塞；缓冲定长，长跑不涨内存。

## 4. UI 行为

- header 左侧实时点：`streaming` 时高亮呼吸，右侧显示「N 次调用 · M 轮」
- 地址栏提交 → 记一条 `other` 留痕行（不伪装成浏览器导航）
- viewport：
  - 无事件且非流式 → 空态（monitor 图标 + 说明）
  - 无事件但流式 → 旋转图标「智能体正在执行…」
  - 有事件 → 时间线，左侧 2px 色条区分类别：轮次=accent、工具调用=warn、工具返回=ok、进程退出=danger
  - 流式中底部「执行中…」浮条
- 底部输入 / 回车 / 删除 → 留痕行
- hint 明确写出「当前内核尚无浏览器会话能力，地址与输入仅作留痕，实时部分来自 `pi://event`」

新事件到达后自动贴底滚动（watch + `nextTick`）。

## 5. 完成度

| 能力 | 状态 |
|---|---|
| 事件归一化（前向兼容） | ✅ |
| 事件流实时渲染 / 自动滚动 | ✅ |
| 统计（调用数、轮次数） | ✅ |
| 中断态联动（streaming 指示） | ✅ |
| 浏览器会话真实操作（打开 / 输入 / 回退） | ❌ 待后端 |
| `turn/start` / `tool/call` / `tool/result` 真实事件 | ❌ 待内核（本次已做消费端适配） |

## 6. 后端缺口（下一步）

真实智能体浏览器需要一条完整链路，当前全缺：

1. **细粒度事件**：`pi_bridge.rs` 目前只按「响应 / 事件」二分转发。内核若输出结构化事件，桥需补齐 `turn/start`、`tool/call`、`tool/result`、`turn/end` 的解析与透传（消费端已就绪，无需改前端）。
2. **浏览器会话命令**：新增 Tauri 命令 `browser_open(url)` / `browser_type(text)` / `browser_key(key)` / `browser_back()` / `browser_screenshot()`，内部接入 Playwright（Node 侧）或 Tauri WebView，再通过 `pi://event` 回推 `browser/navigated`、`browser/input` 事件。
3. **会话绑定**：浏览器会话需与 Pi 的当前 `cwd` 绑定，中断 `pi_stop` 时一并清理。

## 7. 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm build` | ✅ CSS 74.93 kB / JS 220.03 kB |
| `pnpm vitest run` | ✅ **55 passed**（新增 `piEventKind` 10 + `usePiEvents` 5） |
| `pnpm check:matrix` | ✅ 31 技能 + 2 扩展 |

测试修复的两个缺陷（写测试时暴露）：

1. `normType` 未去下划线 → `turn_start` 落不进别名表
2. 形状推断分支引用了未定义的 `detail` 变量
3. 首版测试自相矛盾（`process_exit` 同时断言 `null` 与 `exit`）—— 改为断言未识别标量返回 `null`

## 8. 后续建议

1. **P0** `pi_bridge.rs` 补细粒度事件透传（消费端已就绪）
2. **P1** 浏览器会话命令 + Playwright 内核
3. **P1** 把 09 号「轨迹」面板也改为消费同一缓冲，与浏览器面板共享事件源，避免两份逻辑
