# 参考实现 版式对齐 —— 03 能力中心（技能市场）

> 完成度：**版式 1:1 对齐截图**；二级 SkillHub 与「添加技能」按钮当前为占位，本地技能/专家/连接器已可展示。

## 1. 截图对照（外部参考实现-skillhub-2026-09.png）

| 元素 | 参考实现 版式 | 本页落地 |
|---|---|---|
| 顶部胶囊 tab | 专家 / 技能 / 连接器 | 一致 |
| 搜索框 | 「搜索技能」 | 一致 |
| 右侧操作 | 我安装的 / 批量管理 / 最近卸载 / + 添加技能 | 一致（后三者当前为占位按钮） |
| 大标题 | 「技能市场」 | 一致；随 tab 切换为「专家市场」「连接器市场」 |
| 二级 tab | 本地技能 / SkillHub | 一致（SkillHub 占位） |
| 卡片 | 彩色圆角图标 + 标题/副标题/描述/版本/来源 + 右上角安装/已安装 | 一致；颜色按名称 hash 生成，版本/来源后端缺失时前端 fallback |

## 2. 修改文件

- `src/views/CapabilitiesView.vue`：重写为技能市场布局：顶部 tab + 搜索 + 右侧操作、二级 tab、卡片网格。
- `src/views/CapabilitiesView.css`：1:1 复刻市场卡片、彩色图标、安装按钮态。

## 3. 后端逻辑

当前直接使用已有命令：

```rust
role_list()        -> Vec<Role>
skills_list(root)  -> Vec<SkillEntry>
mcp_list()         -> Vec<Value>
```

前端把三类数据归一成 `Row` 统一渲染；缺失的 `version/author/color` 由前端补齐：

- `color`：对名字做简单 hash 从固定调色板取色。
- `version`：默认 `v0.1.0`。
- `source`：回退到 `via`（技能来源）或 `stdio`（MCP）。

## 4. 与 Pi 项目的融合

- 「专家」对应 Pi 的 role/prompt 注入机制；点击「启用」调用 `role_set` 把对应 prompt 写入 `.pi/roles/current.md`。
- 「技能」对应 Pi 的 SKILL.md 目录扫描；`skills_list` 已经能列出本地技能。
- 「连接器」对应 MCP 服务；`mcp_list` 列出已连接服务。

## 5. 完成度清单

- [x] 顶部胶囊 tab（专家/技能/连接器）
- [x] 搜索框
- [x] 右侧「我安装的」「批量管理」「最近卸载」「+ 添加技能」占位
- [x] 大标题 + 二级 tab
- [x] 卡片网格（彩色图标 + 标题/副标题/描述/版本/来源）
- [x] 右上角安装/已安装图标
- [x] 专家「启用」按钮
- [ ] SkillHub 远端市场（需要后端接口或静态市场数据）
- [ ] 真实的批量管理 / 最近卸载 / 添加技能功能
- [ ] 后端为 SkillEntry 增加 version/author/color 字段，替代前端补齐

## 6. 验证

- `pnpm typecheck` ✅
- `cargo check` ✅
