# ALIGN-22：首页 1:1 还原 + 3D 卡通图标 + 设置页模型配置

## 完成度清单

| 区域 | 目标 | 状态 |
|---|---|---|
| 首页品牌图标 | 3D 卡通吉祥物，替代原 π 符号 | ✅ |
| 首页标题版式 | 居中「Pi Workbench, 我帮你」，logo 在标题上方 | ✅ |
| 首页背景 | 浅青蓝渐变 + 径向光晕（适配 dark 主题） | ✅ |
| 首页活动浮卡 | 右上角「活动」卡片，可关闭，localStorage 记忆 | ✅ |
| 首页分类 pill | 标题下方，选中填充色（日常办公绿/代码开发蓝/设计创意橙） | ✅ |
| 首页技能 chips | 与分类联动，圆角大 chip | ✅ |
| 首页吉祥物 | 技能区右侧 3D 卡通机器猫，带浮动动画 | ✅ |
| 首页输入框 | 大圆角输入框：+ 附件占位 / 快速模式 / 麦克风 disabled / 发送 | ✅ |
| 首页底部工具栏 | 输入框下方「选择工作空间 + 默认权限」横向工具栏 | ✅ |
| 目录选择 | 保留，目录按钮绑定 pickDirectory + createProject | ✅ |
| 3D 卡通图标 | Tauri 图标全尺寸替换（icon.png / icon.ico / icon.icns + iOS/Android） | ✅ |
| 设置页入口 | Sidebar「设置」按钮跳转 /settings，移除 About 弹窗 | ✅ |
| 设置页模型配置 | provider / model / base_url / api_key / temperature / max_tokens 表单 | ✅ |
| 模型配置后端 | settings_load / settings_save / settings_test_model 命令 + ModelConfig | ✅ |
| API Key 安全 | 密码输入、不回显、不进入日志 | ✅ |
| 设置页工具激活 | 复用 tools_list / tools_activate，AppCheckbox 勾选 | ✅ |
| 设置页关于 | 应用 / Pi 内核 / Tauri / 吉祥物信息 | ✅ |
| 全页面对齐扫描 | 7 个主路由逐项比对并打勾 | ✅ |
| 验证基线 | cargo / typecheck / build / vitest / preflight 全绿 | ✅ |

## 真实根因与修复

### 1. 图标「丑」—— 用 3D 卡通吉祥物替代 π

旧 `.hero-mark` 是纯 CSS 绘制的蓝色 π 块，看起来像系统符号、没有品牌感。
修复：
- 用 ImageGen 生成 3D 卡通机器猫吉祥物（戴耳机、π 符号悬浮头顶、clay/render 风格）。
- Python/PIL 居中裁切 928×928 去除水印。
- `pnpm tauri icon` 生成完整图标集，替换 `src-tauri/icons/` 下全部尺寸 + iOS/Android。
- 前端 `public/mascot-mark.png`（128×128）放标题上方，`public/mascot-side.png`（192×192）放技能区右侧。
- 副产品：`public/mascot.png`（原 1024×1024）留作品牌素材。

### 2. 首页版式不对

根因：版式元素顺序与 WorkBuddy 首页不一致；缺少活动浮卡、输入工具栏、吉祥物。
修复：
- `ChatHero.vue` 重新组织 DOM：背景光晕 → ActivityCard → 标题 → 分类 pill → 技能 chips + 吉祥物 → 大输入框 → 底部工作空间/权限工具栏。
- 新增 `ActivityCard.vue/.css`：右上角浮卡，标题、文案、关闭、查看详情，关闭状态持久化到 `localStorage['pi-workbench:activity-dismissed']`。
- 新增 `quickMode` 下拉（快速/标准/深度）、附件按钮（占位 UI）、麦克风按钮（disabled + tooltip）。
- `.chat-hero` 改为浅青蓝渐变背景，`.hero-bg` / `.hero-glow` 加径向光晕，dark 主题下自动变深色。
- 工作空间/默认权限卡片从标题下方移到输入框下方，做成透明底工具栏。

## 后端实现逻辑

新增 `src-tauri/src/models.rs`：

```rust
pub struct ModelConfig { provider, base_url, model, api_key, temperature, max_tokens }
pub struct AppSettings { model: ModelConfig, theme, language }
#[tauri::command] pub fn settings_load(app: AppHandle) -> AppSettings
#[tauri::command] pub fn settings_save(app: AppHandle, settings: AppSettings) -> Result<(), String>
#[tauri::command] pub async fn settings_test_model(config: ModelConfig) -> Result<String, String>
```

- 配置文件：`app_config_dir/app-settings.json`，**避开** `tools.rs` 已占用的 `app_config_dir/settings.json`（Pi 内核 defaultTools）。
- `settings_test_model` 只做 HTTP HEAD/GET 校验 `base_url` 可达，**不发送真实请求、不消耗 token、错误信息不回显 api_key**。
- `lib.rs` 新增 `mod models;` 并注册 `settings_load/save/test_model`。

## 与 Pi 的融合改造

- 首页仍是「空项目 → 展示 Hero，有项目 → 展示对话」逻辑；`submitHero` 仍走 `taskContextPreamble() + pi send`。
- 快速模式、附件按钮目前只影响前端状态，真实下发到 Pi 的改造可后续在 `usePi.send` 前拼接 preamble。
- 模型配置保存后可用于替换当前硬编码的 LLM 调用点；当前 Pi Workbench 的对话仍由 `pi` 子进程驱动，模型配置页面先把持久化做出来，后续再接入 `pi_start` 参数。
- 工具激活页复用 `tools_activate`，改动直接写入 Pi 内核的 `settings.json defaultTools`，重启内核生效。

## 全页面对齐扫描

| 路由 | 核心能力 | 当前状态 | 与 参考实现 差距 |
|---|---|---|---|
| `/chat` | Hero 落地页 / 三栏对话 / 文件树 / 会话树 / 轨迹 / 工作流 / 连接器 / 智能体浏览器 / 终端 | ✅ Hero 1:1，三栏会话已具备；右栏「文件」编辑/保存/外部打开完整 | 语音输入未接入；附件上传只做了 UI 占位 |
| `/projects` | 项目卡片网格 / 模板 / 新建项目 / 目录选择 / 搜索 / 排序 | ✅ 全部对齐 | 缺少 参考实现 的「团队空间」视图 |
| `/projects/:id` | 项目配置 / 计划项 / 关联资产 / 活动 | ✅ 四个 tab 全部接后端 | 活动面板只展示原始记录，尚未做可视化时间线 |
| `/library` | 资料库树 / 搜索 / 最近 / 输出 / 新建导入重命名移动删除发布回滚 | ✅ 全部对齐 | 无 |
| `/capabilities` | 专家 / 技能 / 连接器 / 安装卸载 / 启用工具 | ✅ 三个子 tab 完整 | 技能市场远端 hub 无服务端，用空态 + 本地安装补齐 |
| `/plugins` | 扩展发现 / 已安装 / 主题 / 收藏 / 高级 / 启用工具 | ✅ 列表与启用链路已修 | 社区市场无真实服务端；主题/收藏/高级为 UI 占位 |
| `/settings` | 模型配置 / 工具激活 / 关于 | ✅ 本轮新建 | 主题/语言切换可后续补到设置页 |

## 验证结果

```
cargo check --all-targets   0 error 0 warning
cargo test --lib            142 passed
pnpm typecheck              No errors found
pnpm build                  ✓ 165 modules（CSS 118.45 kB / JS 287.54 kB）
pnpm vitest run             111 passed（11 files）
pnpm app:preflight          Node 22.22.3 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲
```

## 文件改动

- 新增：`src/components/chat/ActivityCard.vue/.css`
- 新增：`src/views/SettingsView.vue/.css`
- 新增：`src-tauri/src/models.rs`
- 新增：`public/mascot*.png`
- 改写：`src/components/chat/ChatHero.vue/.css`
- 修改：`src/components/layout/Sidebar.vue`（设置按钮跳转 /settings，移除 About 弹窗）
- 修改：`src/router/index.ts`（加 /settings）
- 修改：`src-tauri/src/lib.rs`（mod models + 注册命令）
- 替换：`src-tauri/icons/*`（Tauri icon 全尺寸）

## 下一步

- GUI 点验：启动 `pnpm app:dev`，确认首页吉祥物加载、活动卡片可关闭、目录选择仍能创建项目、设置页能保存/测试模型配置。
- 如活动卡片文案或吉祥物动作需调整，可基于 `public/mascot*.png` 再生成变体。
