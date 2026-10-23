/**
 * G2 文件改动提取：把 Pi 内核的 edit/write 工具调用参数折算成结构化记录。
 *
 * 数据来源（内核实证）：
 * - `tool_execution_start` 事件：`{ toolName, args, toolCallId }`——agent 事件经
 *   agent-session 转发给 RPC 客户端，`args` 即工具入参原样。
 * - `message_update` 内层 `toolcall_end`：`{ toolCall: { id, name, arguments } }`——
 *   pi-ai 流式协议的终点事件，同样带完整入参。
 *
 * 参数形状以内核 tool schema 为准（`dist/core/tools/edit.js`、`write.js`）：
 * - edit：`{ path, edits: [{ oldText, newText }] }`
 * - write：`{ path, content }`
 *
 * 纯函数、不依赖 Tauri，可单测。**不猜协议**：认不出的形状一律返回 null，
 * 由调用方决定忽略（对话区不显示），绝不在数据不全时编造 diff。
 */

/** 一次文件改动（来自一次 edit/write 工具调用）。 */
export interface PiFileChange {
  /** 工具调用 id：同一调用可能从多个事件通道到达，按它去重。 */
  id: string
  tool: 'edit' | 'write'
  /** 文件路径（内核给的原样值，可能是相对路径）。 */
  path: string
  /** edit：若干处精确替换；write：空数组。 */
  edits: { oldText: string; newText: string }[]
  /** write：整文件内容；edit：null。 */
  content: string | null
}

/** 归一化工具名：小写去空白。 */
function normTool(v: unknown): string {
  return typeof v === 'string' ? v.trim().toLowerCase() : ''
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 从脏数据里捞合法的 edit 对；非字符串字段的条目跳过。 */
function cleanEdits(raw: unknown): { oldText: string; newText: string }[] {
  let list = raw
  // 有的模型把 edits 序列化成 JSON 字符串发（内核 edit.js 自己也会先解析一遍）。
  if (typeof list === 'string') {
    try {
      list = JSON.parse(list)
    } catch {
      return []
    }
  }
  // 单条 edit 对象（非数组）按一条处理。
  if (isObj(list) && typeof list.oldText === 'string' && typeof list.newText === 'string') {
    return [{ oldText: list.oldText, newText: list.newText }]
  }
  if (!Array.isArray(list)) return []
  const out: { oldText: string; newText: string }[] = []
  for (const item of list) {
    if (isObj(item) && typeof item.oldText === 'string' && typeof item.newText === 'string') {
      out.push({ oldText: item.oldText, newText: item.newText })
    }
  }
  return out
}

/**
 * 从工具调用事件里提取文件改动；非 edit/write 或参数不完整返回 null。
 *
 * @param toolName 工具名（大小写不敏感）
 * @param args 工具入参（对象）
 * @param callId 工具调用 id（可选；缺失时按 `tool:path` 生成稳定 id 供去重）
 */
export function extractFileChange(
  toolName: unknown,
  args: unknown,
  callId?: unknown,
): PiFileChange | null {
  const tool = normTool(toolName)
  if (tool !== 'edit' && tool !== 'write') return null
  if (!isObj(args)) return null
  const path = args.path
  if (typeof path !== 'string' || !path.trim()) return null
  const id =
    typeof callId === 'string' && callId.trim() ? callId.trim() : `${tool}:${path}`
  if (tool === 'write') {
    const content = args.content
    if (typeof content !== 'string') return null
    return { id, tool, path, edits: [], content }
  }
  const edits = cleanEdits(args.edits)
  if (edits.length === 0) return null
  return { id, tool, path, edits, content: null }
}

/** 一行摘要：edit 报处数，write 报行数。 */
export function summarizeChange(c: PiFileChange): string {
  if (c.tool === 'write') {
    // 空内容算 0 行（`''.split('\n')` 会给出 1，不符合直觉）。
    const lines = c.content === '' ? 0 : (c.content ?? '').split('\n').length
    return `${lines} 行`
  }
  return `${c.edits.length} 处替换`
}

/** diff 显示行：add=新增、del=删除。 */
export interface DiffLine {
  kind: 'add' | 'del'
  text: string
}

/**
 * 把一次改动摊成可显示的 diff 行。
 *
 * edit：按替换对输出 `- oldText` / `+ newText`（内核只给片段，没有整文件原文，
 * 不做行级对齐——如实呈现比假装 unified diff 诚实）。
 * write：整文件内容全部计为新增。
 */
export function diffLines(c: PiFileChange): DiffLine[] {
  if (c.tool === 'write') {
    return (c.content ?? '').split('\n').map((text) => ({ kind: 'add' as const, text }))
  }
  const out: DiffLine[] = []
  for (const e of c.edits) {
    for (const t of e.oldText.split('\n')) out.push({ kind: 'del', text: t })
    for (const t of e.newText.split('\n')) out.push({ kind: 'add', text: t })
  }
  return out
}
