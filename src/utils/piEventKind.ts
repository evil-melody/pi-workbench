/**
 * `pi://event` 记录 → 视图行 的归一化。
 *
 * 桥只做「响应 / 事件」二分转发，事件原样透传；内核不同版本的事件命名会变
 * （`turn/start` vs `turn_start` vs `toolCall`）。这里**优先按事件名收敛**，
 * 查不到再**按字段形状推断** —— 内核升级后前端无需改代码，unknown 也保留为
 * `other` 而不是丢掉，便于观察新事件。
 *
 * 纯函数、不依赖 Tauri，可直接单测。
 */

export type PiEventKind =
  | 'turn_start'
  | 'tool_call'
  | 'tool_result'
  | 'message'
  | 'settled'
  | 'exit'
  | 'other'

export interface PiEventRow {
  kind: PiEventKind
  /** 主行文字（工具名 / 文本首行 / 事件语义）。 */
  title: string
  /** 次行文字（参数、输出、摘要），已截断。 */
  detail: string
  /** 到达时间（毫秒）。 */
  at: number
}

/**
 * 事件类别的图标与中文标签。
 *
 * 轨迹面板与智能体浏览器共用同一套映射，新增类别时只改这里。
 * 键必须存在于 `AppIcon.vue`，否则图标会渲染成空白。
 */
export const EVENT_KIND_ICON: Record<PiEventKind, string> = {
  turn_start: 'play',
  tool_call: 'zap',
  tool_result: 'check',
  message: 'doc',
  settled: 'check',
  exit: 'close',
  other: 'activity',
}

export const EVENT_KIND_LABEL: Record<PiEventKind, string> = {
  turn_start: '轮次',
  tool_call: '调用',
  tool_result: '返回',
  message: '文本',
  settled: '落定',
  exit: '退出',
  other: '其他',
}

/** 事件名的常见写法归一：小写、去掉分隔符（`turn/start` 与 `turn_start` 同源）。 */
function normType(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s\-/_]/g, '')
}

/** 事件名别名表：只收录已经出现过的写法，不臆测内核协议。 */
const TYPE_KIND: Record<string, PiEventKind> = {
  turn: 'turn_start',
  turnstart: 'turn_start',
  turnbegin: 'turn_start',
  toolcall: 'tool_call',
  toolstart: 'tool_call',
  toolinvoke: 'tool_call',
  toolend: 'tool_result',
  toolresult: 'tool_result',
  toolcomplete: 'tool_result',
  prefixmessage: 'message',
  message: 'message',
  messageupdate: 'message',
  msg: 'message',
  text: 'message',
  agentmessage: 'message',
  agentsettled: 'settled',
  settled: 'settled',
  turnend: 'settled',
  turncomplete: 'settled',
  processexit: 'exit',
  exit: 'exit',
}

/** 工具调用侧字段：名字、状态、参数、输出各有多种写法。 */
const NAME_KEYS = ['toolName', 'tool_name', 'toolname', 'tool', 'function_name', 'functionName', 'name', 'command']
const STATUS_KEYS = ['status', 'phase', 'state', 'event']
// toolArgs 是桥侧合成事件专用的键（参数与输出都放这里，自描述且不撞其他写法）。
const ARG_KEYS = ['args', 'toolArgs', 'arguments', 'parameters', 'input']
const OUT_KEYS = ['output', 'result', 'toolArgs', 'stdout', 'stderr', 'content', 'response']
const TEXT_KEYS = ['text', 'delta', 'message', 'content']

const CALL_STATUS = new Set(['started', 'start', 'running', 'call', 'invoke', 'begin', 'pending'])
const DONE_STATUS = new Set(['success', 'ok', 'done', 'complete', 'completed', 'finished', 'error', 'failed'])

function firstString(rec: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) return v.trim()
    if (typeof v === 'number') return String(v)
  }
  return null
}

function firstObject(rec: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const k of keys) {
    const v = rec[k]
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  }
  return null
}

/** 序列化为单行摘要，过长截断。用于 arguments / output / payload。 */
function snippet(v: unknown, max = 120): string {
  let s: string
  if (typeof v === 'string') s = v
  else if (v === null || v === undefined) s = ''
  else if (typeof v === 'object') {
    try {
      s = JSON.stringify(v)
    } catch {
      s = String(v)
    }
  } else s = String(v)
  s = s.replace(/\s+/g, ' ').trim()
  return s.length > max ? `${s.slice(0, max)}…` : s
}

function titleOfText(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find(Boolean) ?? text.trim()
  return first.length > 64 ? `${first.slice(0, 64)}…` : first
}

function detailOf(rec: Record<string, unknown>, args: Record<string, unknown> | null): string {
  const bits: string[] = []
  if (args) bits.push(snippet(args, 100))
  for (const k of OUT_KEYS) {
    if (k in rec && rec[k] != null) {
      bits.push(snippet(rec[k]))
      break
    }
  }
  return bits.filter(Boolean).join(' · ')
}

/**
 * 把一条 `pi://event` 记录折算为可展示的行。
 *
 * 返回 `null` 表示这条与视图无关（空记录 / 裸过程标量之外的无信息记录），
 * 调用方不应把它塞进事件流。
 */
export function classifyEvent(rec: unknown): PiEventRow | null {
  // 桥在子进程退出时 emit 的是裸字符串 `"process_exit"`，不是对象。
  if (typeof rec === 'string') {
    const kind = TYPE_KIND[normType(rec)]
    if (kind === 'exit' || kind === 'settled') {
      return {
        kind,
        title: kind === 'exit' ? '内核进程退出' : '本轮落定',
        detail: '',
        at: Date.now(),
      }
    }
    return null
  }
  if (!rec || typeof rec !== 'object') return null
  const obj = rec as Record<string, unknown>
  // 桥给每条事件打了 pi_ts（内核侧的到达时刻）；IPC 投递可能乱序，用桥的时间戳
  // 比用 Date.now() 稳。没有就用本地时刻，行为与从前一致。
  const stamped = obj.pi_ts
  const at = typeof stamped === 'number' ? stamped : Date.now()

  const rawType = typeof obj.type === 'string' ? obj.type : null
  const named = rawType ? TYPE_KIND[normType(rawType)] : undefined
  if (named) {
    if (named === 'message') {
      const text = firstString(obj, TEXT_KEYS) ?? ''
      return { kind: 'message', title: titleOfText(text), detail: '', at }
    }
    const name = firstString(obj, NAME_KEYS)
    if (named === 'tool_call' || named === 'tool_result') {
      const detail = detailOf(obj, firstObject(obj, ARG_KEYS))
      return {
        kind: named,
        title: name ?? (named === 'tool_call' ? '调用工具' : '工具返回'),
        detail,
        at,
      }
    }
    const labels: Record<string, string> = {
      turn_start: '新一轮开始',
      settled: '本轮落定',
      exit: '内核进程退出',
    }
    return { kind: named, title: labels[named] ?? named, detail: '', at }
  }

  // 名字落空：按字段形状推断，内核改了事件名也能继续用。
  const name = firstString(obj, NAME_KEYS)
  if (name) {
    const status = firstString(obj, STATUS_KEYS)?.toLowerCase()
    const hasOut = OUT_KEYS.some((k) => k in obj && obj[k] != null)
    const hasArgs = firstObject(obj, ARG_KEYS) !== null
    if (status && CALL_STATUS.has(status) && !hasOut) {
      return { kind: 'tool_call', title: name, detail: detailOf(obj, null), at }
    }
    if (hasOut || (status && DONE_STATUS.has(status))) {
      const detail = detailOf(obj, firstObject(obj, ARG_KEYS))
      return { kind: 'tool_result', title: name, detail, at }
    }
    if (hasArgs) {
      return { kind: 'tool_call', title: name, detail: detailOf(obj, firstObject(obj, ARG_KEYS)), at }
    }
    return { kind: 'other', title: name, detail: snippet(obj, 100), at }
  }

  const text = firstString(obj, TEXT_KEYS)
  if (text) return { kind: 'message', title: titleOfText(text), detail: '', at }

  // 无 type、无工具名、无文本：没有可展示信息，不进流。
  if (!rawType) return null
  return { kind: 'other', title: rawType, detail: snippet(obj, 100), at }
}
