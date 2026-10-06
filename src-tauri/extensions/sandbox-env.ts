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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
 * 目录为空时 list 返回 0 个环境、run 退回宿主 PATH，不静默假装沙箱生效。
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
        `nix: ${nixAvailable() ? "available" : "missing (host fallback)"}`,
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
    description: "在指定 Nix 沙箱环境内执行一条 shell 命令（环境由 flake 声明，可复现）",
    parameters: {
      type: "object",
      properties: {
        envId: {
          type: "string",
          description: "sandbox_list 返回的 env id；不传则使用当前环境",
        },
        command: { type: "string", description: "要执行的 shell 命令" },
        cwd: { type: "string", description: "工作目录，默认项目根" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: async (_toolCallId: string, args: any): Promise<ToolResult> => {
      const cwd = args?.cwd ?? process.cwd();
      const profile = path.join(cwd, ".pi", "envs", String(args?.envId ?? ""));
      const useProfile = existsSync(path.join(profile, "bin"));
      const env = { ...process.env };
      if (useProfile) {
        env.PATH = `${path.join(profile, "bin")}:${env.PATH ?? ""}`;
      }
      try {
        const out = execFileSync("sh", ["-lc", String(args?.command ?? "")], {
          cwd,
          env,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        return { content: out ?? "(ok)", details: { envId: args?.envId ?? null, usedProfile: useProfile } };
      } catch (e: any) {
        const msg = e?.stdout ? `${e.stdout}${e.stderr ?? ""}` : String(e?.message ?? e);
        return { content: msg, details: { envId: args?.envId ?? null, usedProfile: useProfile, failed: true } };
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

  // 4) 激活本插件的两个工具。
  //    不得传空数组：setActiveTools([]) 的语义是「只激活列出的工具」，会把内置工具全部停掉。
  try {
    pi.setActiveTools(["sandbox_list", "sandbox_run"]);
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
