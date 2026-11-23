# 首页 1:1 还原 + 设置页模型配置 设计稿

目标：按截图（WorkBuddy 首页）1:1 还原 Pi Workbench 首页版式与交互，
同时补齐「设置 → 模型配置」页面与后端能力。
内核仍是 `pi-coding-agent 0.87.1`，外壳 Tauri 2。

---

## 一、当前 vs 截图差异

| 区域 | 当前实现 | 截图目标 | 是否对齐 |
|---|---|---|---|
| 背景 | 纯色 `var(--bg)` | 浅青蓝渐变背景 + 柔和光晕 | ❌ |
| 标题 | 左侧 π logo + "Pi Workbench, 我帮你" | 居中 "WorkBuddy, 我帮你"，无 logo | ❌ |
| 右上角 | 无 | 「活动」浮动卡片：标题、文案、关闭、查看详情 | ❌ |
| 分类 | 在输入框上方，icon+文字 pill | 在标题下方，选中为**绿色填充 pill**，其余描边 | ❌ |
| 技能 chips | 在分类下方，纯文字小 chip | 分类下方横向 chip + 右侧吉祥物形象 | ❌ |
| 输入框 | textarea + send 按钮，无附件/语音 | 大输入框：左侧「+」、placeholder、右下角「快速」下拉 + 麦克风 + 发送 | ❌ |
| 底部 | 工作空间/默认权限两张卡片在标题下方 | 在输入框下方：「选择工作空间」下拉 + 「默认权限」下拉，横向排列 | ❌ |

---

## 二、首页改造方案

### 2.1 组件结构（自上而下）

```
ChatHero
├── hero-glow            # 青蓝色径向光晕（仅首页）
├── activity-card        # 右上角活动浮卡（可关闭，localStorage 记忆）
├── hero-brand
│   └── hero-title       # "Pi Workbench, 我帮你" 居中
├── hero-categories      # 分类 pill 行
│   └── cat-pill
├── hero-skills-row      # 技能 chips + 吉祥物
│   ├── hero-skills
│   └── hero-mascot
├── hero-composer        # 大输入框
│   ├── attach-btn
│   ├── AppTextarea
│   └── composer-actions
│       ├── quick-mode AppSelect
│       ├── mic-btn
│       └── send-btn
└── hero-footer          # 底部工具栏
    ├── workspace-dropdown（选择工作空间 + 目录按钮）
    └── role-dropdown（默认权限）
```

### 2.2 数据与交互

- `category: 'office' | 'code' | 'design'`，默认 `'office'`（截图第一个选中「日常办公」）。
- `skillMap` 与当前一致，但 UI 改成圆角大 chip（与截图同宽感）。
- `quickMode: '快速' | '标准' | '深度'`（示意；深度 = 更长的 reasoning）。
  仅前端状态，发送时拼到 preamble 或作为 token 预算提示。
- `attachFile()`：打开系统文件选择，目前只把文件路径写入输入框占位；
  真实文件上传走资料库/项目资产域，本轮只把按钮和占位做出来。
- `micBtn`：暂为 disabled 状态并 tooltip「语音输入暂未接入」。
- 活动卡片：`localStorage['pi-workbench:activity-dismissed']` 记忆关闭，默认显示。
- 吉祥物：用内联 SVG（戴耳机的机器猫形象），不引入外部图片资源。

### 2.3 视觉

- 新增 `.chat-hero` 渐变背景：`linear-gradient(180deg, #e8f4f8 0%, #f6f9fb 60%, #f6f7f9 100%)`（light），
  dark 主题下变深：`linear-gradient(180deg, #14202a 0%, #0e1014 60%)`。
- 光晕：两个径向渐变 `radial-gradient(circle at 20% 10%, rgba(64,196,180,.22), transparent 35%)` 等。
- 标题：36px / 600 / 居中 / `var(--text)`。
- 分类 pill：
  - 未选中：bg transparent，border `var(--border-strong)`，color `var(--text-dim)`；
  - 选中：bg `#22b24c`（office）/ `#2563eb`（code）/ `#d97706`（design），color white，无边框。
- 技能 chip：border `var(--border)`，bg `var(--bg-panel)`，hover 抬升 + border-strong。
- 输入框：bg `var(--bg-panel)`，圆角 16px，阴影 `0 4px 20px rgba(0,0,0,.06)`，
  placeholder 与截图一致：「今天帮你做些什么？@ 添加上下文，/调用技能与指令」。
- 底部下拉：透明底 + 左侧图标 + 文字 + 下拉箭头；hover 背景高亮。

---

## 三、设置页 + 模型配置

### 3.1 路由与入口

- 新增 `/settings` 路由，`SettingsView.vue` + `SettingsView.css`。
- `Sidebar.vue` 的「设置」按钮从 About 弹窗改为 `router.push('/settings')`。
- About 信息移到 Settings 页底部或单独「关于」卡片。

### 3.2 后端模型配置

新增 `src-tauri/src/models.rs`：

```rust
#[derive(Default, Serialize, Deserialize, Clone)]
pub struct ModelConfig {
    pub provider: String,        // "openai" | "anthropic" | "local" | ...
    pub base_url: String,
    pub model: String,
    pub api_key: String,         // 仅存储在用户级配置，不日志/不回显
    pub temperature: f32,
    pub max_tokens: u32,
}

#[derive(Default, Serialize, Deserialize)]
pub struct AppSettings {
    pub model: ModelConfig,
    pub theme: Option<String>,
    pub language: Option<String>,
}
```

文件位置：`app_config_dir/settings.json`（与 tools 共用同一文件，不冲突）。
命令：

- `settings_load(app) -> AppSettings`
- `settings_save(app, AppSettings) -> ()`

**安全**：`api_key` 读写正常，但前端表单用 `<input type="password">`（自研 AppInput 加 `password` prop），
日志与错误信息中**永远不回显 key**（铁律）。

### 3.3 前端设置页

Tab：

1. **模型配置**（默认）
   - 服务商 AppSelect
   - 模型名 AppInput
   - Base URL AppInput
   - API Key AppInput（password，带显示/隐藏 eye 按钮）
   - Temperature AppInput number
   - Max Tokens AppInput number
   - 「保存」+「测试连接」按钮（测试连接调用一个后端命令 `settings_test_model`，只校验通不通，不消耗 token）
2. **工具激活**（复用现有 `tools_list` / `tools_activate`）
3. **关于**（APP_NAME / APP_VERSION / PI_VERSION / Tauri 2）

---

## 四、1:1 功能 checklist（含后端）

### 首页

- [x] 项目选择器支持目录选择（上一轮已做）
- [ ] 标题居中、去掉 π logo 或放到别处分隔
- [ ] 浅青蓝渐变背景 + 光晕
- [ ] 右上角「活动」浮动卡片（可关闭）
- [ ] 分类 pill 在标题下方，选中填充色
- [ ] 技能 chips 与分类联动
- [ ] 右侧吉祥物 SVG
- [ ] 大输入框 + 左侧「+」附件按钮（占位）
- [ ] 右下角「快速」模式下拉 + 麦克风（disabled）+ 发送
- [ ] 底部「选择工作空间 / 默认权限」下拉工具栏
- [ ] 无项目时的空态提示保留

### 设置页 / 模型配置

- [ ] `/settings` 路由
- [ ] Sidebar 设置入口改跳设置页
- [ ] 后端 `settings_load` / `settings_save` 命令
- [ ] 后端 `ModelConfig` 持久化到 `settings.json`
- [ ] 前端模型配置表单
- [ ] API Key 密码输入 + 不回显
- [ ] 「测试连接」后端命令（校验 HTTP 可达）
- [ ] 工具激活设置页
- [ ] 关于卡片

### 验证

- [ ] `cargo check --all-targets` 0 error 0 warning
- [ ] `cargo test --lib` 全绿
- [ ] `pnpm typecheck` No errors
- [ ] `pnpm build` 157+ modules
- [ ] `pnpm vitest run` 111 passed
- [ ] `pnpm app:preflight` 全绿
- [ ] 更新 `docs/ALIGN-22-首页1v1与模型配置.md`

---

## 五、实施顺序

1. **首页版式**（结构调整 + CSS）
2. **设置页 + 模型配置后端**
3. **验证基线 + 文档**

本轮只做到「首页版式」完成 + 「设置页模型配置」骨架可保存，
吉祥物与活动卡片文案可随你确认后一次性落地。
