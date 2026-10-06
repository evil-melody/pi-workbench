import type { PiMsg } from './usePi'

/**
 * 内核流式事件 → 消息列表的折算逻辑。
 *
 * 单独成文件是为了可测：`usePi()` 依赖 Tauri IPC，单测里跑不起来；
 * 这里只做纯折算，测试不需要任何内核环境。
 */
export interface EventCtx {
  messages: PiMsg[]
  /** 当前是否正在流式输出。 */
  streaming: boolean
  /** 生成新消息 id；同一个 ctx 连续追加时 id 必须递增且唯一。 */
  nextId: () => string
  /** 会话级 token 用量（真实来自内核事件，非估算）。 */
  usage: UsageState
}

/** Pi 内核上报的单条用量（provider 原始数据透传，不做估算）。 */
export interface PiUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning?: number
  totalTokens: number
  cost: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    total: number
  }
}

/** 会话累计：直接镜像内核 `message_update.usage`（内核维护的会话累计值）。 */
export interface UsageState {
  /** 最近一次上报的累计用量；内核未上报时为 null。 */
  last: PiUsage | null
}

export function emptyUsageState(): UsageState {
  return { last: null }
}

/** 从事件记录里提取 usage 对象（只接受形状合法的对象）。 */
export function extractUsage(value: unknown): PiUsage | null {
  if (!value || typeof value !== 'object') return null
  const u = value as Record<string, unknown>
  if (typeof u.input !== 'number' || typeof u.output !== 'number') return null
  if (typeof u.totalTokens !== 'number') return null
  const cost = (u.cost ?? {}) as Record<string, unknown>
  return {
    input: u.input,
    output: u.output,
    cacheRead: typeof u.cacheRead === 'number' ? u.cacheRead : 0,
    cacheWrite: typeof u.cacheWrite === 'number' ? u.cacheWrite : 0,
    reasoning: typeof u.reasoning === 'number' ? u.reasoning : undefined,
    totalTokens: u.totalTokens,
    cost: {
      input: typeof cost.input === 'number' ? cost.input : 0,
      output: typeof cost.output === 'number' ? cost.output : 0,
      cacheRead: typeof cost.cacheRead === 'number' ? cost.cacheRead : 0,
      cacheWrite: typeof cost.cacheWrite === 'number' ? cost.cacheWrite : 0,
      total: typeof cost.total === 'number' ? cost.total : 0,
    },
  }
}

/**
 * 把一条 `pi://event` 记录折算进消息列表。
 *
 * 就地修改 `ctx.messages`（调用方持有同一个数组，因此响应式照常工作）。
 * 只消费事件，不碰 `ctx.streaming` —— 那是 `usePi` 的职责。
 *
 * token 用量（真实数据，非估算）：
 * - `message_update.usage`：内核维护的**会话累计**，直接镜像到 `ctx.usage.last`。
 * - `message_end.message.usage`：该条 assistant 消息自身的用量，挂回对应消息。
 */
export function applyEvent(ctx: EventCtx, rec: unknown): void {
  if (!rec || typeof rec !== 'object') return
  const messages = ctx.messages
  const t = (rec as { type?: unknown }).type

  if (t === 'message_update') {
    // 会话累计用量：内核每条流式事件都带最新累计，镜像即可（重启内核后自动归零）。
    const cumulative = extractUsage((rec as { usage?: unknown }).usage)
    if (cumulative) ctx.usage.last = cumulative

    const ev = (rec as { assistantMessageEvent?: unknown }).assistantMessageEvent
    if (!ev || typeof ev !== 'object') return
    const e = ev as { type?: unknown; delta?: unknown }
    if (e.type === 'text_delta') {
      const last = messages[messages.length - 1]
      // 只有「同一条 assistant 消息还在流式」时才续写；换人或换轮都要新开一条。
      if (!last || last.role !== 'assistant' || !last.streaming) {
        messages.push({ id: ctx.nextId(), role: 'assistant', text: '', streaming: true })
      }
      const cur = messages[messages.length - 1]
      cur.text += typeof e.delta === 'string' ? e.delta : ''
    } else if (typeof e.type === 'string' && e.type.startsWith('tool')) {
      messages.push({ id: ctx.nextId(), role: 'assistant', text: '', tool: e.type })
    }
  } else if (t === 'message_end') {
    // 最终消息：把该条 assistant 消息自身的 usage 挂回去（provider 真实上报）。
    const msg = (rec as { message?: unknown }).message
    if (!msg || typeof msg !== 'object') return
    const m = msg as { role?: unknown; usage?: unknown }
    if (m.role !== 'assistant') return
    const usage = extractUsage(m.usage)
    if (!usage) return
    const last = [...messages].reverse().find((x) => x.role === 'assistant')
    if (last) last.usage = usage
  } else if (t === 'agent_settled') {
    // 只有 agent_settled 表示「这一轮落定」；process_exit 只翻 usePi 的 streaming 开关，
    // 与内核侧保持一致的语义，不在这里顺手改消息状态。
    const last = messages[messages.length - 1]
    if (last) last.streaming = false
  }
}

/** token 数格式化：1234 → 1.2k，保留一位小数；小于 1000 原样。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** 费用格式化：美元，小数两位；小于 1 美分显示三位有效小数。 */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${n.toFixed(2)}`
}
