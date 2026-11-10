# 专家域完整化（B 轮）—— 草稿 / 校验 / 发布确认 / 发布

对齐目标：`外部参考实现` → `packages/plugins/experts/*`（`definition.ts` / `values.ts` / `digest.ts` / `runtime/confirmation.ts`）。
内核仍是 `pi-coding-agent 0.87.1`，本轮只补齐「专家」这一层的领域能力，不改动 Pi 的提示词与协议。

---

## 一、完成度清单

### 1.1 后端（`src-tauri/src/experts.rs`，新建 ~900 行）

| # | 能力 | 实现要点 | 状态 |
|---|------|----------|------|
| 1 | `ExpertDefinition` 领域模型 | name / description / role / methodology / boundaries / deliverables / tags / examples / skill_requirements | ✅ |
| 2 | 校验 `validate_definition` | 必填、上限（码点计）、重复 id / 重复 tag、总字节 32 KiB | ✅ |
| 3 | 字面量 `{{ }}` 拒绝 | 会进 persona 的字段出现模板花括号 → `definition/template-braces` | ✅ |
| 4 | `normalize_definition` | trim + 去空标签，保证「只差空格」得到同一摘要 | ✅ |
| 5 | `definition_digest` | 规范化后 JSON 取 SHA-256 | ✅ |
| 6 | `compile_persona_prefix` | 「你是「X」」+ 角色/方法/边界/交付物/标签五段 | ✅ |
| 7 | `compile_persona_suffix` | 保留内核约束 + 启动示例 | ✅ |
| 8 | `ConfirmationStore::request` | 铸 challenge，**不授予**任何权限，TTL 5 分钟 | ✅ |
| 9 | `ConfirmationStore::confirm` | 只有受信任的 UI 动作能把 challenge 换成 proof | ✅ |
| 10 | `ConfirmationStore::consume` | 发布时重新比对 principal / TTL / 内容摘要，任一不符即作废，proof 一次性 | ✅ |
| 11 | 草稿落盘 `experts/<id>.draft.json` | 带 revision，保存走乐观锁（`experts/revision-conflict`） | ✅ |
| 12 | 发布落盘 `experts/<id>.persona.md` | 不传 root 时写用户级 | ✅ |
| 13 | 项目级 persona `root/.pi/roles/current.md` | 与 `role_set` 同一条通道，role-inject 每轮读取，切换即时生效 | ✅ |
| 14 | 命令 `experts_list` / `expert_draft_load` / `expert_draft_save` / `expert_validate` / `expert_request_confirmation` / `expert_confirm` / `expert_publish` | 全部注册进 `lib.rs` | ✅ |
| 15 | Rust 测试 14 条 | 校验 / 摘要 / persona 编译 / 确认链路，全绿 | ✅ |
| 16 | 编译零告警 | `cargo check --all-targets` 0 error 0 warning | ✅ |

### 1.2 前端

| # | 能力 | 位置 | 状态 |
|---|------|------|------|
| 1 | `useExperts.ts` 命令封装 + 错误码翻译 + token 估算 | `src/composables/useExperts.ts` | ✅ |
| 2 | 专家 tab 改为「左列表 + 右编辑器」两栏 | `CapabilitiesView.vue` | ✅ |
| 3 | 草稿编辑器（四段人格 + 标签 + 示例 + Skill 依赖） | `components/experts/ExpertDraftEditor.vue` | ✅ |
| 4 | 实时校验（本地即时 + 后端权威，`validateSeq` 丢弃过期结果） | 同上 | ✅ |
| 5 | persona 预览与 token 计数 | 同上 | ✅ |
| 6 | 发布确认弹窗（摊开摘要 / 修订号 / 真实倒计时） | `components/experts/PublishConfirmDialog.vue` | ✅ |
| 7 | 「另存为新专家」 | 编辑器内弹窗 | ✅ |
| 8 | Vitest 13 条 | `tests/expertDomain.spec.ts` | ✅ |

### 1.3 本轮修掉的 6 个真实缺陷

| # | 缺陷 | 根因 | 修复 |
|---|------|------|------|
| 1 | `experts.rs` 11 个编译错误 | `read_definition(PathBuf)` 按值传路径导致多处 move 冲突；两个闭包同时可变借用 `issues` | 改按 `&Path`；`required`/`limit` 抽成带 `issues` 入参的普通函数 |
| 2 | `ConfirmationProof` 不满足 `CommandArg` | 缺 `Deserialize` | derive `Deserialize`，前端传 `{ token }` |
| 3 | `record.consumed = true` 编译失败 | `get()` 返回不可变引用 | record 克隆后写回：既解决借用，也让「已消费」状态在表项里留痕 |
| 4 | 测试 `E0716` 临时值释放 | `issue_codes(&validate_definition(&def))` 单行链式 | 拆成 `let issues = …; let codes = issue_codes(&issues)` |
| 5 | 测试断言与实现不一致 | proof 二次消费返回 `confirmation-stale`，测试写的是 `confirmation-required` | 断言改为 `.err()` 比较 stale（一次性凭证重放 = 已作废） |
| 6 | `v-model="ex.title ?? ''"` 构建失败 | 模板编译期要求 v-model 是合法赋值表达式 | 改 `:model-value` + `@update:model-value`，配 `setExampleTitle` |

---

## 二、后端实现逻辑

### 2.1 发布确认权威模型（ADR-0017 #5）

```
expert_validate(def)  → issues
expert_draft_save()   → revision / digest（内容摘要 = SHA256(normalize(def))）
expert_request_confirmation() → challenge（只铸 token，不授权，TTL 5 min）
        │
        ├─ 用户看到 challenge 内容 → 点「我确认发布」
        ↓
expert_confirm(token)  → proof（一次性）
        │
        ↓  expert_publish(id, proof, root)
        ├─ consume(proof, digest, dep_digest)：重比对「确认时的摘要」与「此刻落盘内容的摘要」
        ├─ 不一致 → experts/confirmation-stale（内容被人改过，授权作废）
        ├─ 已消费 → experts/confirmation-stale（凭证不可重放）
        └─ 过期   → experts/confirmation-stale
```

关键点：**模型自报的 `confirmed: true`、复述的意图、prompt 文本都不是授权依据**。
唯一能签发 proof 的是「受信任的 UI 用户动作」，且 proof 在消费时重新校验内容，
所以「确认后又偷偷改内容」这条攻击路径是闭合的。

### 2.2 为什么草稿保存必须先于申请挑战

`request` 绑定的是**已保存**内容的摘要。若在未保存状态下申请挑战，
用户点确认时前端手里的定义可能已经落后于磁盘，发布就会因摘要不匹配失败。
前端 `requestChallenge()` 里显式先 `await save()` 再申请，把「确认对象」钉死在一个确定的修订号上。

### 2.3 persona 落盘位置

- 传 `root`（项目根目录）→ 写 `<root>/.pi/roles/current.md`，与 `role_set` 同一条通道；
  Pi 的 role-inject 扩展每轮读取，切换即时生效，无需重启。
- 不传 → 写用户级 `experts/<id>.persona.md`，跨项目生效。

### 2.4 摘要的规范化

`normalize_definition` 会 trim 全部文本字段、丢弃空标签。
因此「同一份内容多敲一个空格」不会产生新摘要，用户不会因为格式微调就重走一遍发布确认。

---

## 三、与 Pi 的融合改造方案

| # | 融合点 | 本轮做法 | 后续 |
|---|--------|----------|------|
| 1 | 人格注入 | persona 写进 `.pi/roles/current.md`，走 role-inject 通道 | 已可用，无需改内核 |
| 2 | 专家 ⇄ 会话 | 会话尚未把激活的专家写进 `taskContext` | 下一步：会话可择一专家，preamble 追加「你正在扮演 X」 |
| 3 | 专家 ⇄ Skill 依赖 | `skill_requirements` 已声明 | 发布时若依赖未安装，给出 `definition/skill-missing`（硬编码 id 时才校验） |
| 4 | 专家 ⇄ 项目 | 项目配置的能力绑定与专家标签语义重叠 | 复盘：项目能力是否可由专家派生 |
| 5 | token 预算 | `expert_validate` 不查预算，persona 也无固定预算 | Pi 侧全局上下文预算统一收紧后，再把 persona token 计入 |
| 6 | 发布 → 内核可见 | 落盘即生效 | 若 role-inject 未扫描到，退化为 `role_set` 触发一次重扫 |

---

## 四、验证基线

| 检查项 | 结果 |
|--------|------|
| `cargo check --all-targets` | 0 error，0 warning |
| `cargo test --lib` | **107 passed / 0 failed**（其中专家域 14 条） |
| `pnpm typecheck` | exit 0 |
| `pnpm vitest run` | 9 files / **86 passed**（专家域前端 13 条） |
| `pnpm build` | ✓ built in 1.95s（dist/index.html + 3 chunk） |
| `pnpm check:matrix` | skills + extensions 全部通过 |
| `pnpm app:preflight` | Node 22.22.2 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲 |
