# 资料库完整化（D 轮）—— 资产域 / 转换器 / 检索 / 修订 / 配额

对齐目标：`外部参考实现` → `packages/plugins/library`（资产表 + 原件 + 检索文本 + 修订快照三层事实）。
内核仍是 `pi-coding-agent 0.87.1`。本轮把资料库从「目录树 + 文本框 + `localStorage` 假标记」升级为
**有资产表、有转换器、有检索、有修订、有配额的后端域**。

---

## 一、完成度清单

### 1.1 后端（`src-tauri/src/library.rs`，约 1470 行）

| # | 能力 | 实现要点 | 状态 |
|---|------|----------|------|
| 1 | 领域模型 | `AssetKind`（7 种）/ `AssetOrigin` / `LibraryAsset` / `LibraryRevision` | ✅ |
| 2 | 资产表落盘 | `library.json`（`assets` / `revisions` / `recent` / `written`），启动时读回 | ✅ |
| 3 | 三层事实 | 资产表 `library.json` / 原件 `library/` / 产物 `library/.index/*.txt` + `library/.revisions/<id>/<rev>.txt` | ✅ |
| 4 | 检索文本是产物 | 删资产时一起删；重建时按原件重算，不从索引恢复 | ✅ |
| 5 | 文本转换器 | MD / TXT 直取，HTML 剥标签（`<script>` / `<style>` 整段丢） | ✅ |
| 6 | PDF 转换器 | 只提未压缩内容流的 `(...) Tj / TJ`，带回退续扫 | ✅ |
| 7 | 明确不支持 | DOCX / PPTX（`zip` 容器内）/ Other 直接 `Err`，不装「部分支持」 | ✅ |
| 8 | PDF 质量闸门 | 可打印字符占比 < 0.85 判为编码流，宁可标「不可搜索」 | ✅ |
| 9 | 空转换闸门 | 转换结果为空一律报错，不给空索引充数 | ✅ |
| 10 | 配额 | 单文件 50 MiB `MAX_FILE_BYTES` / 合计 5 GiB `MAX_TOTAL_BYTES` | ✅ |
| 11 | 修订上限 | 每资产 `MAX_REVISIONS = 20`，超了丢最旧并删快照 | ✅ |
| 12 | 路径安全 | `validate_rel` 拒空段 / `.` / `..` / 控制字符；`validate_name` 拒 `.` 开头与分隔符 | ✅ |
| 13 | 路径由后端拼 | 前端只给相对目录，不接受绝对路径 | ✅ |
| 14 | 命令注册 | 18 条 `library_*` 全量注册进 `lib.rs` 的 `invoke_handler` | ✅ |
| 15 | 启动加载 | `setup` 里 `library::load_store(&handle)` 恢复资产表 | ✅ |
| 16 | Rust 测试 18 条 | 校验 / 转换 / 配额 / 去重 / 修订归属 / 部分 JSON 兼容，全绿 | ✅ |
| 17 | 编译零告警 | `cargo check --all-targets` 0 error 0 warning | ✅ |

### 1.2 前端

| # | 能力 | 位置 | 状态 |
|---|------|------|------|
| 1 | 18 条命令封装 + 错误码翻译 + 三张文案表 + 格式化 | `composables/useLibrary.ts` | ✅ |
| 2 | `formatBytes` / `formatTime` | 同上 | ✅ |
| 3 | 四个 tab 全接后端（资料库 / 搜索 / 最近 / 输出） | `components/panels/LibraryPanel.vue` | ✅ |
| 4 | 配额条（已用 / 合计） | 同上（页头） | ✅ |
| 5 | 目录树懒加载 + 草稿 / 停用标记 | 同上（左栏） | ✅ |
| 6 | 正文预览编辑 + 元信息条 + 转换失败原因 | 同上（右栏） | ✅ |
| 7 | 非文本格式走「原件」通道，不给 textarea | 同上 | ✅ |
| 8 | 搜索命中卡片（目录 / 类型 / 来源 / 修订 / 段号 / snippet） | 同上 | ✅ |
| 9 | 新建 / 重命名 / 移动 / 导入 / 修订历史 5 个弹窗 | 同上 | ✅ |
| 10 | 删除二次确认（明示会连带删索引与快照） | 同上 | ✅ |
| 11 | `localStorage` 假标记已删除，最近 / 输出改走后端 | 同上 | ✅ |
| 12 | `LibraryPanel.css` 补齐新样式（配额条 / 命中卡 / 元信息 / 修订列表 / 按钮变体） | `components/panels/LibraryPanel.css` | ✅ |
| 13 | Vitest 9 条 | `tests/libraryDomain.spec.ts` | ✅ |

### 1.3 本轮修掉的 16 个真实缺陷

| # | 缺陷 | 根因 | 修复 |
|---|------|------|------|
| 1 | `html_to_text` 死循环，日志刷出 738 万行 | `raw[i..].find('>')` 返回**相对**下标，被当成绝对下标用 | `Some(f) => i + f` |
| 2 | HTML 转换输出中文变 `ç¬¬ä¸\u{80}æ®µ` | 按字节遍历 `as_bytes()[i] as char`，UTF-8 被拆成乱码 | 改按 `chars().next()` + `len_utf8()` 前进 |
| 3 | PDF 提取出乱码，被质量闸门拒 | 逐字节 `push(c as char)` | 先 `String::from_utf8_lossy(&b[start..j])` 再解转义 |
| 4 | `<style>` 内容没丢，被当成正文 | 标签名把 `>` 算进去，`<style>` 读成 `style>`，跳过状态永远设不上 | `raw.get(i + 1..close)` 取不含 `>` 的部分 |
| 5 | PDF 只提出第一段，后面的段丢失 | TJ 数组里的间距数字被判为「非正文」后 `i = j + 1` 跳过余下字符串 | 回溯一个字节判断 `in_array`；未取到时 `i = start` 继续扫 |
| 6 | 段号从 2 开始跳号 | 段号用了物理行号，空行也占号 | 改成「第几段」计数 |
| 7 | `open_path(&PathBuf)` 编译不过 | 签名是 `impl Into<String>` | `to_string_lossy().into_owned()` |
| 8 | `cannot borrow store mutable more than once` | `find_mut(&mut store)` 后仍访问 `store.revisions` / `recent` / `written` | 先 clone 副本改，最后一次 `find_mut` 提交 |
| 9 | `unused_assignments` 告警（rollback） | `let mut next = write_body(..)?` 后面被覆盖 | 改为不使用中间变量 |
| 10 | 字节串字面量里写中文报 non-ASCII | `b"…(第一段) Tj…"` | 去掉 `b` 前缀，传 `.as_bytes()` |
| 11 | `validate_rel("$bad/name")` 误放行 | 上一版白名单收得太死拒了中文，改宽后放开过头 | 路径只拒空段 / `.` / `..` / 控制字符，放通 Unicode |
| 12 | `validate_name("")` 报 `name-invalid` | 空与纯空白被当成「填了不合法」 | 拆成 `name-required` 与 `name-invalid` 两个分支 |
| 13 | 前端模板里 `(() => { dialogName = ''; dialog = 'create' })()` | 模板内联箭头里对 ref 赋值，vue-tsc 无从校验 | 抽出 `openCreate()` / `openRename()` / `openMove()` 方法 |
| 14 | `submitCreate` 新建后选不中新资产 | 先把 `dialogName` 清空再拿它去 `find` | 先取 `name` 局部变量，并用返回值里的 `asset.id` |
| 15 | Vitest `STATE_TEXT['streamable-http']` 报 TS7053 | `Record<ConnectorState, string>` 不容许 transport 值索引 | 断言的就是「transport 不该混进状态表」，显式 `as Record<string, string \| undefined>` |
| 16 | `.preview-editor` 与子组件 `.app-textarea` 特异性相同 | 同 class 落在子组件根节点，谁在后谁生效 | 提升到 `.lib-preview .preview-editor` 压过去 |

---

## 二、后端实现逻辑

### 2.1 三层事实与职责边界

```
library.json（资产表：元数据 / 修订登记 / 最近·最近写入 id）
        │
        ├──→ library/<相对路径>            原件，永远保留，只读不改
        ├──→ library/.index/<id>.txt       检索文本，是产物不是源
        └──→ library/.revisions/<id>/<rev>.txt   修订快照
```

| 事实 | 谁改 | 什么时候改 |
|------|------|-----------|
| 资产表 | 后端 | 任何增删改名下操作后落盘 |
| 原件 | 写入 / 导入 / 回滚 | 写正文时覆盖，失败不动它 |
| 检索文本 | `reindex()` | 写入、导入、重建之后按**原件**重算 |
| 修订快照 | `write_body()` | 覆盖前对旧正文留快照 |

关键点：**检索文本不是源**。删资产时先删原件再删索引（顺序反了，中途失败会留下指不到文件的孤儿索引）。
启动时不恢复检索文本 —— 要用的时候按原件重算，而不是把磁盘上的产物当事实。

### 2.2 五条不可打折扣的语义

1. **原件永远保留**。转换失败只标记「不可搜索 + 转换失败」，不删不改原件；
2. **停用立即封锁**。`library_read` / `library_open` 一律拒，历史任务引用也一样拒，不搞「当前会话里就放行」；
3. **修订是资产的一部分**。每次写入留快照，可列出、可回滚，上限 20 版；
4. **检索文本随资产一起删**；
5. **新建即草稿**。草稿不进检索，必须显式 `library_publish`。

### 2.3 状态迁移

```
library_create ──→ draft=true, searchable=false, revision=1
                        │
                        ├─ library_publish ──→ draft=false ──→ 进入 library_search 候选
                        └─ library_set_enabled(false) ──→ 正文读取被拒
                                    │
                                    └─ library_set_enabled(true) ──→ 恢复可读

library_write ──→ 旧正文留快照(.revisions/<id>/<rev>.txt) → 覆盖原件 → reindex() → 记 origin=written
                   （内容没变就不动，避免重复保存堆出一串一模一样的修订）

library_rollback(rev) ──→ 取快照回写 ──→ 生成新修订（不是删除后续版本）
```

`draft` 与 `enabled` 是两个正交维度：草稿管「能不能被搜到」，启用管「能不能被读到」。
停用的资产即使发布了也搜不到（`search` 里直接 `continue`）—— 能搜到却读不出来，比搜不到更糟。

### 2.4 转换器与质量闸门

| 类型 | 处理 | 失败 |
|------|------|------|
| `markdown` / `text` | 去 BOM 直取 | 空正文 → `Err` |
| `html` | `html_to_text`：剥标签，`<script>` / `<style>` 整段丢，块级标签换 `\n`，最后解实体 | 空正文 → `Err` |
| `pdf` | `pdf_to_text`：扫 `(...) Tj / TJ`，处理 `\n \r \t \b \f` 转义，**可打印字符占比 ≥ 0.85** | 空 / 疑似编码流 → `Err` |
| `docx` / `pptx` | 无 zip 解码器 | 明确 `Err`（装一个"部分支持"只会让原件更难找） |
| `other` | 未注册 | 明确 `Err` |

PDF 判据用「有没有可打印字符」而不是「是不是 ASCII」：中文正文在 PDF 里同样合法，
按 ASCII 比例会把正常文档误判成乱码。

### 2.5 检索流程

```
library_search(query)
   needle = query.to_lowercase()
   for asset in assets:
       跳过 !enabled 与 draft
       convert_status = searchable ? ready : (convert_error.is_some() ? failed : skipped)
       名字 / rel_path 命中  → score = 10，location = None
       若 searchable：读 .index/<id>.txt → iter_blocks 分段 → 段内命中
                      → score = 命中次数，location = 「第 N 段」，snippet 围绕命中截断
   按 score 降序；分数相同不额外发明排序口径（保持插入顺序稳定）
```

段号是「第几段」而不是「第几行」：`iter_blocks` 把空行折叠掉，空行不该占号。

### 2.6 配额与路径

| 限额 | 值 | 卡在哪 |
|------|-----|--------|
| 单文件 | 50 MiB | `assert_quota` 的 `adding > MAX_FILE_BYTES` |
| 合计 | 5 GiB（参考实现 口径） | `total_bytes(&store.assets) + adding > MAX_TOTAL_BYTES` |
| 每资产修订 | 20 | `trim_revisions` 丢最旧并删快照 |
| 检索文本单资产 | 512 KiB | 写入前截断 |
| 正文读取 | 512 KiB | `library_read` 截断 + `truncated` 标记 |

路径安全口径与 `crate::fs` 一致：**路径一律由后端拼**，前端只能给「相对目录」这种已净化的形状。
`validate_rel` 允许中文等 Unicode（`docs/报告.md` 合法），但拒空段 / `.` / `..` / 控制字符。

---

## 三、与 Pi 融合改造方案

| # | 事项 | 现状 | 与 Pi 的融合方式 | 优先级 |
|---|------|------|------------------|--------|
| 1 | 资料注入内核上下文 | 检索文本只在 UI 里显示 | 后续 `pi_start` 前把「会话选中的资料」转成 path 列表下发给内核读原件 | 现网可用 |
| 2 | 检索文本格式 | 纯文本，段以空行分隔 | 与 `@file` / 上下文附件共用一套「段落 → 编号」约定，方便内核引用「第 N 段」 | P1 |
| 3 | `docx` / `pptx` 转换 | 明确返回 `Err` | 接 `zip` crate 解 `word/document.xml` / `ppt/slides/slideN.xml`，先做纯文本抽取 | P1 |
| 4 | PDF 压缩流 | 只提未压缩部分 | 接 `pdf-rs` / `lopdf` 解 `FlateDecode` 内容流，保留现有质量闸门 | P2 |
| 5 | 停用阻断历史任务 | 已实现（`library_read` 直接拒） | 若内核侧已把正文灌进上下文，需额外记录「引用资料 + 快照时间」以便说明 | P2 |
| 6 | 修订与版本管理 | 资产内 20 版 | 与 `pi` 的 checkpoint 若能对上 id，可在回滚时同步恢复上下文 | P2 |
| 7 | 「输出」tab | 只列最近写入的资产 | 后续接内核产物落盘目录，形成真正的 outputs 域 | P2 |
| 8 | 转换器扩展 | `to_search_text` 单一入口 | 新增类型只改这一个 `match`，不改调用点 | 结构性预留 |

---

## 四、验证基线（全部通过）

| 命令 | 结果 |
|------|------|
| `pnpm typecheck`（`vue-tsc --noEmit`） | 通过，0 error |
| `pnpm build` | 通过，157 modules |
| `pnpm vitest run` | **111 passed**（新增 9 条资料库域） |
| `pnpm check:matrix` | 通过（技能 29 个 / 扩展 2 个） |
| `cargo check --all-targets`（`src-tauri`） | **0 error 0 warning** |
| `cargo test --lib`（`src-tauri`） | **139 passed，0 failed**（含 18 条 `library::`） |
| `pnpm app:preflight` | Node 22.22.2 / pi 0.87.1 / cargo 1.98.1 / 端口 1420 空闲 |

### 前端新增测试覆盖（`tests/libraryDomain.spec.ts`，9 条）

| 组 | 断言 |
|----|------|
| 错误码到人话 | 停用禁止读取的文案；五条语义各自对应错误码；认不得的错误码回退兜底而不是抛后端原文 |
| 文案表覆盖 | `ORIGIN_TEXT` 5 种取值 / `KIND_TEXT` 7 种取值 / `CONVERT_TEXT` 3 种取值，与 Rust 的 kebab-case 序列化一一对应 |
| 格式化 | 字节 1024 进制单位选择；零值是占位符而不是 1970 年；时间固定 `MM-DD HH:mm` 不带年份 |

> 说明：`cargo fmt` 对项目内既有文件（artifacts / experts / projects 等）本就存在格式差异，
> 本轮只保证 `cargo check --all-targets` 零告警，未做全仓 `cargo fmt`，避免在无功能收益的前提下制造大量无关 diff。
