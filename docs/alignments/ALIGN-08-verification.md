# WORK参考实现 对齐 08 — 全量验证记录

> 文档编号说明：编号 `08` 是为了让验证记录排在 `07-cleanup` 之后；内容仍是 **05 号「后端能力补齐」** 的收尾验证。

验证时间：2026-09-09 · 仓库 `NextCode`（Pi Workbench）· 内核 `pi@0.87.1` · Node 22.22.2 · Rust `cargo 1.98.1` · Tauri CLI 2.11.5

---

## 1. 验证矩阵总览

| # | 命令 | 期望 | 实测 | 结论 |
|---|---|---|---|---|
| 1 | `pnpm typecheck` | vue-tsc 零报错 | 无输出 | ✅ |
| 2 | `pnpm build` | 构建成功 | 107 modules，见 §2 | ✅ |
| 3 | `pnpm test` | vitest 全绿 | 25/25，`tests/` 2 文件 | ✅ |
| 4 | `pnpm check:matrix` | skills + extensions 双通过 | 2 个扩展通过 | ✅ |
| 5 | `cargo check` | 编译通过 | Finished in 0.52s | ✅ |
| 6 | `cargo test --lib` | 全绿 | **51 passed / 0 failed** | ✅ |
| 7 | `pnpm app:preflight` | 环境就绪 | 4 项全绿 | ✅ |
| 8 | `pnpm app:dev` | 窗体拉起 + 内核就绪 | 见 §3 | ✅ |
| 9 | `pnpm app:check` | 见 §4 | 见 §4 | ⚠️ 告警 |

---

## 2. 前端构建产物

```
vite v5.4.21 building for production...
✓ 107 modules transformed.

dist/index.html                         0.40 kB │ gzip:   0.27 kB
dist/assets/index-b1XGrLtq.css         49.78 kB │ gzip:   8.69 kB
dist/assets/docx-preview-bw4jluI6.js  174.15 kB │ gzip:  51.35 kB
dist/assets/index-BSLdJoGm.js         186.05 kB │ gzip:  70.59 kB
dist/assets/xlsx-CWc3kuOC.js          428.99 kB │ gzip: 143.07 kB
✓ built in 5.45s
```

模块数 **126 → 107**，与 07 号文档删除 4 个旧面板（及其子树）的数量吻合，无孤儿模块残留。

---

## 3. `pnpm app:dev` 实拉窗体

```
[preflight] Pi Workbench 环境检查
  ✔ Node 22.22.2
  ✔ pi 0.87.1
  ✔ cargo cargo 1.98.1 (797e8a9bc 2026-08-05)
  ✔ tauri tauri-cli 2.11.5
  ✔ 端口 1420 空闲

[dev] 编译内核并拉起 Tauri 窗体…
  Vite 开发服务器在 http://localhost:1420/
  ➜  Local:   http://localhost:1420/
  Running DevCommand (`cargo run --no-default-features --`)
  Info  Watching /Users/tatsuma/Documents/NextCode/src-tauri for changes...
  Finished `dev` profile in 0.42s
  Running `target/debug/pi-workbench`
能力清单已加载：技能目录 2 个，内置工具 4 个，扩展 2 个
```

Rust 侧进程 `target/debug/pi-workbench` 成功启动并打印能力清单，Tauri 主进程与 Vite dev server 均正常。窗体拉起后已主动关闭（`pkill -f "pi-workbench"`），无残留进程。

---

## 4. `pnpm app:check` 结果（含告警）

```
[preflight] 环境检查
  ✔ Node 22.22.2
  ✔ pi 0.87.1
  ...
[check:skills]  31 个技能全部通过（~/.pi/agent/skills/* 与仓库内置）
[check:extensions] 2 个扩展通过
```

### ⚠️ 告警 1：pnpm 版本不匹配（非阻断）

```
[WARN] This project is configured to use 12.6.0 of pnpm. Your current pnpm is v11.21.0
Corepack invoked pnpm with this version, and pnpm does not switch versions when running under corepack.
```

- 根因：`package.json` 的 `packageManager` 声明 pnpm **12.6.0**，但本机 corepack 只装了 **11.21.0**，corepack 不会自动切换版本。
- 影响：仅告警，不影响 `dev` / `build` / `test`。但 **`pnpm app:dev` 走的 `tauri dev` 会继承这个降级版本**，若将来脚本依赖 12.x 的新行为会静默出错。
- 建议：`corepack prepare pnpm@12.6.0 --activate`，或把 `packageManager` 降到本机实际版本。

### ⚠️ 告警 2：`artifacts.rs` 多余分号

```
warning: unnecessary trailing semicolon
   --> src/artifacts.rs:507:38
    |
507 |         let d = tmpproj("traversal");;
    |                                      ^ help: remove this semicolon
warning: `pi-workbench` (lib test) generated 9 warnings
```

9 条 warning（本次仅摘录典型的 1 条）。同类 `let x = ...;;` 写法。建议按 RULE 最小 diff 原则逐处清掉，**不影响功能**。

---

## 5. Rust 单测明细（51 passed）

| 模块 | 通过 | 覆盖点 |
|---|---|---|
| `capabilities::` | 4 | 畸形 JSON 拒绝、未知版本拒绝 |
| `extensions::` | 4 | 嵌套括号参数、必需工具缺失、header 读取、工具/命令名 |
| `fs::` | 4 | 路径逃逸、相对穿越、符号链接逃逸 |
| `pi_bridge::` | 7 | RPC id 读取、seq 单调、pending 单次消费、响应与事件分流、并行调用不串路由 |
| `roles::` | 4 | 内置角色覆盖、token 预算、role.md 往返、缺 header 拒绝 |
| `sandbox::` | 2 | spec id 内容寻址、跨平台 flake 声明 |
| `skills::` | 11 | frontmatter 解析 / 命名校验 / 目录扫描 / 前缀判定 / 引号剥离 |
| `tools::` | 4 | 激活去重、仅移除指定项、不破坏无关 settings、settings 缺失回退内置 |
| **合计** | **51** | 0 failed |

> 之前担心的「全量跑会被 SIGTERM（exit 137）」在本轮不成立：全量 `cargo test --lib` 耗时 0.01s。原因是测试全部是纯函数、无 IO 等待。后续无需再分批。

---

## 6. Vitest 明细

```
 ✓ tests/sessionTree.spec.ts (10 tests) 2ms
 ✓ tests/piEvents.spec.ts   (15 tests) 3ms
 Test Files  2 passed (2)
      Tests  25 passed (25)
```

---

## 7. 本轮验证暴露的待办

| 优先级 | 事项 | 来源 |
|---|---|---|
| P1 | `corepack prepare pnpm@12.6.0 --activate`，消除 pnpm 版本告警 | §4 告警 1 |
| P2 | 清理 `src/artifacts.rs` 等 9 处 warning | §4 告警 2 |
| P1 | `CapabilitiesView` 技能安装接通后端（当前占位按钮） | 07 号 §5 |
| P1 | 连接器 tab 补工具注入白名单 UI | 07 号 §5 |
