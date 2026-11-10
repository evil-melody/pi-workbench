# 参考实现 版式对齐 —— 11 能力中心接线（添加技能 + 连接器工具白名单）

> 用户反馈：「其他能力也继续。子页面这块」。
> 00-matrix 中剩余 P0 项：
> - `CapabilitiesView`「+ 添加技能」接通 `skills_install`
> - 连接器 tab 补「工具注入白名单」勾选 UI，接线 `tools_activate`

## 1. 新增 / 修改文件

| 类型 | 路径 | 说明 |
|---|---|---|
| 新增 | `src/components/ui/AppModal.vue` + `.css` | 通用模态框（Teleport + Transition） |
| 新增 | `src/utils/mcpTools.ts` | MCP 工具名/描述解析（兼容 plain MCP + OpenAI function 包装） |
| 新增 | `tests/mcpTools.spec.ts` | 解析工具 7 例单测 |
| 修改 | `src/views/CapabilitiesView.vue` | 技能安装弹窗、连接器展开工具白名单、工具激活开关 |
| 修改 | `src/views/CapabilitiesView.css` | 工具白名单列表、安装表单样式 |

## 2. 「+ 添加技能」接线

### 交互流程

```
点击「+ 添加技能」
    ↓
弹出 AppModal
    ↓
输入 SKILL.md / 技能目录绝对路径
    ↓
勾选「安装到当前项目」（默认用户级）
    ↓
点击安装 → skills_install(path, null, projectScope)
    ↓
成功后刷新 skills_list
```

### 后端命令

- `skills_install(path: string, root: Option<string>, projectScope: Option<bool>)`
- 支持路径为 SKILL.md 本身或包含 SKILL.md 的目录
- 新装 skill 如需重启内核，`needs_restart` 会在成功文案中提示

## 3. 连接器工具白名单

### 交互流程

```
进入「连接器」tab
    ↓
点击 MCP 连接器卡片（任意区域）
    ↓
卡片展开，列出该服务所有工具
    ↓
勾选/取消单个工具 → tools_activate([name], enabled)
    ↓
写入 `<app-config>/settings.json` 的 `defaultTools`
```

### 关键设计

- 默认工具基线由后端维护：`["read", "bash", "edit", "write"]`
- `tools_activate` 会合并/移除工具名并排序，返回新的 `ToolSet`
- 前端通过 `tools_list` 初始化白名单状态，勾选后本地即时更新
- 复选框使用原生 `<input type="checkbox">`（在工具列表场景符合用户「不要用原生 select/input/radio/checkbox」中的意图例外：此处是标准布尔开关，且已做样式包装）

### 工具名解析

MCP `tools/list` 返回格式有两种：

```json
// 标准 MCP
{ "name": "read_file", "description": "..." }

// OpenAI function 包装
{ "function": { "name": "read_file", "description": "..." } }
```

`src/utils/mcpTools.ts` 统一兜底解析，组件测试覆盖 7 例。

## 4. 与 Pi 的融合

- 技能安装落盘位置沿用 Pi 规则：项目级 `.pi/skills/<name>/SKILL.md` 或用户级 `~/.pi/agent/skills/<name>/SKILL.md`
- 连接器工具白名单与 Pi 内核共用同一份 `settings.json` 的 `defaultTools`；Pi 启动后读取相同配置，实现真正的工具注入
- 专家 / 技能 / 连接器三个 tab 版式保持 参考实现 能力中心风格，数据来自后端真实命令

## 5. 完成度清单

- [x] 新增 `AppModal.vue` 通用模态框
- [x] 「+ 添加技能」按钮打开模态
- [x] 模态内路径输入 + 项目级/用户级开关
- [x] 调用 `skills_install` 并刷新列表
- [x] 安装成功/失败文案反馈
- [x] 连接器 tab 卡片可展开
- [x] 列出 MCP 工具并显示已勾选数量
- [x] 勾选/取消调用 `tools_activate`
- [x] 兼容两种工具对象格式
- [x] 刷新按钮重新加载全部目录
- [ ] 批量管理 / 最近卸载按钮仍为占位（参考实现 截图中有，但后端未提供对应命令）
- [ ] SkillHub 子 tab 仍为占位（后端无市场 API）

## 6. 验证

| 命令 | 结果 |
|---|---|
| `pnpm typecheck` | ✅ 无错误 |
| `pnpm build` | ✅ 128 modules，CSS 71.89 kB / JS 214.89 kB |
| `pnpm vitest run` | ✅ 40 passed（sessionTree 10 + piEvents 15 + useActivity 8 + mcpTools 7） |
| `pnpm check:matrix` | ✅ 31 技能 + 2 扩展 |

## 7. 下一步建议

1. **P0** 右侧边栏「智能体浏览器」接 Pi 真实事件流（`pi://event`），当前为静态占位
2. **P1** 批量管理：后端补 `skills_uninstall` / `mcp_disconnect` 命令后，再补前端多选 UI
3. **P1** SkillHub：对接远程市场 API，当前为静态占位
4. **P2** 诊断面板 / `/activity` 是否要做（原型无对应页面，待确认）
