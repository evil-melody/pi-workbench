# 参考实现 版式对齐 —— 01 全局左侧边栏

> 完成度：**结构 + 后端已对齐**；余额/用量数据当前为静态占位，待接入真实计费。

## 1. 截图对照（外部参考实现-projects-alpha8-dark.png）

| 区域 | 参考实现 版式 | 本页落地 |
|---|---|---|
| 顶部品牌区 | W logo + "参考实现" + 右侧窗口切换按钮 | 保留 Pi 品牌：P logo + "Pi Workbench" + 折叠按钮，版式结构 1:1 |
| 新会话按钮 | 灰色 pill，⊕ + "新会话" | 灰色 pill，⊕ + "新会话" |
| 主导航 | 插件 / 项目 / 专家·技能·连接器 / 资料库 | 完全一致 |
| 工作区 | 项目列表 + 右侧相对时间（1小时 / 1天 / 3天…） | 完全一致，时间从 `updated_at` 计算 |
| 左下角余额 | 余额 ¥96.28 / 今日 ¥2.4201 + 彩色进度条 + 时段说明 + 设置 | 结构一致；金额/时段先 mock，后端 `billing_status` 已提供 |

## 2. 修改文件

- `src/components/layout/Sidebar.vue`：重写结构，新增 `BillingStatus`、时间格式化、项目更新时间。
- `src/components/layout/Sidebar.css`：1:1 调整间距、品牌区、底部余额卡片与彩色进度条。
- `src-tauri/src/state.rs`：`Project` 增加 `updated_at: Option<u64>`（`#[serde(default)]` 兼容旧数据）。
- `src-tauri/src/projects.rs`：新增 `billing_status`；`project_add` / `project_set_active` 自动写 `updated_at`。
- `src-tauri/src/lib.rs`：注册 `billing_status` 命令。

## 3. 后端逻辑

### 3.1 项目时间戳

```rust
// project_add
Project { id, name, path, updated_at: Some(now_ms()) }

// project_set_active：切项目时顺手更新一下时间，这样侧边栏的「最近活跃」顺序与真实行为一致
if let Some(p) = projects.iter_mut().find(|p| p.id == id) { p.updated_at = Some(now_ms()); }
```

### 3.2 余额/用量（占位）

```rust
#[tauri::command]
pub fn billing_status() -> BillingStatus { ... }
```

当前返回静态值以保持 UI 版式完整。Pi 本身没有计费模型，后续若接入 model-service 的 token 用量，可在此命令里读取本地 usage 缓存或调用远端接口，前端无需改动。

## 4. 与 Pi 项目的融合

- 品牌名保留 `Pi Workbench`，避免与 参考实现 品牌混淆；版式结构、组件层级、交互节奏 1:1 复刻。
- 余额区对 Pi 来说暂无业务含义，但把「用量/成本」这一未来能力的位置预留出来，避免后续再加时破坏布局。

## 5. 完成度清单

- [x] brand 区版式（logo + 文字 + 右侧按钮）
- [x] 新会话 pill 按钮
- [x] 主导航 4 项 + 选中态左侧 accent 竖条
- [x] 工作区标题 + 搜索/排序/新建 icon action
- [x] 项目列表 + 右侧相对时间
- [x] 底部余额卡片（余额/今日/彩色条/时段说明）
- [x] 设置按钮
- [x] 折叠态适配
- [ ] 接入真实余额/用量数据（待 model-service/usage-service）

## 6. 验证

- `pnpm typecheck` ✅
- `cargo check` ✅
