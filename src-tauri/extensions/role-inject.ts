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

/**
 * 反废话纪律：从环境变量读，文本真源在 Rust 的 agent_style 模块。
 * Pi 启内核时由 pi_bridge 写入 PI_AGENT_TERSE；主对话与团队/舰队子进程
 * 读同一个变量，保证「所有 agent 调用」同一套输出纪律、单一真源不漂移。
 * 浏览器预览没有该变量时自然为空，不注入。
 */
function terseDirective(): string {
  return process.env.PI_AGENT_TERSE?.trim() ?? "";
}

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
    const terse = terseDirective();
    // 角色在前、纪律在后：切角色不覆盖纪律，纪律永远最后压轴。
    const roleBlock = role ? `## 当前角色：<${role.name}>\n\n${role.prompt}\n` : "";
    // 队长人设来自 WorkBuddy 插件，写的是 Agent 工具；本仓的真调度入口是
    // team_create + team_dispatch。补这段防止队长卡在找不到的 Agent 工具上。
    const isLead = !!role && (role.id === "code-crew-team-lead" || role.prompt.includes("团队协作机制"));
    const dispatchHint = isLead
      ? `\n## 调度工具（本环境）\n没有 Agent 工具。已建团队直接 team_dispatch（只有一个团队时可省略 team_id），team_create 仅在需要新建团队时用（成员键 e:<专家Id>）。team_dispatch 立即返回运行号，成员在后台跑；只调用一次，报错或重复也绝不重试、绝不用 bash 替成员干活；不要代写产出或等成员输出再回复。进度看「智能体」运行记录。`
      : "";
    const addendum = `${roleBlock}${dispatchHint}${roleBlock && terse ? "\n" : ""}${terse}`;
    if (!addendum) return {};

    // 首选：追加到系统提示 addendum 段，保留 Pi 自带的工具/规则/文档段。
    const opts = ctx?.systemPromptOptions;
    if (opts) {
      const base = typeof opts.appendSystemPrompt === "string" ? opts.appendSystemPrompt : "";
      opts.appendSystemPrompt = `${base}${base ? "\n" : ""}${addendum}`;
      return {};
    }
    // 兜底：整体追加（会替换本轮提示，仅在 options 不可用时触发）。
    if (typeof ctx?.systemPrompt === "string") {
      return { systemPrompt: `${ctx.systemPrompt}\n\n${addendum}` };
    }
    return {};
  });
}
