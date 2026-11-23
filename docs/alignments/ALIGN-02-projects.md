# 参考实现 版式对齐 —— 02 项目主页

> 完成度：**版式 1:1 对齐截图**；模板名与文案已改成 参考实现 同款；归档/恢复后端已补齐。

## 1. 截图对照

| 元素 | 参考实现 版式 | 本页落地 |
|---|---|---|
| 页头标题 | "项目" 38px + 副标题 | 一致 |
| 新建项目按钮 | 浅色背景、深色文字、圆角 9px、左侧 + 号 | 一致（`.wd-p-create`） |
| 右侧插画 | 文件 / 分享 / 列表 三个方块 + 虚线连接 | 使用对应 AppIcon 复刻 |
| 我的项目筛选 | 右上角「进行中」下拉 + 搜索框 | 一致 |
| 项目卡片 | 左侧图标 + 名称/更新时间 + 右侧「归档」按钮（hover 显示） | 一致；当前项目高亮态也显示归档 |
| 已归档 | 切换下拉后显示「恢复」按钮 | 一致 |
| 从模板创建 | 5 张卡片：产品需求全流程、市场调研与竞品分析、团队知识库、项目交付、Bug 跟踪/测试验收 | 一致 |

## 2. 修改文件

- `src/views/ProjectsView.vue`：重写模板区、卡片操作、弹窗。
- `src/views/ProjectsView.css`：新增 `.wd-p-create` 浅色按钮、`.wd-p-card-archive` hover 显示归档。
- `src-tauri/src/state.rs`：`Project` 增加 `archived: bool`（兼容旧数据）。
- `src-tauri/src/projects.rs`：新增 `project_archive` / `project_unarchive`。
- `src-tauri/src/lib.rs`：注册归档命令。

## 3. 后端逻辑

### 3.1 归档/恢复

```rust
#[tauri::command]
pub fn project_archive(app, id, state) -> Result<Vec<Project>, String> {
    // 设置 archived=true 并刷新 updated_at
    save(...)
}

#[tauri::command]
pub fn project_unarchive(app, id, state) -> Result<Vec<Project>, String> {
    // 设置 archived=false 并刷新 updated_at
    save(...)
}
```

### 3.2 持久化

项目数据保存在 `app_config_dir()/projects.json`，`archived` 与 `updated_at` 字段一并写入。

### 3.3 与 Pi 的融合

- 项目仍然是 Pi 的「工作目录 + 系统提示」载体；点击项目卡片进入 `/chat` 时把该项目设为 active。
- 模板里的 instruction 会写入新项目，作为 Pi 的系统提示注入点（与 `roles.rs` 的 current role 合并）。

## 4. 完成度清单

- [x] 页头标题/副标题/插画
- [x] 浅色「新建项目」按钮
- [x] 「我的项目」区域 + 下拉筛选 + 搜索
- [x] 项目卡片 hover 显示「归档」
- [x] 已归档项目可「恢复」
- [x] 从模板创建 5 个模板
- [x] 新建项目弹窗（名称/模板/指令/目录）
- [x] 后端归档命令
- [ ] 模板可配置化（当前硬编码，后续可读取 `~/.pi/templates/*.md`）

## 5. 验证

- `pnpm typecheck` ✅
- `cargo check` ✅
