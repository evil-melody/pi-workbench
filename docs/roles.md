# 专家角色（Expert Role）

> 目标：让「换一个 AI 人格 / 工作方式」变成加一段声明，而不是改代码分支。

## 1. 机制

角色 = **一段追加到 Pi 系统提示的文本**。注入走 Pi 官方 extension 挂点：

```
on("before_agent_start")
  → ctx.systemPromptOptions.appendSystemPrompt += "## 当前角色：<name>\n\n<prompt>"
```

为什么是 `appendSystemPrompt` 而不是整体替换：

- Pi 的 `buildSystemPromptSections()` 会把它渲染成 `addendum` 段（源码：`dist/core/system-prompt.js` L95-96），
  而 `preamble / tools / rules / docs` 等段保持不变 —— **工具用法与规则不会因为换角色而丢失**。
- 只有当 `systemPromptOptions` 不可用时才整体追加（兜底路径，会替换 Pi 自带提示）。

数据走向：

```
Vue 下拉选择
  → invoke("role_set", { id, root })            # Rust: roles.rs
  → 写 <项目根>/.pi/roles/current.md            # 首行 <!-- role: id | 名称 -->
  → Pi extension role-inject.ts 每轮读取该文件
  → 追加到系统提示（切换即时生效，无需重启内核）
```

内置角色定义在 `src-tauri/src/roles.rs`（`builtin_roles()`），用户 md 与内置同 id 时覆盖内置。

## 2. 内置角色

| id | 名称 | 行为要点 |
|---|---|---|
| `general` | 通用助手 | 先确认边界再给方案；结论先行、依据到 file:line；不编造 API/版本 |
| `aider-programmer` | Aider 编程专家 | repo map 先行、最小 diff（字符级 SEARCH/REPLACE）、测试驱动、原子提交、只读优先、不臆造提交 |

`aider-programmer` 对齐 Aider 的公开行为（来源：aider.chat 官网 feature 列表 + 官方文档）：

- **Maps your codebase**：仓库地图给出文件名/类/函数签名/import 关系，默认约 1K token 预算（`--map-tokens` 可调）；
  本角色把这条落成「动手前先确认符号定义与调用点」。
- **Search/Replace 编辑、最小 diff**：为省事重写整个文件在本角色下被视为错误做法。
- **Linting & testing**：改完跑测试/lint，失败把报错原文回灌下一轮自我修复；修实现，不改测试迁就实现。
- **Git integration**：每次变更一个原子提交，Conventional 风格信息；非 git 目录不臆造提交。
- **只读澄清**：用户明说「只解释/别改文件」时一律不写文件。

## 3. 新增一个角色

在用户级角色目录放一个 `.md`：

```
~/Library/Application Support/com.piworkbench.app/roles/reviewer.md
```

```markdown
<!-- role: reviewer | 代码审查 -->

你是严格的代码审查者，只诊断不改文件。

1. 先读全相关实现，再给结论，禁止凭局部片段下判断。
2. 每条问题给出 文件:行号 + 依据 + 具体改法；区分「必须改」「建议改」「可忽略」。
3. 主动指出并发/边界/错误处理/资源释放/安全（注入、越权、密钥）问题。
4. 没发现问题时直接说「未发现阻塞问题」，不要凑数。
```

- 首行必须严格为 `<!-- role: <id> | <显示名> -->`（无此头的文件会被忽略）。
- 正文即提示词；保持 <2000 token（蓝图对本地小模型的硬约束）。
- 重启应用后 `role_list` 会出现该角色，下拉即可切换。

项目级生效文件 `.pi/roles/current.md` 由应用自动写入，不要手改（手改也可，应用重启后仍沿用，除非再次用下拉切换）。

## 4. 带工具的角色（进阶）

角色只改提示词；若某角色还需要专属工具（如 `search_code`），在 extension 里注册后让提示词引用它。

Pi 0.87.x 的工具注册有硬性写法，**必须单对象注册**：

```ts
pi.registerTool({
  name: "search_code",
  label: "代码检索",
  description: "...",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  execute: async (_id, params, _signal, _onUpdate, ctx) => ({ content: "..." }),
});
```

两条踩过的坑：

1. `registerTool("name", {...})` 双参数写法会让 Pi 报
   `Tool "undefined" ... must define an object parameter schema`，工具静默不注册。
2. `execute` 是五参签名 `(toolCallId, params, signal, onUpdate, ctx)`，不是单参。
3. `setActiveTools([])` 语义是「只激活列出的工具」，传空数组会把内置工具全部停掉；
   要停用默认应显式列出想激活的名字。

## 5. 验证记录

| 项 | 结果 |
|---|---|
| `cargo test` | ✅ 10/10（roles 4 项：内置覆盖、token 预算、md 往返、无头拒绝） |
| `pnpm build` | ✅ 76 模块 |
| extension 加载 | ✅ `pi --mode rpc --extension sandbox-env.ts --extension role-inject.ts` 无报错，`get_commands` 可见 `search_code` 工具 |
| 注入逻辑（探针脚本） | ✅ 有 current.md 时 marker 进入 addendum 段且返回 `{}`；无 current.md 时不改任何内容 |
| 端到端（真实 agent 轮次） | ❌ 待人工：本机无 provider API key，`prompt` 命令在鉴权阶段即失败，`before_agent_start` 未触发 |

## 6. 未完成

- 角色可绑定建议激活的工具集（当前提示词只描述，不调 `setActiveTools`；避免误停内置工具）。
- 角色切换记录进会话节点（回滚到某分支时一并恢复当时角色）。
- 角色提示词 token 实测闸门（当前用字符数粗估 <1400）。
