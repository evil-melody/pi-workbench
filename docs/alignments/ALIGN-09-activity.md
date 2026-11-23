# 参考实现 版式对齐 —— 09 轨迹（activity）与工作流（workflow）

> 完成度：**左栏补齐「轨迹 / 工作流」两 tab，中栏接入活动条**。
> 当前为**降级投影**：后端 `pi://event` 尚未暴露 参考实现 activity 插件所需的细粒度事件。

## 1. 对照来源

| 参考实现 源文件 | 作用 | 本项目落地 |
|---|---|---|
| `packages/plugins/activity/src/projection.ts` | 事件 → 活动状态投影 | `src/composables/useActivity.ts`（降级版） |
| `packages/plugins/activity/src/registry.ts` | 事件类型注册表 | `src/components/chat/ActivityPanel.vue` 事件清单 |
| `packages/plugins/activity/src/styles.ts` | 活动条视觉（状态点、渐变描边、展开详情） | `src/components/chat/ActivityBar.vue` + `.css` |
| `BusinessPanel.tsx` / `TaskExecutionNotice.tsx` | 左栏 tab 与执行提示 | `src/views/ChatView.vue` 左栏 4 tab |

## 2. 版式改动

| 元素 | 之前 | 现在 |
|---|---|---|
| 左栏 tab | 文件 / 会话树（2 项） | 文件 / 会话树 / **轨迹** / **工作流**（4 项，`white-space: nowrap` 防挤压） |
| 左栏宽度 | 260px | 296px（容纳 4 项） |
| 左栏 body | FileTree \| SessionTree | FileTree \| SessionTree \| ActivityPanel \| WorkflowPanel |
| 中栏 | 头 + 消息 + composer | 新增 `.activity-dock`，在 composer 上方渲染 `ActivityBar`（非 idle 时显示，带 `dock-in` 入场动画） |

## 3. 修改 / 新增文件

新增：

- `src/composables/useActivity.ts` —— 活动状态投影 + `activityMessage()` 文案映射
- `src/components/chat/ActivityBar.vue` / `.css` —— 活动条（头像 + eyebrow/action 两行 + 状态点 + 展开详情）
- `src/components/chat/ActivityPanel.vue` / `.css` —— 轨迹面板（状态卡 + 6 类事件清单 + 降级说明）
- `src/components/chat/WorkflowPanel.vue` / `.css` —— 工作流面板（阶段清单 + 进度 + 重置）

修改：

- `src/views/ChatView.vue` —— 左栏 4 tab + 4 分支渲染；中栏挂 `ActivityBar`；引入 `useActivity`
- `src/views/ChatView.css` —— `.left` 296px、`.left-tabs button` 收紧、`.activity-dock` + `@keyframes dock-in`
- `src/components/chat/WorkflowPanel.vue` —— 由静态示例改为**跟随活动状态投影的进度**（`working`→2/4、`failed`→3/4、`completed`→4/4、idle→0/4），并加 `.active` 高亮与重置按钮
- `src/components/ui/AppIcon.vue` —— 补充 `activity` / `check` / `close` / `refresh` 图标

## 4. 后端逻辑与事件缺口（关键）

参考实现 的 activity 依赖 6 类事件：

```
turn/start · tool/call · tool/result · subagent/catalog · deliverables/presented · turn/end
```

当前 Pi 内核经 `pi://event` 只推送 3 类：

```
message_update · agent_settled · process_exit
```

因此 `useActivity.ts` 采用降级投影：

| 输入 | 推导相位 |
|---|---|
| `streaming === true` | `working`（附带最近 tool） |
| 末条 assistant 文本含 `error` / `失败` / `错误` | `failed` |
| 有 assistant 消息且非流式 | `completed`（按 ``` 或「文件/保存」判定 `delivered`） |
| 其余 | `idle` |

`ActivityPanel` 与 `WorkflowPanel` 均在 UI 内明示「降级展示」，避免把推测当真实轨迹。

**补齐路径**：在 Rust 侧 `pi://event` 增加 `turn/start` / `tool/call` / `tool/result` / `turn/end` 后，
`useActivity.ts` 可整体替换为 `projection.ts` 的真实实现，UI 组件无需改动。

## 5. 与 Pi 的融合

- 活动条是 Pi 会话的「运行态仪表」——把内核是否在跑、跑的哪个工具、是否交付成果，变成可见信息。
- 工作流面板复用 Pi 的编码闭环（理解 → 改码 → 验证 → 交付），与 `TaskExecutionNotice` 语义一致。
- 待 Pi 侧 `上游待办事件类型` 类任务事件落地后，`WorkflowPanel` 由投影驱动切为真实任务流。

## 6. 中断能力（pi_stop 接线）

活动条在 `running === true` 时显示「中断」按钮（方形图标 + 文案）：

```
ActivityBar @interrupt → ChatView.abort() → interrupt() + pi_stop
```

- `interrupt()` 先把相位钉在 `interrupted`（`delivered: true`），再下发 `pi_stop`
- `manualHold` 标志保证：内核回 `process_exit`（`streaming` true→false）或新一轮启动（`streaming` 回 true）才交还自动投影
- 否则中断态会被 `agent_settled` 立刻覆盖成 `completed`，用户看不到反馈

## 7. 完成度清单

- [x] 左栏 4 tab（文件 / 会话树 / 轨迹 / 工作流）
- [x] 活动条渲染在非 idle 相位（working / completed / failed）
- [x] 活动条展开详情（相位、工具、技能、子代理）
- [x] 轨迹面板事件清单与降级说明
- [x] 工作流面板进度随活动状态联动 + 重置
- [x] 图标补齐（activity / check / close / refresh）
- [ ] `pi://event` 补齐 `turn/start` / `tool/call` / `tool/result` / `subagent/catalog` / `deliverables/presented` / `turn/end`
- [x] 中断按钮接入活动条，接 `pi_stop`，`interrupted` 相位真实可用
- [ ] `waiting` 相位（需内核推送「等待用户确认」事件）
- [ ] 工作流接真实 todo 数据源

## 8. 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm build` | ✅ 120 modules，CSS 61.07 kB / JS 195.22 kB |
| `pnpm vitest run` | ✅ 33 passed（sessionTree 10 + piEvents 15 + **useActivity 8**） |
| `pnpm check:matrix` | ✅ 31 技能 + 2 扩展 |

新增 `tests/useActivity.spec.ts`（8 例），覆盖 idle / working / completed+delivered /
completed 无产物 / failed / interrupt 即时置位 / 中断后回 process_exit 仍保持 / 中断后新一轮交还投影。
其中「中断后下发新任务」一例在最初实现下**成功捕获缺陷**（详见下条），符合 RED 验证流程。

### 修复的真实缺陷

写测试时发现 `useActivity.ts` 第 73 行写成 `if (streaming)`，而 `streaming` 的形参类型是
`MaybeRefOrGetter<boolean>`（组件里传的是 `Ref`）。Ref 是对象，`if (Ref)` **恒为 true**，
导致所有分支都被 `working` 吃掉 —— 空会话显示「正在执行」、已完结消息显示「正在执行」。
修复：统一走 `toValue(streaming)`，并在同一 watch 内处理 `manualHold` 的解除条件。
