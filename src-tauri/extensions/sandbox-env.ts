/**
 * Pi extension: 声明式沙箱环境 + 企业能力接缝（sandbox-env）
 *
 * 设计参考（Pi 官方 extension API）：
 * - ~/.pi/agent/extensions/*.ts 或项目 .pi/extensions/，Pi 用 jiti 直接加载 TS
 * - export default function (pi: ExtensionAPI) 注册能力
 * - pi.registerTool() 注册模型可调用工具；pi.registerCommand() 注册 / 命令
 * - pi.setActiveTools() 动态激活已注册工具（按需加载，破 token 焦虑）
 *
 * 本插件把「沙箱规则 / 企业 API 作为插件接入」落到 Pi 上：
 * 工具先全部注册但保持 inactive，由 sandbox_list 决定是否激活。
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

type ToolResult = { content: string; details?: unknown; terminate?: boolean };

/**
 * 读取工作区内已声明的沙箱环境。
 *
 * 布局是本扩展与外部工具链的约定（当前仓库里还没有 Rust 侧对应模块，
 * 环境目录由 `nix develop --profile` 之类的构建步骤产出）：
 *   <base>/.pi/sandboxes/<env_id>/flake.nix
 *   <base>/.pi/sandboxes/<env_id>/env.json
 *   <base>/.pi/envs/<env_id>            <- nix develop --profile 产物
 *
 * 目录为空时 list 返回 0 个环境；run 直接拒绝执行（fail-closed），
 * 不回退宿主 PATH——「以为在沙箱里、其实跑在宿主机」比不执行更危险。
 */
function sandboxesBase(cwd: string): string {
  return path.join(cwd, ".pi", "sandboxes");
}

function readEnvJson(file: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listEnvs(cwd: string) {
  const base = sandboxesBase(cwd);
  if (!existsSync(base)) return [];
  return readdirSync(base)
    .map((id: string) => {
      const meta = readEnvJson(path.join(base, id, "env.json"));
      const profile = path.join(cwd, ".pi", "envs", id);
      return {
        id,
        name: (meta?.name as string) ?? id,
        packages: (meta?.packages as string[]) ?? [],
        mode: (meta?.mode as string) ?? "unknown",
        ready: existsSync(path.join(profile, "bin")),
      };
    });
}

function nixAvailable(): boolean {
  try {
    execFileSync("nix", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

type ProfileCheck = { dir: string } | { error: string };

/**
 * 把 env_id 解析成已构建的 profile。
 *
 * fail-closed：env_id 缺失、未声明、未构建，一律返回错误；绝不回退宿主环境。
 * 走到这里的命令都是被判定为「风险」的，宿主执行正是要避免的那条路。
 */
function requireProfile(cwd: string, rawEnvId: unknown): ProfileCheck {
  const id = String(rawEnvId ?? "").trim();
  if (!id || !/^[A-Za-z0-9._-]+$/.test(id) || id === "." || id === "..") {
    const ids = listEnvs(cwd).map((e) => e.id);
    return {
      error:
        `sandbox_run 已改为 fail-closed，必须显式传 env_id。` +
        `可用环境：${ids.length ? ids.join(", ") : "无（先在 .pi/sandboxes 下声明并用 nix develop --profile 构建）"}`,
    };
  }
  if (!existsSync(path.join(sandboxesBase(cwd), id, "env.json"))) {
    return { error: `未声明的沙箱环境: ${id}（缺少 .pi/sandboxes/${id}/env.json）` };
  }
  const dir = path.join(cwd, ".pi", "envs", id);
  if (!existsSync(path.join(dir, "bin"))) {
    return { error: `沙箱环境未构建: ${id}（缺少 .pi/envs/${id}/bin）` };
  }
  return { dir };
}

// —— U9：session ↔ 沙箱环境绑定表 ——
// key = `<sessionId>:<entryId>`，value = 该分支当时使用的环境声明。
// 切换分支时查表，环境未构建/声明变化则尽力重建；无 nix 静默跳过。

function bindingsFile(cwd: string): string {
  return path.join(cwd, ".pi", "bindings.json");
}

function readBindings(cwd: string): Record<string, any> {
  try {
    return JSON.parse(readFileSync(bindingsFile(cwd), "utf8"));
  } catch {
    return {};
  }
}

function writeBindings(cwd: string, b: Record<string, any>) {
  try {
    mkdirSync(path.dirname(bindingsFile(cwd)), { recursive: true });
    // ponytail: 绑定表仅供尽力重建，容忍崩溃损坏，不做原子写
    writeFileSync(bindingsFile(cwd), JSON.stringify(b, null, 2));
  } catch {
    /* 不可写则忽略 */
  }
}

/** Pi 的 ToolDefinition 是单对象注册（name/label/description/parameters/execute），
 *  execute 签名为 (toolCallId, params, signal, onUpdate, ctx)。
 *  旧写法 registerTool("name", {...}) 会让 Pi 报 “Tool \"undefined\" must define an object parameter schema”。
 */
export default function (pi: any) {
  // 1) 环境清单工具：模型先看有哪些声明式环境
  pi.registerTool({
    name: "sandbox_list",
    label: "沙箱环境清单",
    description: "列出可用的 Nix 声明式沙箱环境（内容寻址，回滚即重建）",
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    execute: async (): Promise<ToolResult> => {
      const cwd = process.cwd();
      const envs = listEnvs(cwd);
      const lines = [
        `nix: ${nixAvailable() ? "available" : "missing"}（sandbox_run 在无就绪环境时拒绝执行）`,
        `envs: ${envs.length}`,
        ...envs.map((e) => `- ${e.id} ${e.name} [${e.mode}] ready=${e.ready} pkgs=${(e.packages as string[]).join(",")}`),
      ];
      return { content: lines.join("\n"), details: envs };
    },
  });

  // 2) 在指定环境内执行：PATH 前置 nix profile/bin
  pi.registerTool({
    name: "sandbox_run",
    label: "沙箱内执行命令",
    description: "在指定 Nix 沙箱环境内执行一条 shell 命令（环境由 flake 声明，可复现）；须显式传 env_id，无可用环境时拒绝执行",
    parameters: {
      type: "object",
      properties: {
        env_id: {
          type: "string",
          description: "必填：sandbox_list 返回且已构建的 env id（不传则拒绝执行）",
        },
        command: { type: "string", description: "要执行的 shell 命令" },
        cwd: { type: "string", description: "工作目录，默认项目根" },
      },
      required: ["command", "env_id"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: any): Promise<ToolResult> => {
      const cwd = args?.cwd ?? process.cwd();
      const check = requireProfile(cwd, args?.env_id);
      if ("error" in check) {
        return { content: check.error, details: { env_id: args?.env_id ?? null, failed: true, refused: true } };
      }
      const env = { ...process.env };
      env.PATH = `${path.join(check.dir, "bin")}:${env.PATH ?? ""}`;
      // D7 环境隔离：HOME/TMPDIR 指向 profile 内，避免沙箱进程写宿主目录。
      const home = path.join(check.dir, "home");
      const tmp = path.join(cwd, ".pi", "tmp", String(args?.env_id));
      mkdirSync(home, { recursive: true });
      mkdirSync(tmp, { recursive: true });
      env.HOME = home;
      env.TMPDIR = tmp;
      try {
        const out = execFileSync("sh", ["-lc", String(args?.command ?? "")], {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { content: out ?? "(ok)", details: { env_id: args?.env_id ?? null } };
      } catch (e: any) {
        const msg = e?.stdout ? `${e.stdout}${e.stderr ?? ""}` : String(e?.message ?? e);
        return { content: msg, details: { env_id: args?.env_id ?? null, failed: true } };
      }
    },
  });

  // 3) 命令：/sandbox 打印当前沙箱状态
  pi.registerCommand("sandbox", {
    description: "显示 Nix 沙箱状态与已建环境",
    handler: async (_arg: string, ctx: any) => {
      const cwd = ctx?.workingDirectory ?? process.cwd();
      const envs = listEnvs(cwd);
      ctx.ui?.notify(
        `sandbox: nix=${nixAvailable()} envs=${envs.length}`,
        "info",
      );
    },
  });

  // 4) U9 hook：分支切换后记录 leaf↔环境绑定。
  //    session_tree 的事件字段名未经内核文档坐实，防御式提取，取不到就跳过。
  pi.on("session_tree", async (event: any, ctx: any) => {
    const cwd = ctx?.workingDirectory ?? process.cwd();
    const sessionId = String(event?.sessionId ?? ctx?.sessionId ?? "");
    const leafId = String(event?.newLeafId ?? event?.leafId ?? "");
    if (!sessionId || !leafId) return;
    const envs = listEnvs(cwd);
    const env = envs.find((e) => e.ready) ?? envs[0];
    if (!env) return;
    const bindings = readBindings(cwd);
    bindings[`${sessionId}:${leafId}`] = {
      name: env.name,
      packages: env.packages,
      env_id: env.id,
    };
    writeBindings(cwd, bindings);
  });

  // 5) U9 hook：分支切换前查绑定表，环境未构建/声明变化则尽力重建。
  pi.on("session_before_tree", async (event: any, ctx: any) => {
    const cwd = ctx?.workingDirectory ?? process.cwd();
    const sessionId = String(event?.sessionId ?? ctx?.sessionId ?? "");
    const targetId = String(event?.targetEntryId ?? event?.entryId ?? "");
    if (!sessionId || !targetId) return;
    const binding = readBindings(cwd)[`${sessionId}:${targetId}`];
    if (!binding) return;
    const meta = readEnvJson(path.join(sandboxesBase(cwd), binding.env_id, "env.json"));
    const same =
      JSON.stringify((meta?.packages as string[]) ?? []) === JSON.stringify(binding.packages ?? []);
    const ready = existsSync(path.join(cwd, ".pi", "envs", binding.env_id, "bin"));
    if (same && ready) return;
    if (!nixAvailable()) return; // 无 nix：只尽力，不假装重建
    try {
      execFileSync(
        "nix",
        [
          "develop",
          "--profile",
          path.join(cwd, ".pi", "envs", binding.env_id),
          path.join(sandboxesBase(cwd), binding.env_id, "flake.nix"),
        ],
        { cwd, stdio: "ignore", timeout: 120000 },
      );
    } catch {
      /* 重建失败静默：sandbox_run 会因 profile 不就绪而拒绝执行 */
    }
  });

  // 6) 激活本插件的两个工具。
  //    不得传空数组：setActiveTools([]) 的语义是「只激活列出的工具」，会把内置工具全部停掉。
  try {
    pi.setActiveTools(["sandbox_list", "sandbox_run"]);
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
