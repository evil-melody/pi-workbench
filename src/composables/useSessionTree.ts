/**
 * 会话树视图模型：把 Pi RPC 的 `get_tree` 结果（嵌套 SessionTreeNode[]）
 * 摊平成可渲染的缩进列表，并给出节点摘要。
 *
 * 只做纯数据变换——不碰 Pi 子进程、不碰 Tauri 命令，便于单测。
 */

export interface PiTreeNode {
  entry: {
    id: string
    type: string
    parentId: string | null
    timestamp?: string
    [k: string]: any
  }
  children: PiTreeNode[]
  label?: string
}

export interface FlatNode {
  /** 条目 id，用于 fork / 选中。 */
  id: string
  depth: number
  kind: string
  /** message 条目才有：user / assistant / … */
  role?: string
  text: string
  time: string
  /** 是否为当前分支末端（leaf）。 */
  isLeaf: boolean
  /** 该节点之下还有分支（同层出现过 fork）。 */
  hasBranch: boolean
}

const KIND_ICON: Record<string, string> = {
  message: '💬',
  thinking_level_change: '🧠',
  model_change: '🔀',
  usage: '⚡',
  compaction: '🗜',
  branch_summary: '🌱',
  context_edit: '✂️',
  label: '🏷',
  custom: '🔧',
}

export function iconOf(kind: string): string {
  return KIND_ICON[kind] ?? '·'
}

/** message 条目的正文。AgentMessage.content 可能是字符串，也可能是块数组。 */
function textOf(message: any): string {
  if (!message) return ''
  const content = message.content
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b === 'string' ? b : b?.text ?? JSON.stringify(b)))
      .join('')
  }
  return typeof content === 'object' && content ? JSON.stringify(content) : ''
}

/** 摘要：给树节点一行看得懂的文本。 */
export function summarize(entry: any): string {
  const type = entry?.type ?? 'unknown'
  if (type === 'message') {
    const text = textOf(entry.message).trim()
    const role = entry.message?.role ?? 'user'
    return text || `（${role} 无正文）`
  }
  if (type === 'thinking_level_change') return `思考级别 → ${entry.thinkingLevel ?? '?'}`
  if (type === 'model_change') return `模型 → ${entry.modelId ?? '?'}`
  if (type === 'usage') return `用量记录（${entry.kind ?? 'usage'}）`
  if (type === 'compaction') return '上下文压缩'
  if (type === 'branch_summary') return '分支摘要'
  if (type === 'context_edit') return '上下文编辑'
  if (type === 'label') return `标注：${entry.label ?? ''}`
  return `${type}（${entry?.id ?? ''}）`
}

function timeOf(entry: any): string {
  const t = entry?.timestamp
  if (typeof t !== 'string') return ''
  // 只取 hh:mm:ss，树里不需要完整日期
  return t.slice(11, 19) || ''
}

/** 摊平：深度优先。同层出现 2 个以上节点即为分叉，回填到各行。 */
export function flattenTree(
  nodes: PiTreeNode[],
  leafId: string | null,
  depth = 0,
  out: FlatNode[] = [],
): FlatNode[] {
  const branched = nodes.length > 1
  for (const node of nodes) {
    const entry = node.entry
    out.push({
      id: entry?.id ?? '',
      depth,
      kind: entry?.type ?? 'unknown',
      role: entry?.message?.role,
      text: summarize(entry),
      time: timeOf(entry),
      isLeaf: !!leafId && leafId === entry?.id,
      hasBranch: branched,
    })
    flattenTree(node.children ?? [], leafId, depth + 1, out)
  }
  return out
}
