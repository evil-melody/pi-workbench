import { t } from '@/i18n'
/**
 * 工具调用行的语义摘要（1:1 对齐 WorkDSH `@deepseek-ai/dsh-client-ui-tool`）。
 *
 * 实证来源：/tmp/dsh-ui/deepseek-ai-dsh-client-ui-tool-0.0.1-rc.1/package/lib/client.js
 * 的 `TOOL_VARIANTS` / `TOOL_TITLES` / `VARIANT_TITLES` / `SUMMARY_KEYS` /
 * `relativizeToCwd` / `deriveSummary` / `toolRowModel`。dsh 折叠行显示的是
 * 「标题 · 摘要」而不是参数 JSON，摘要按工具变体取指定字段、只取首行、
 * 工作区内的绝对路径削成相对路径。这里逐条照搬，字段名与顺序保持一致，
 * 便于将来对拍 dsh 升级。
 *
 * dsh 里**没有**「连续多个工具调用分组折叠」这一层：`ToolCallTree` 只在
 * 父子调用（`block.subCalls`）之间缩进嵌套，同级调用各占一行。所以这里
 * 同样不做分组，避免造出目标产品没有的结构。
 */

/** 变体 → 行标题（dsh 注释：Figma 设计字面量，不参与翻译）。 */
export const VARIANT_TITLES: Record<string, string> = {
  search: 'Search',
  read: 'Read',
  bash: 'Bash',
  write: 'Write',
  edit: 'Edit',
  code: 'Code',
  others: 'Tool call',
}

/** 已知工具名 → 变体（dsh 原表；Pi 侧新增的名字按语义就近归类）。 */
export const TOOL_VARIANTS: Record<string, string> = {
  bash: 'bash',
  pwsh: 'bash',
  read: 'read',
  web_fetch: 'read',
  web_search: 'search',
  grep: 'search',
  glob: 'search',
  write: 'write',
  edit: 'edit',
  run_code: 'code',
  cordis_inspect: 'read',
  cordis_mount: 'code',
  cordis_unmount: 'others',
}

/** 工具自有标题：细化变体名但不替换变体。 */
export const TOOL_TITLES: Record<string, string> = {
  cordis_inspect: 'Inspect',
  cordis_mount: 'Mount temporary Plugin',
  cordis_unmount: 'Unmount temporary Plugin',
  pwsh: 'Pwsh',
}

/** 每个变体的摘要字段优先级（dsh `SUMMARY_KEYS` 原样）。 */
export const SUMMARY_KEYS: Record<string, string[]> = {
  bash: ['description', 'command'],
  read: ['path', 'file_path', 'url'],
  search: ['query', 'pattern', 'url'],
  write: ['path', 'file_path'],
  edit: ['path', 'file_path'],
  code: ['description'],
  others: [],
}

/** 摘要行的长度上限：dsh 靠 CSS 省略号截断，这里再兜一层，防止超长 JSON 整段进 DOM。 */
const SUMMARY_MAX = 240

/**
 * 变体 → 行图标。dsh 每个变体有自己的图标；本项目图标库没有逐变体的图形，
 * 按语义就近映射（终端 / 文件 / 搜索 / 编辑 / 代码 / 通用工具）。
 */
export const VARIANT_ICONS: Record<string, string> = {
  bash: 'terminal',
  read: 'file',
  search: 'search',
  write: 'file',
  edit: 'edit',
  code: 'code',
  others: 'tool',
}

/** 工具名 → 变体，未知工具落到 `others`。 */
export function classifyTool(toolName: string): string {
  return TOOL_VARIANTS[toolName] ?? 'others'
}

/**
 * 把工作区内的绝对路径削成相对路径（仅展示用）。
 *
 * 只处理「整串以 root + 分隔符开头」的情况——dsh 就是这么做的，所以
 * `ls -la /abs/path` 这类命令串保持原样，只有路径摘要会被缩短。
 */
export function relativizeToCwd(text: string, cwd?: string | null): string {
  if (cwd === undefined || cwd === null || cwd === '') return text
  const root = cwd.replace(/[/\\]+$/, '')
  if (text.startsWith(`${root}/`) || text.startsWith(`${root}\\`)) return text.slice(root.length + 1)
  return text
}

export function firstLine(text: string): string {
  const nl = text.indexOf('\n')
  return nl === -1 ? text : text.slice(0, nl)
}

/**
 * 工具行的运行状态（dsh `toolRowModel` 的 `state`）。
 *
 * dsh 原式：`!done ? 'running' : error.code === 'interrupted' ? 'stopped'
 * : isError ? 'error' : 'ok'`。Pi 内核的 `tool_execution_end` 只有 `isError`、
 * 没有 `error.code`，因此 `stopped` 这一档没有数据源，只做三态：
 * 有错误 → error；有结果 → ok；都没有 → 本轮还在流式就是 running，
 * 否则按已落定处理（回放里缺 result 的旧 chip 不该永远扫光）。
 */
export type ToolRowState = 'running' | 'ok' | 'error'

export function toolRowState(m: {
  toolResult?: string
  toolError?: boolean | string
  streaming?: boolean
}): ToolRowState {
  if (m.toolError) return 'error'
  if (m.toolResult) return 'ok'
  return m.streaming ? 'running' : 'ok'
}

/** 展开体里一段文本的可见行（dsh DiffBlock/ReadBlock 的 `maxLines: 8`）。 */
export interface ClippedText {
  /** 截断后待显示的文本。 */
  text: string
  /** 被折叠掉的剩余行数；0 = 未截断。 */
  hidden: number
}

/**
 * 按行截断长输出（对齐 dsh 的 maxLines + `terminal.expandRest`「展开剩余 N 行」）。
 *
 * dsh 只在非 terminal 类块截到 8 行；Pi 侧不区分工具，统一 8 行起步，
 * 因为展开体本身 260px 限高，一次摊几百行只是把滚动条推给用户。
 */
export function clipLines(text: string, max = 8): ClippedText {
  if (!text) return { text: '', hidden: 0 }
  const lines = text.split('\n')
  if (lines.length <= max) return { text, hidden: 0 }
  return { text: lines.slice(0, max).join('\n'), hidden: lines.length - max }
}

function parseArgs(argsRaw: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(argsRaw) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** 按字段优先级取第一个非空字符串。 */
function pickString(args: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const v = args[key]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}

/** dsh `deriveSummary`：指定字段 → 任意字符串字段 → 原始参数首行。 */
export function deriveSummary(variant: string, argsRaw: string): string {
  const parsed = parseArgs(argsRaw)
  if (typeof parsed !== 'object' || parsed === null) return firstLine(argsRaw)
  const picked = pickString(parsed, SUMMARY_KEYS[variant] ?? [])
  if (picked !== undefined) return firstLine(picked)
  for (const v of Object.values(parsed)) {
    if (typeof v === 'string' && v !== '') return firstLine(v)
  }
  return firstLine(argsRaw)
}

export interface ToolRowSummary {
  /** 行标题（Read / Bash / Search / Tool call …）。 */
  title: string
  /** 折叠态摘要（已相对化 + 单行 + 限长）。 */
  summary: string
  /** AppIcon 名。 */
  icon: string
}

/**
 * 一条工具调用的折叠行显示内容。
 *
 * `tool` 为空（名字还没回填）时只给中性标题，不编造摘要。
 * 未知工具走 dsh 的 `others` 规则：标题 `Tool call`，摘要前缀原始工具名。
 */
export function summarizeToolCall(
  tool: string,
  argsRaw: string,
  root?: string | null,
): ToolRowSummary {
  const variant = classifyTool(tool)
  if (!tool) return { title: VARIANT_TITLES.others, summary: '', icon: VARIANT_ICONS.others }
  const toolTitle = TOOL_TITLES[tool]
  const title = toolTitle ?? VARIANT_TITLES[variant]
  const base = relativizeToCwd(deriveSummary(variant, argsRaw || ''), root)
  // dsh 原条件：只有「未知工具」（others 且没有自有标题）才把 wire 名前置到摘要里。
  // dsh 无参数时用 callId 兜底，本项目拿不到 callId，直接只显示工具名，
  // 避免行尾留一个「name · 」的空尾巴（渲染层会把这种行显示成「无参数」占位）。
  const prefixed = variant === 'others' && toolTitle === undefined
  const summary = !prefixed ? base : base ? `${tool} · ${base}` : tool
  return { title, summary: clip(summary), icon: VARIANT_ICONS[variant] }
}

/** dsh `deriveBody`：参数能解析就缩进两格打印（展开体里读得下去），否则原样。 */
export function formatToolBody(argsRaw: string): string {
  if (!argsRaw) return ''
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return argsRaw
  return JSON.stringify(parsed, null, 2)
}

/** 展开体的一段（label 列 + 内容列，见 CollapsibleRow 的 grid）。 */
export interface ToolArgBlock {
  label: string
  text: string
  /** true = 代码 / 内容块（多行、保留空白）；false = 单行元信息（路径）。 */
  code: boolean
}

/** 路径 / 内容的多种写法（内核与桥的参数键名没有统一约定）。 */
const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'target', 'url']
const CONTENT_KEYS = ['content', 'text', 'body', 'data', 'newString', 'new_string', 'newText']
const OLD_KEYS = ['oldString', 'old_string', 'oldText']
const COMMAND_KEYS = ['command', 'cmd', 'script']

/**
 * 已知工具的参数结构化（P0-3a）。
 *
 * `formatToolBody` 的 JSON dump 是展开体里最大的噪声：bash 的 `{"command":"ls -la"}`
 * 该直接显示成命令原文，edit/write 该是「路径一行 + 内容块」。取不到已知字段
 * 才回落 JSON——未知形状编造语义比多打几个花括号更糟。
 */
export function toolArgsBlocks(tool: string, argsRaw: string, root?: string | null): ToolArgBlock[] {
  if (!argsRaw) return []
  const parsed = parseArgs(argsRaw)
  if (parsed === undefined) return [{ label: t('参数'), text: argsRaw, code: true }]

  const variant = classifyTool(tool)
  const command = pickString(parsed, COMMAND_KEYS)
  if (command && (variant === 'bash' || variant === 'code')) {
    return [{ label: t('命令'), text: command, code: true }]
  }

  const path = pickString(parsed, PATH_KEYS)
  if (path && (variant === 'read' || variant === 'write' || variant === 'edit' || variant === 'others')) {
    const blocks: ToolArgBlock[] = [{ label: t('路径'), text: relativizeToCwd(path, root), code: false }]
    const old = pickString(parsed, OLD_KEYS)
    const next = pickString(parsed, CONTENT_KEYS)
    if (old) blocks.push({ label: t('替换前'), text: old, code: true })
    if (next) blocks.push({ label: old ? t('替换后') : t('内容'), text: next, code: true })
    return blocks
  }

  return [{ label: t('参数'), text: JSON.stringify(parsed, null, 2), code: true }]
}

/** 结果 / 错误块拆出的退出码（终端输出的最后一行才是「跑没跑成」的答案）。 */
export interface ExitSplit {
  /** 去掉退出码行之后的正文。 */
  body: string
  /** 退出码原文（`exited with code 1`）；没有则空串。 */
  exit: string
}

/**
 * 把退出码从输出末尾摘出来。
 *
 * `ponytail:` 前端源码里没有退出码文案的实证样本（内核与 CLI 写法会变），
 * 因此只匹配常见的三种收尾写法且锚定行尾；匹配不上就整段当正文，宁可少格式。
 * 升级路径：内核若在 payload 里给 `exitCode` 数字字段，直接读它。
 */
export function splitExitCode(text: string): ExitSplit {
  if (!text) return { body: '', exit: '' }
  const m = text.match(/(?:^|\n)\s*(exited with code\s*-?\d+|exit\s+code\s*:?\s*-?\d+|status:\s*exit\s*\d+)\s*$/i)
  if (!m) return { body: text, exit: '' }
  return { body: text.slice(0, m.index).replace(/\n+$/, ''), exit: m[1].trim() }
}

function clip(s: string): string {
  return s.length > SUMMARY_MAX ? `${s.slice(0, SUMMARY_MAX)}…` : s
}
