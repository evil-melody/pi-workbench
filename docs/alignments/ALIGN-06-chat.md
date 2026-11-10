# 参考实现 版式对齐 —— 06 会话页

> 完成度：**右侧边栏与消息列表版式已对齐**；智能体浏览器为占位，输入框已改为底部圆角输入条。

## 1. 版式对照

| 元素 | 参考实现 版式 | 本页落地 |
|---|---|---|
| 左侧栏 | 文件 / 会话树 tab | 一致 |
| 消息列表 | 用户右对齐气泡、助手左侧头像、代码块卡片 | 一致 |
| 输入框 | 底部圆角输入条 + 发送按钮 | 一致 |
| 右侧边栏 | 智能体浏览器 / 文件 / 终端 tab | 一致；智能体浏览器占位 |

## 2. 修改文件

- `src/views/ChatView.vue`：重构右侧边栏 tab，加入「智能体浏览器」占位，输入框改用 AppTextarea。
- `src/views/ChatView.css`：调整三栏比例、composer 样式、右侧边栏样式。
- `src/components/chat/MessageList.vue`：增加头像、区分用户/助手/系统消息。
- `src/components/chat/MessageList.css`：用户消息气泡、助手消息左侧布局、空态。

## 3. 后端逻辑

复用已有 Pi 命令：

```rust
pi_start / pi_call / pi_send / pi_stop   // 对话核心
role_current / role_set                   // 角色注入
project_active / projects_list            // 确定 cwd
fs_read_file / fs_write_file              // 右侧文件编辑
```

智能体浏览器后续需要：
- Pi 在调用浏览器工具时通过 `pi://event` 推送页面快照/URL
- 前端把快照渲染到右侧浏览器面板（可复用 `browser-session` provider 思路）

## 4. 与 Pi 项目的融合

- 会话页是 Pi 的核心工作区；左侧文件树、右侧终端/文件编辑器、中间聊天形成「IDE 式」工作流。
- 右侧「智能体浏览器」与 Pi 的 browser-op 工具（未来能力）对接，让 agent 的网页操作可观测。

## 5. 完成度清单

- [x] 左侧文件/会话树切换
- [x] 消息列表头像与气泡
- [x] 底部圆角输入框 + 发送按钮
- [x] 右侧边栏 tab（智能体浏览器/文件/终端）
- [x] 文件编辑与保存
- [ ] 智能体浏览器真实渲染（需 Pi browser-op 事件）
- [ ] 任务执行通知浮层（TaskExecutionNotice）
- [ ] 消息附件/引用文件

## 6. 验证

- `pnpm typecheck` ✅
- `pnpm build` ✅
