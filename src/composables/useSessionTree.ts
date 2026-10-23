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

/**
 * 节点图标名（AUDIT-020）：返回 AppIcon 的 name，不再用 emoji 字符——
 * 图标体系统一走 UI Kit 的 AppIcon（随主题变色、线宽一致）。
 */
const KIND_ICON: Record<string, string> = {
  message: 'chat',
  thinking_level_change: 'sparkles',
  model_change: 'cpu',
  usage: 'zap',
  compaction: 'layers',
  branch_summary: 'branch',
  context_edit: 'edit',
  label: 'info',
  custom: 'tool',
}

export function iconOf(kind: string): string {
  return KIND_ICON[kind] ?? 'chevron-right'
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

/**
 * 展示层噪音过滤：内核自动重试 / 上下文修剪会往会话里写
 * 「(assistant 无正文)」空条目和 context_edit 条目——数据里要有（fork 结构靠它们），
 * 树上不必显示。纯函数，可单测。
 */
export function visibleNodes(nodes: FlatNode[]): FlatNode[] {
  return nodes.filter((n) => {
    if (n.kind === 'context_edit') return false
    if (n.kind === 'message' && n.text === '（assistant 无正文）') return false
    return true
  })
}

/**
 * 该条目能否分叉：Pi 的 RPC `fork` 默认 position=before，**只接受 user message
 * 条目**（见内核 agent-session-runtime.js：非 user message 直接抛
 * "Invalid entry ID for forking"）。UI 必须与这条硬约束对齐。
 */
export function canFork(node: FlatNode): boolean {
  return node.kind === 'message' && node.role === 'user'
}

/** 「分叉末端」的落点：最后一条 user message 的 id（重新打开它即从末端续跑）。 */
export function forkTargetId(nodes: FlatNode[]): string | null {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (canFork(nodes[i])) return nodes[i].id
  }
  return null
}
