import { t } from '@/i18n'
import type { PiMsg } from './usePi'
import { splitPromptBody } from './usePi'
import { extractFileChange, type PiFileChange } from '@/utils/fileChanges'
import { parsePlanSteps } from '@/utils/planMode'

/** 从消息对象里抽文本：content 可能是字符串或 [{type:'text',text}] 块数组。 */
function extractText(msg: unknown): string {
  const c = (msg as { content?: unknown }).content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) {
    return c
      .map((b) =>
        b && typeof b === 'object' && (b as { type?: unknown }).type === 'text'
          ? String((b as { text?: unknown }).text ?? '')
          : '',
      )
      .join('')
  }
  return ''
}

/** 参数/结果摘要的长度上限：渲染层只显示首行，整段只在展开时给出，留够可读长度即可。 */
const PAYLOAD_MAX = 2000

/**
 * 从最终消息的 content 块里取 thinking 文本。
 * 实证：provider 转换器把 thinking_start/delta/end 落成 `{type:'thinking',thinking}`
 * 内容块（pi-coding-agent dist/bundle/chunks/pi-messages-*.js），
 * 多块就按顺序拼接。流式内层事件丢了些片段时这里能兜回来。
 */
function extractThinking(msg: unknown): string {
  const c = (msg as { content?: unknown }).content
  if (!Array.isArray(c)) return ''
  return c
    .map((b) =>
      b && typeof b === 'object' && (b as { type?: unknown }).type === 'thinking'
        ? String((b as { thinking?: unknown }).thinking ?? '')
        : '',
    )
    .join('')
}

/**
 * 工具载荷（参数 / 结果）转可读文本并截断。
 *
 * 内核的 `args` 可能是字符串（bash 命令）或对象（edit 的 path/old/new），
 * `result` 常见形状是 `{content:[{type:'text',text}]}`——先取文本块，
 * 取不到再整体 JSON 序列化。纯函数，可单测。
 */
export function toolPayloadText(value: unknown, max = PAYLOAD_MAX): string {
  if (typeof value === 'string') return clip(value.trim(), max)
  if (value && typeof value === 'object') {
    const text = extractText({ content: (value as { content?: unknown }).content })
    if (text.trim()) return clip(text.trim(), max)
    try {
      const s = JSON.stringify(value)
      // 空参数对象不显示：`edit · {}` 这种尾巴只会让工具行看起来坏了。
      return s === '{}' || s === '[]' ? '' : clip(s, max)
    } catch {
      return clip(String(value), max)
    }
  }
  return ''
}

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

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
  /**
   * G2：当前轮文件改动组的消息 id。同一轮连续的 edit/write 归并到一条消息；
   * 轮次边界（agent_settled / 新 assistant 消息开始）置 null 重开组。
   */
  fileGroupId?: string | null
  /**
   * G4：回放通道标记。journal 重放时置 true——此时 role=user 的 message_end
   * 要落成 user 气泡（实时通道里 pushUser 已乐观落过，再落就是重复气泡）。
   */
  replay?: boolean
  /**
   * G5：plan 轮待确认计划。ChatView 在 plan 模式发送前置 `{ task }`，
   * 该轮 assistant 回复落定（message_end）时解析出分步计划挂成计划卡，
   * 随即消费置 null——只对该轮生效，不会把普通回复误判成计划。
   */
  planPending?: { task: string } | null
  /**
   * 工具名回填映射（callId → chip 消息 id）。`toolcall_start` 的 payload
   * 普遍不带 `toolCall.name`（实测 0.87.x），chip 先以 TOOL_PENDING 占座；
   * `toolcall_end` / `tool_execution_start` 带真实工具名到达时按 id 回填。
   * 可选：测试工厂不传时 applyEvent 会惰性创建，行为不变。
   */
  toolStartMap?: Map<string, string>
}

/**
 * `toolcall_start` 未携带工具名时的 chip 占位。
 *
 * 不用事件类型字面量冒充工具名（用户看到 `toolcall_start` 只会困惑），
 * 用一句中性描述说明「正在调用工具」，真名到达后原位回填。
 */
export const TOOL_PENDING = t('调用工具')

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
/**
 * 把 provider 原始错误串转成人话。
 *
 * 内核的 errorMessage 形如 `OpenAI API error (429): {"code":"","message":"You've reached..."}`，
 * 直接展示是一坨 JSON；这里尝试解析内嵌 JSON 取 `message` 字段，失败则原样返回（截断）。
 * 纯函数，可单测。
 */
export function humanizeProviderError(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) return t('未知错误')
  const i = raw.indexOf('{')
  if (i >= 0) {
    try {
      const obj = JSON.parse(raw.slice(i)) as { message?: unknown }
      if (typeof obj?.message === 'string' && obj.message.trim()) {
        // 去掉 request id 尾巴：同一限流错误各次重试的 request id 都不同，
        // 留着它同轮去重永远命中不了，对话区就会一屏同文案报错刷屏。
        return stripRequestId(obj.message)
      }
    } catch {
      // 内嵌 JSON 不完整（被截断等），走原文兜底
    }
  }
  return stripRequestId(raw.length > 400 ? `${raw.slice(0, 400)}…` : raw)
}

/** 去掉错误文案尾部的 `(request id: …)` / `（request id: …）`。纯函数，可单测。 */
export function stripRequestId(text: string): string {
  return text
    .replace(/\s*[(（]request id[:：][^)）]*[)）]\s*$/i, '')
    .trim()
}

/** 从本轮（往前到上一条 user/assistant 消息为止）的系统消息里找已报过的错误，避免重试刷屏。 */
function roundAlreadyReported(messages: PiMsg[], core: string): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'system') return false
    if (m.text.includes(core)) return true
  }
  return false
}

/** 错误落一条系统消息（同轮去重后）；错误必须进对话区，不能只进右侧轨迹。 */
function reportError(messages: PiMsg[], prefix: string, raw: unknown, nextId: () => string): void {
  const core = humanizeProviderError(raw)
  if (roundAlreadyReported(messages, core)) return
  messages.push({ id: nextId(), role: 'system', text: `${prefix}${core}` })
}

/** 最近若干条消息里是否已收录过该调用 id（防 tool_execution_start 与 toolcall_end 双通道重复）。 */
function changeAlreadyRecorded(messages: PiMsg[], id: string): boolean {
  for (let i = messages.length - 1; i >= 0 && i >= messages.length - 12; i--) {
    if (messages[i].fileChanges?.some((c) => c.id === id)) return true
  }
  return false
}

/**
 * G2：把一次 edit/write 工具调用挂进消息流。
 *
 * 归组规则：同一轮（未遇 agent_settled / 新 assistant 消息）的连续文件改动
 * 挂到同一条 assistant 消息下——一轮里的多次编辑是「一次工作」，逐条刷屏
 * 只会复刻用户抱怨过的「这么多 icon」。文本到来会把文件组切到正文消息上
 * （text_delta 续写 streaming 正文并重设 fileGroupId，文件组消息不是续写目标）。
 */
function attachFileChange(
  ctx: EventCtx,
  toolName: unknown,
  args: unknown,
  callId?: unknown,
): void {
  const change = extractFileChange(toolName, args, callId)
  if (!change) return
  const messages = ctx.messages
  if (changeAlreadyRecorded(messages, change.id)) return
  const last = messages[messages.length - 1]
  if (ctx.fileGroupId && last && last.id === ctx.fileGroupId && last.role === 'assistant') {
    // 归组到当前 assistant 消息（可能是纯文本消息，fileChanges 懒创建）。
    if (!last.fileChanges) last.fileChanges = []
    last.fileChanges.push(change)
    return
  }
  const msg: PiMsg = {
    id: ctx.nextId(),
    role: 'assistant',
    text: '',
    ts: Date.now(),
    fileChanges: [change],
  }
  messages.push(msg)
  ctx.fileGroupId = msg.id
}

/**
 * 把 start 时占座的工具 chip 回填成真实工具名。
 *
 * 匹配顺序：callId 命中 toolStartMap（精确，多工具并发也各归各）；
 * 兜底就近回填最近的占位 chip（end 事件不带 id 的内核变体）。
 * 找不到占座 chip 时静默跳过——单独到达的 end 不该凭空造 chip。
 */
function backfillToolName(ctx: EventCtx, id: unknown, name: unknown): void {
  if (typeof name !== 'string' || !name.trim()) return
  const messages = ctx.messages
  if (typeof id === 'string' && id && ctx.toolStartMap?.has(id)) {
    const mid = ctx.toolStartMap.get(id)!
    ctx.toolStartMap.delete(id)
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].id === mid) {
        messages[i].tool = name
        return
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].tool === TOOL_PENDING) {
      messages[i].tool = name
      return
    }
  }
}

/**
 * 按调用 id 定位工具 chip 消息（从后往前，同 id 只属于一次调用）。
 *
 * 名字回填用的是 callId→msgId 映射，命中后即删除；参数与结果分属不同事件
 * （start / end 谁先到不确定），因此改用消息上的 toolCallId 定位，不依赖那份映射。
 */
function findToolChip(messages: PiMsg[], id: unknown): PiMsg | undefined {
  if (typeof id !== 'string' || !id) return undefined
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].toolCallId === id) return messages[i]
  }
  return undefined
}

/**
 * 把工具入参摘要回填进对应 chip。
 *
 * 定位顺序：callId 精确命中；否则就近找**仍是占位名**的 chip。
 * 兜底只认 TOOL_PENDING——已被回填真名的 chip 说明它那次调用的参数已处理过，
 * 再把这次的参数挂上去就是张冠李戴（双通道 + 并发调用时最容易踩）。
 * 找不到就静默跳过：参数只是摘要，缺它不影响这行本身。
 */
function backfillToolArgs(ctx: EventCtx, id: unknown, args: unknown): void {
  const summary = toolPayloadText(args)
  if (!summary) return
  const messages = ctx.messages
  const chip =
    findToolChip(messages, id) ??
    messages.filter((m) => m.tool === TOOL_PENDING && !m.toolArgs).pop()
  if (!chip || chip.toolArgs) return
  chip.toolArgs = summary
}

/**
 * 从末尾往前找第一条仍在流式（`streaming === true`）的 assistant 消息。
 *
 * 正文聚合的锚点：一轮 LLM 响应在流式期间只对应这一条消息，工具 chip 与
 * 文件改动消息都没有 streaming 标记，因此会被自然跳过。
 */
function findStreamingAssistant(messages: PiMsg[]): PiMsg | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role === 'assistant' && m.streaming) return m
  }
  return undefined
}

/** 新开一条流式 assistant 正文消息并挂到末尾。 */
function createStreamingAssistant(ctx: EventCtx, messages: PiMsg[]): PiMsg {
  const msg: PiMsg = { id: ctx.nextId(), role: 'assistant', text: '', ts: Date.now(), streaming: true }
  messages.push(msg)
  return msg
}

/**
 * usage / plan 的落点：优先本轮的正文消息（streaming 中或有非空文本），
 * 回落到最后一条 assistant——纯工具轮没有正文时仍按老行为挂，不丢数据。
 */
function findUsageTarget(messages: PiMsg[]): PiMsg | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m.role !== 'assistant') continue
    if (m.streaming || (typeof m.text === 'string' && m.text.trim())) return m
  }
  return [...messages].reverse().find((x) => x.role === 'assistant')
}

export function applyEvent(ctx: EventCtx, rec: unknown): void {
  if (!rec || typeof rec !== 'object') return
  const messages = ctx.messages
  const eventType = (rec as { type?: unknown }).type

  if (eventType === 'message_update') {
    // 会话累计用量：内核每条流式事件都带最新累计，镜像即可（重启内核后自动归零）。
    const cumulative = extractUsage((rec as { usage?: unknown }).usage)
    if (cumulative) ctx.usage.last = cumulative

    const ev = (rec as { assistantMessageEvent?: unknown }).assistantMessageEvent
    if (!ev || typeof ev !== 'object') return
    const e = ev as { type?: unknown; delta?: unknown; toolCall?: unknown; content?: unknown }
    if (e.type === 'text_delta') {
      // 续写目标：从末尾往前找**第一条仍在流式的 assistant 消息**。
      // 工具 chip（toolcall_start 落的空文本消息）没有 streaming 标记，天然被跳过——
      // 一轮里「文本→工具→文本」因此聚合成一条正文，而不是每段各成一个气泡
      // （旧逻辑只看末尾一条，工具一插后续文本就另起新消息，markdown 被拦腰截断）。
      // 找不到说明上一轮已落定或换人了，才新建。
      const cur = findStreamingAssistant(messages) ?? createStreamingAssistant(ctx, messages)
      cur.text += typeof e.delta === 'string' ? e.delta : ''
      // G2：这条文本消息就是当前 assistant 消息（本轮 LLM 响应）的代表，
      // 后续同一响应内的工具改动挂到它下面，不另起一条。
      ctx.fileGroupId = cur.id
    } else if (e.type === 'thinking_delta') {
      // 思考流（实证：内核 provider 转换器把 thinking_start/delta/end 原样透传进
      // assistantMessageEvent，见 pi-coding-agent dist/bundle/chunks/pi-messages-*.js：
      // `case"thinking_delta":partial.content[i].thinking+=event.delta`）。
      // 与正文同一个锚点消息：一轮的 Think 与回答本就是一体的，拆两条会多一个头像。
      const cur = findStreamingAssistant(messages) ?? createStreamingAssistant(ctx, messages)
      cur.reasoning = (cur.reasoning ?? '') + (typeof e.delta === 'string' ? e.delta : '')
      ctx.fileGroupId = cur.id
    } else if (e.type === 'thinking_end') {
      // 兜底：个别 provider 只在结束时给全文（delta 被省略/改写）。
      // 已经有聚合文本就不覆盖，避免同一段思考显示两遍。
      const cur = findStreamingAssistant(messages)
      const full = typeof e.content === 'string' ? e.content.trim() : ''
      if (full && cur && !cur.reasoning) cur.reasoning = full
    } else if (e.type === 'thinking_start') {
      // 思考块开始：无信息量，锚点消息由后续 delta 到达时再建。
    } else if (e.type === 'toolcall_end') {
      // G2：流式协议终点带完整入参（toolCall.arguments）——文件改动的第二数据源，
      // 与 tool_execution_start 按调用 id 去重，谁先到用谁。
      const tc = e.toolCall as { id?: unknown; name?: unknown; arguments?: unknown } | undefined
      if (tc) {
        // start 占座的 chip 在这里拿到真实工具名（end 的 payload 带 name）。
        backfillToolName(ctx, tc.id, tc.name)
        // dsh 的工具行是「工具名 · 参数摘要」，参数在这一刻才是完整的。
        backfillToolArgs(ctx, tc.id, tc.arguments)
        attachFileChange(ctx, tc.name, tc.arguments, tc.id)
      }
    } else if (e.type === 'toolcall_start') {
      // 只在 start 记一个名字 chip：start/delta/end 三态都记就是同一调用三行噪音。
      // 名字/调用 id 有两种到达形状（实证 0.87.1 `dist/modes/json-event.js` 把
      // toolcall_start 改写为顶层 `{id, toolName}`；更早版本两者都不带）：
      // 取不到名字就先以 TOOL_PENDING 占座，由 end / tool_execution_start 回填；
      // 但**调用 id 一律记进消息**——参数与结果回填靠它定位，
      // 只有占位名可等、id 丢了就再也对不上这次调用。
      const tc = e.toolCall as { id?: unknown; name?: unknown } | undefined
      const ev = e as { id?: unknown; toolName?: unknown }
      const callId = typeof tc?.id === 'string' && tc.id ? tc.id : typeof ev.id === 'string' && ev.id ? ev.id : ''
      const rawName = tc?.name ?? ev.toolName
      const name = typeof rawName === 'string' && rawName.trim() ? rawName.trim() : null
      const msg: PiMsg = {
        id: ctx.nextId(),
        role: 'assistant',
        text: '',
        ts: Date.now(),
        tool: name ?? TOOL_PENDING,
        ...(callId ? { toolCallId: callId } : {}),
      }
      messages.push(msg)
      if (!name && callId) {
        ;(ctx.toolStartMap ??= new Map()).set(callId, msg.id)
      }
    } else if (e.type === 'toolcall_delta') {
      // 参数增量流：无信息量，不进消息流（轨迹面板另有 tool_call 行）。
    } else if (typeof e.type === 'string' && e.type.startsWith('tool')) {
      // 旧版内核的工具事件名（tool_use 等）：不认识形状也插 chip，不丢兼容。
      messages.push({ id: ctx.nextId(), role: 'assistant', text: '', ts: Date.now(), tool: e.type })
    }
  } else if (eventType === 'tool_execution_start') {
    // G2：agent 工具执行起点事件（agent-session 转发给 RPC 客户端），args 是完整入参。
    const r = rec as { toolName?: unknown; args?: unknown; toolCallId?: unknown }
    // 该事件带 toolName：start 占座的 chip 在这里即可回填，不必等 toolcall_end。
    backfillToolName(ctx, r.toolCallId, r.toolName)
    backfillToolArgs(ctx, r.toolCallId, r.args)
    attachFileChange(ctx, r.toolName, r.args, r.toolCallId)
  } else if (eventType === 'tool_execution_end') {
    // 实证 0.87.1 `core/extensions/types.d.ts`：ToolExecutionEndEvent 带
    // `{toolCallId, toolName, result, isError}`，且 rpc-mode 原样透传所有事件。
    // 只回填给已存在的 chip：结果属于那次调用，chip 不在（历史回放/被合并）就丢掉，
    // 不为一次结果凭空造一行。
    const r = rec as { toolCallId?: unknown; toolName?: unknown; result?: unknown; isError?: unknown }
    const chip = findToolChip(messages, r.toolCallId)
    if (!chip) return
    // 名字只在仍是占位时补，且只认这次调用的 chip（不走就近兜底，避免错挂到别的调用）。
    if (chip.tool === TOOL_PENDING && typeof r.toolName === 'string' && r.toolName.trim()) {
      chip.tool = r.toolName.trim()
    }
    const summary = toolPayloadText(r.result)
    if (summary && !chip.toolResult) chip.toolResult = summary
    if (r.isError === true) chip.toolError = true
  } else if (eventType === 'message_start') {
    // 新 assistant 消息开始：文件组到此关闭，后续改动归入下一组。
    const role = (rec as { message?: { role?: unknown } }).message?.role
    if (role === 'assistant') ctx.fileGroupId = null
  } else if (eventType === 'message_end') {
    // 最终消息：挂 usage；模型报错时 content 为空且带 errorMessage——
    // 必须落成可见消息，否则对话区一片空白（右侧轨迹有错、左边没动静）。
    const msg = (rec as { message?: unknown }).message
    if (!msg || typeof msg !== 'object') return
    const m = msg as { role?: unknown; usage?: unknown; errorMessage?: unknown }
    if (m.role === 'user') {
      // G4：回放时 user prompt 从 message_end 重建——journal 本就带原文
      // （message_start/message_end 的 role=user 实证，含 content[0].text）。
      // 实时通道不走这里：pushUser 已乐观落过，再落就是重复气泡。
      if (!ctx.replay) return
      const raw = extractText(msg)
      if (!raw.trim()) return
      const { text, attachments } = splitPromptBody(raw)
      if (!text.trim() && !attachments.length) return
      messages.push({
        id: ctx.nextId(),
        role: 'user',
        text,
        ...(attachments.length ? { attachments } : {}),
      })
      return
    }
    if (m.role !== 'assistant') return
    if (typeof m.errorMessage === 'string' && m.errorMessage.trim()) {
      reportError(messages, t('模型请求失败：'), m.errorMessage, ctx.nextId)
    }
    const last = findUsageTarget(messages)
    // 思考兜底：内层 thinking_delta 若因节流合并丢段，用最终消息的 thinking 块补齐。
    // 只有聚合为空时才覆盖——半截 delta 拼出来的文本比最终块短，但有内容总比没有好，
    // 而真正完整的流式聚合不该被这里的"看起来更全"的块反向污染。
    if (last && !last.reasoning) {
      const think = extractThinking(msg).trim()
      if (think) last.reasoning = think
    }
    // G5：plan 轮落定——把该条 assistant 回复解析成分步计划卡。先于 usage 处理：
    // 个别 provider 的 message_end 可能不带 usage，不能因此丢掉计划卡。
    if (ctx.planPending) {
      const { task } = ctx.planPending
      ctx.planPending = null
      const steps = last ? parsePlanSteps(last.text) : []
      if (steps.length && last) {
        last.plan = { steps, task, state: 'pending' }
      } else {
        // 模型没按计划格式输出：明示一条，别让用户对着一张普通回复找「开始执行」。
        messages.push({
          id: ctx.nextId(),
          role: 'system',
          text: t('计划模式：未解析到分步计划，已按普通回复处理。'),
        })
      }
    }
    const usage = extractUsage(m.usage)
    if (!usage) return
    if (last) last.usage = usage
  } else if (eventType === 'auto_retry_start') {
    // 内核自动重试：报一声进度（attempt 从 1 起），错误详情已由 message_end 报过，不重复。
    // 同一轮的多次重试原地更新同一行——一次对话最多一行「自动重试中」，不逐次刷屏。
    const r = rec as { attempt?: unknown; delayMs?: unknown }
    if (typeof r.attempt !== 'number') return
    const s = typeof r.delayMs === 'number' ? Math.max(1, Math.round(r.delayMs / 1000)) : null
    const text = t('模型请求失败，自动重试中（第 {0} 次{1}）…', [r.attempt, s ? t('，{0}s 后', [s]) : ''])
    const last = messages[messages.length - 1]
    if (last && last.role === 'system' && last.text.startsWith(t('模型请求失败，自动重试中'))) {
      last.text = text
    } else {
      messages.push({ id: ctx.nextId(), role: 'system', text })
    }
  } else if (eventType === 'auto_retry_end') {
    // 重试耗尽：最终失败必须亮出来（同轮已报过相同错误则去重）。
    const r = rec as { finalError?: unknown }
    if (typeof r.finalError === 'string' && r.finalError.trim()) {
      reportError(messages, t('模型请求最终失败：'), r.finalError, ctx.nextId)
    }
  } else if (eventType === 'agent_settled') {
    // 只有 agent_settled 表示「这一轮落定」；process_exit 只翻 usePi 的 streaming 开关，
    // 与内核侧保持一致的语义，不在这里顺手改消息状态。
    // G6：收尾目标不能假设是 messages 末尾——流式中排队/插话会往末尾插 user 气泡。
    // 正文聚合后一轮只有一条 streaming 消息（工具 chip 无 streaming 标记），
    // 从末尾往前找第一条 streaming 的 assistant 即是它；找不到（已是落定态）不动。
    const streamingAssistant = findStreamingAssistant(messages)
    if (streamingAssistant) streamingAssistant.streaming = false
    // G2：轮次落定，文件组关闭——下一轮的编辑从新消息开始，不并进上一轮。
    ctx.fileGroupId = null
  }
}

/** token 数格式化：1234 → 1.2k，保留一位小数；小于 1000 原样。 */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return '0'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

/** G6：消息队列快照（内核 queue_update 事件回推的双队列）。 */
export interface QueueState {
  /** steer 队列：本轮工具调用跑完后、下次 LLM 调用前注入。 */
  steering: string[]
  /** follow_up 队列：本轮完全结束（无工具调用、无 steer）后才执行。 */
  followUp: string[]
}

export function emptyQueueState(): QueueState {
  return { steering: [], followUp: [] }
}

/**
 * G6：解析内核 `queue_update` 事件。队列 chip 以它为权威数据源——
 * steer/follow_up 入队与消费时内核都会回推，前端不自己维护副账。
 * 形状非法返回 null（调用方保持原状，不污染）。
 */
export function readQueueUpdate(rec: unknown): QueueState | null {
  if (!rec || typeof rec !== 'object') return null
  const r = rec as { type?: unknown; steering?: unknown; followUp?: unknown }
  if (r.type !== 'queue_update') return null
  const strs = (v: unknown): v is string[] =>
    Array.isArray(v) && v.every((x) => typeof x === 'string')
  if (!strs(r.steering) || !strs(r.followUp)) return null
  return { steering: [...r.steering], followUp: [...r.followUp] }
}

/** 费用格式化：美元，小数两位；小于 1 美分显示三位有效小数。 */
export function fmtCost(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}`
  return `$${n.toFixed(2)}`
}

/**
 * dsh 式统计行：把「这次会话干了什么、花了多少」压成一行小字。
 *
 * 段文案照抄 dsh 的 i18n 原文（`{turns} 轮 · {steps} 步` / `输入 … tok · 输出 … tok`
 * / `缓存命中 …%`），段间 ` | ` 分隔，**缺数据的段整段不渲染**——
 * dsh 的 `LLM 耗时` / `首 token 平均` / `tok/s` 要的是逐轮时间戳，
 * 内核 usage 里没有，就不硬凑一个假数字（见 docs 对齐记录的缺口清单）。
 * 纯函数，可单测。
 */
export function statsSegments(
  counts: { turns: number; steps: number },
  usage: PiUsage | null,
): string[] {
  const out: string[] = []
  if (counts.turns > 0 || counts.steps > 0) out.push(t('{0} 轮 · {1} 步', [counts.turns, counts.steps]))
  if (!usage) return out
  const inTok = usage.input + usage.cacheRead + usage.cacheWrite
  out.push(t('输入 {0} tok · 输出 {1} tok', [fmtTokens(inTok), fmtTokens(usage.output)]))
  const hit = cacheHitPercent(usage)
  if (hit !== null) out.push(t('缓存命中 {0}%', [hit]))
  if (usage.cost.total > 0) out.push(t('费用 {0}', [fmtCost(usage.cost.total)]))
  return out
}

/**
 * 提示缓存命中率：`cacheRead / (input + cacheRead + cacheWrite)`。
 * 分母为 0（还没发过请求）返回 null——显示「缓存命中 0%」会把「没数据」
 * 说成「缓存很差」，是两种完全不同的信息。
 */
export function cacheHitPercent(usage: PiUsage): number | null {
  const inTok = usage.input + usage.cacheRead + usage.cacheWrite
  if (!inTok) return null
  return Math.round((usage.cacheRead / inTok) * 100)
}
