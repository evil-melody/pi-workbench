/**
 * Pi extension: 专家角色注入
 *
 * 依据 Pi 官方 extension API（dist/core/extensions/types.d.ts）：
 * - on("before_agent_start") 的 handler 可返回 { systemPrompt } 覆盖本轮完整提示
 * - 事件上下文的 systemPromptOptions 是 NormalizedBuildSystemPromptOptions，
 *   其中的 appendSystemPrompt 会被 buildSystemPromptSections 渲染为 addendum 段，
 *   既生效又不覆盖 Pi 自带的 tools/rules/docs 段 —— 这是追加而非替换的正道。
 *
 * 角色描述由 Rust 侧（src-tauri/src/roles.rs）写入项目级：
 *   <项目根>/.pi/roles/current.md
 * 首行 `<!-- role: <id> | <name> -->`，其余正文为要追加的系统提示。
 * 前端切换角色即重写该文件，无需重启 Pi。
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const CURRENT_FILE = path.join(".pi", "roles", "current.md");

interface RoleHeader {
  id: string;
  name: string;
  prompt: string;
}

/** 解析 current.md；缺文件、缺头、无正文一律返回 null（走 Pi 默认提示）。 */
function readCurrentRole(cwd: string): RoleHeader | null {
  const file = path.join(cwd, CURRENT_FILE);
  if (!existsSync(file)) return null;
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = text.split("\n");
  const header = (lines[0] ?? "").trim();
  if (!header.startsWith("<!-- role:")) return null;
  const inner = header.replace(/^<!--\s*role:/, "").replace(/-->$/, "").trim();
  const [id, name] = inner.split("|").map((s) => (s ?? "").trim());
  if (!id) return null;
  const prompt = lines.slice(1).join("\n").trim();
  if (!prompt) return null;
  return { id, name: name || id, prompt };
}

export default function (pi: any) {
  pi.on("before_agent_start", (ctx: any) => {
    const role = readCurrentRole(process.cwd());
    if (!role) return {};

    // 首选：追加到系统提示 addendum 段，保留 Pi 自带的工具/规则/文档段。
    const opts = ctx?.systemPromptOptions;
    if (opts) {
      const base = typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "";
      opts.appendSystemPrompt = `${base}${base ? "\n" : ""}## 当前角色：<${role.name}>\n\n${role.prompt}\n`;
      return {};
    }
    // 兜底：整体追加（会替换本轮提示，仅在 options 不可用时触发）。
    if (typeof ctx?.systemPrompt === "string") {
      return { systemPrompt: `${ctx.systemPrompt}\n\n## 当前角色：<${role.name}>\n\n${role.prompt}\n` };
    }
    return {};
  });
}
