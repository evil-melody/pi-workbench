# 参考实现 版式对齐 —— 10 首页 Hero（WorkBuddy 风格）

> 用户反馈：「首页这边这个还是不对吧。应该是跟 workbuddy 这边这样吧。」
> 截图显示 WorkBuddy 首页为大标题 + 分类 pill + 技能胶囊 + 中央大输入框的落地页。
> 本轮在 `/chat` 空态（无项目且无消息）时展示该 Hero；进入工作态后仍切回三栏 IDE。

## 1. 对照来源

| 来源 | 元素 | 本项目落地 |
|---|---|---|
| WorkBuddy 截图 | 大标题「WorkBuddy, 我帮你」 | `ChatHero.vue` 标题「Pi Workbench, 我帮你」 |
| WorkBuddy 截图 | 分类 pill（日常办公 / 代码开发 / 设计创意） | `ChatHero.vue` 三类切换 pill |
| WorkBuddy 截图 | 技能胶囊一排 | `ChatHero.vue` 每类 8 个技能 chip |
| WorkBuddy 截图 | 中央大输入框 + 发送 | `ChatHero.vue` 大输入框 + 圆角发送按钮 |
| WorkBuddy 截图 | 底部「选择工作空间」「默认权限」 | `ChatHero.vue` 底部两个字段 |
| Pi 自身 | 未选项目时无法对话 | Hero 态仍要求先选项目，输入框禁用并提示 |

## 2. 版式改动

| 元素 | 之前 | 现在 |
|---|---|---|
| `/chat` 空态 | 三栏工作台，中栏显示「向 Pi 下达编码任务」空状态 | 全屏 Hero：大标题 / 分类 pill / 技能胶囊 / 大输入框 / 底部工作空间选择 |
| `/chat` 工作态 | 三栏工作台 | 保持不变 |
| 左右侧边栏 | 始终显示 | Hero 态隐藏工作区侧边栏，保留全局 `Sidebar.vue` |
| 中栏背景 | `--bg`，带 border | Hero 态透明 + 装饰光晕；工作态不变 |

## 3. 修改 / 新增文件

新增：

- `src/components/chat/ChatHero.vue` —— Hero 落地页组件
- `src/components/chat/ChatHero.css` —— Hero 样式（光晕背景、分类 pill、技能 chip、大输入框、底部字段）

修改：

- `src/views/ChatView.vue` —— 新增 `showHero` 计算属性；Hero 态隐藏 `.left` / `.right`；中栏条件渲染 `ChatHero`；新增 `setActiveProject` 与 `submitHero`
- `src/views/ChatView.css` —— `.chat.hero` / `.center.hero` 去除 border 与背景

## 4. 交互逻辑

```
用户进入 /chat
    ↓
cwd === '' && messages.length === 0 && !streaming
    ↓
展示 ChatHero
    ↓
  ├─ 点击分类 pill → 切换 skills 列表
  ├─ 点击技能 chip → 把 skill 名称填入输入框
  ├─ 选择工作空间 → 调用 project_set_active + 更新 cwd
  └─ 输入并发送 → 如未选项目则提示；否则 pushUser + pi_send
```

## 5. 与 Pi 的融合

- Hero 不是独立新页面，而是 `/chat` 的**空态视图**。Pi 的「项目优先」模型不变：
  没有项目时输入框禁用，提示去「项目」页选择。
- 技能胶囊内容按 Pi 场景编排：
  - **代码开发**：代码生成 / 代码审查 / Bug 修复 / 重构 / 写测试 / 生成文档 / 解释代码 / 技术调研
  - **日常办公**：文档处理 / 会议纪要 / 邮件撰写 / 数据分析 / PPT 生成 / 表格处理 / 周报总结 / 知识整理
  - **设计创意**：UI 设计 / 图标生成 / 图片处理 / 配色方案 / 设计规范 / 原型生成 / 海报设计 / 插画建议
- 选择工作空间直接调用 Tauri `project_set_active`，与侧边栏项目列表一致。

## 6. 完成度清单

- [x] Hero 组件与样式
- [x] 大标题 + π logo
- [x] 三类分类 pill（代码开发 / 日常办公 / 设计创意）
- [x] 动态技能胶囊（每类 8 个）
- [x] 中央大输入框（禁用态 + 提示文案）
- [x] 底部「选择工作空间」下拉（真实项目列表）
- [x] 底部「默认权限」静态占位
- [x] `showHero` 条件切换
- [ ] 默认权限接入真实 role 列表（需 cwd 加载角色，当前 Hero 态无 cwd 时不展示）
- [ ] 技能胶囊点击后支持直接发送，而非仅填入输入框（可后续根据用户习惯调整）

## 7. 本轮美化增强（2026-09-27）

用户反馈：「再美化一下」「这个 Icon 也没生成」。

### 7.1 分类 pill 改成分段控制器

| 之前 | 现在 |
|---|---|
| 三个独立 outline pill，选中只改边框/背景 | 一个圆角轨道包裹三个 pill，选中项用渐变背景 + 投影 |
| 图标与文字同行 | 图标带圆角底色块，选中态反白 |
| 无 hover 动效 | hover 有背景高亮 + 轻微上浮 |

### 7.2 技能 chip 更精致

- 每个 chip 带 Lucide 图标前缀，与分类色调联动
- hover 时上浮 1px + 投影，点击时回弹

### 7.3 底部工作空间卡片化

- 「选择工作空间」「默认权限」由行内字段改为独立 cardlet
- 左侧带 34px 彩色图标块（工作空间蓝色 / 权限绿色）
- cardlet hover 轻微上浮，提升可点感

### 7.4 App 图标生成

- 发现 `src-tauri/icons/icon.png` 原为 1×1 黑色占位图（窗口 dock 显示黑块）
- 新增 `scripts/generate-icon.py`：用 Pillow 生成 1024×1024 π logo PNG
- 运行 `pnpm tauri icon src-tauri/icons/icon.png` 自动生成全套平台图标（icns / ico / Android / iOS / UWP）
- `tauri.conf.json` `bundle.icon` 从单 PNG 改为包含 `32x32.png` / `128x128.png` / `128x128@2x.png` / `icon.icns` / `icon.ico`

## 8. 修改文件清单

新增 / 修改：

- `scripts/generate-icon.py` —— 1024×1024 π logo 图标生成脚本
- `src-tauri/tauri.conf.json` —— `bundle.icon` 补齐多平台图标
- `src/components/chat/ChatHero.vue` —— 分段控制器、带图标的技能 chip、cardlet 底部
- `src/components/chat/ChatHero.css` —— 新版样式：轨道、渐变、光晕、动画、cardlet

## 9. 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm build` | ✅ 123 modules，CSS 68.08 kB / JS 199.71 kB |
| `pnpm vitest run` | ✅ 33 passed（sessionTree 10 + piEvents 15 + useActivity 8） |
| `pnpm check:matrix` | ✅ 31 技能 + 2 扩展 |
| `pnpm tauri icon` | ✅ 生成 icns / ico / Android / iOS / UWP 全套 |

## 10. 后续建议

1. **P1** 默认权限：Hero 态选定项目后，可在底部把「通用助手」改为真实 RoleSwitcher。
2. **P2** 技能胶囊支持一次性多选或「帮我规划」模式，让 Hero 更接近 WorkBuddy 的意图入口。
3. **P2** 背景可替换为用户自定义壁纸 / 品牌插画，当前为纯 CSS 光晕，零依赖。
