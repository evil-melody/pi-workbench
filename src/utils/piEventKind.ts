import { t } from '@/i18n'
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
  /** 内核生命周期噪声（message_start / agent_end / entry_appended / auto_retry_* …）。 */
  | 'lifecycle'
  | 'other'

export interface PiEventRow {
  kind: PiEventKind
  /** 主行文字（工具名 / 文本首行 / 事件语义）。 */
  title: string
  /** 次行文字（参数、输出、摘要），已截断。 */
  detail: string
  /** 到达时间（毫秒）。 */
  at: number
  /**
   * 折叠态主文：「工具 + 对象 + 量」（`读取 README.md`）。
   * 缺失时视图退回 `title`。`title` / `detail` 语义不变，仍供用量与浏览器面板消费。
   */
  label?: string
  /** 折叠态次行：结果的一行纯文本摘要（不含 JSON 字面量）。 */
  result?: string
  /** 原始事件名（内核写法原样），只进展开体。 */
  type?: string
  /** 原始记录字段数，折叠态用来给未知事件定量。 */
  fieldsCount?: number
  /** 原始 payload（缩进 JSON，已封顶），只进展开体等宽块。 */
  payload?: string
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
  lifecycle: 'clock',
  other: 'activity',
}

export function eventKindLabel(kind: PiEventKind): string {
  const table: Record<PiEventKind, string> = {
    turn_start: t('轮次'),
    tool_call: t('调用'),
    tool_result: t('返回'),
    message: t('文本'),
    settled: t('落定'),
    exit: t('退出'),
    lifecycle: t('系统'),
    other: t('其他'),
  }
  return table[kind]
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
  // 内核生命周期：每轮都成对出现、对用户没有信息量，聚合到一条 quiet 行里。
  // 事件名取自 src/composables/piEvents.ts / usePi.ts 实际处理的写法。
  messagestart: 'lifecycle',
  messageend: 'lifecycle',
  agentstart: 'lifecycle',
  agentend: 'lifecycle',
  entryappended: 'lifecycle',
  autoretrystart: 'lifecycle',
  autoretryend: 'lifecycle',
  sessionopen: 'lifecycle',
  queueupdate: 'lifecycle',
  kernelrestarted: 'lifecycle',
}

/**
 * 生命周期事件的中文语义（键是 `normType` 归一后的事件名）。
 *
 * 折叠行主文用它，原始事件名退化成一行 mono 小标签——「未识别事件 xxx」
 * 那种主文就是噪声的来源。落空就原样显示事件名，不编语义。
 */
function lifecycleLabels(): Record<string, string> {
  return {
    messagestart: t('消息开始'),
    messageend: t('消息结束'),
    agentstart: t('内核开始'),
    agentend: t('内核结束'),
    entryappended: t('写入记录'),
    autoretrystart: t('自动重试'),
    autoretryend: t('重试结束'),
    sessionopen: t('打开会话'),
    queueupdate: t('队列更新'),
    kernelrestarted: t('内核重启'),
  }
}

/**
 * 折叠行主文案（渲染层专用，`classifyEvent` 的 `label` 契约不动）。
 *
 * `other` 与 `lifecycle` 显示中文语义 / 事件名，而不是「未识别事件 xxx · N 字段」。
 */
export function eventDisplayLabel(row: PiEventRow): string {
  if (row.kind === 'lifecycle') {
    const label = lifecycleLabels()[normType(row.type ?? '')]
    return label ? t(label) : row.type ?? t('系统事件')
  }
  if (row.kind === 'other') return row.type ?? row.title
  return row.label ?? row.title
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
 * 折叠态主文的动词表。键是 `normType` 归一（去分隔符小写）后的工具名，
 * 只收录内核 / 桥里真实出现过的写法，落空就原样显示工具名——不编语义。
 */
function toolVerbs(): Record<string, string> {
  return {
    read: t('读取'),
    readfile: t('读取'),
    write: t('写入'),
    writefile: t('写入'),
    edit: t('编辑'),
    strreplace: t('编辑'),
    multistrreplace: t('编辑'),
    bash: 'bash',
    shell: 'bash',
    run: 'bash',
    runcommand: 'bash',
    exec: 'bash',
    terminal: 'bash',
    grep: t('检索'),
    rg: t('检索'),
    search: t('检索'),
    glob: t('查找'),
    find: t('查找'),
    ls: t('列出'),
    listdir: t('列出'),
    webfetch: t('抓取'),
    websearch: t('检索'),
  }
}

/** 能当「对象」的参数键：路径 / 命令 / 查询 / URL。 */
const OBJECT_KEYS = [
  'path',
  'file_path',
  'filePath',
  'file',
  'command',
  'cmd',
  'pattern',
  'query',
  'url',
  'dir',
  'directory',
]

/** 路径只留末端，命令原样（它本身就是人话）。 */
function shortObject(v: string): string {
  const one = v.replace(/\s+/g, ' ').trim()
  if (!one.includes('/') && !one.includes('\\')) return one
  const parts = one.split(/[/\\]+/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : one
}

function objectOf(sources: Array<Record<string, unknown> | null>): string {
  for (const src of sources) {
    if (!src) continue
    const hit = firstString(src, OBJECT_KEYS)
    if (hit) return shortObject(hit)
  }
  return ''
}

/** 输出行数（字符串输出才算，对象输出留给展开体）。 */
function outLines(out: unknown): number {
  if (typeof out !== 'string') return 0
  const t = out.trim()
  if (!t || t === '{}') return 0
  return t.split('\n').filter(Boolean).length
}

/**
 * 折叠态主文：`动词 对象 · 量`。§2.A——`工具调用 ×7` 是穿了衣服的进度条。
 */
function toolLabel(name: string | null, args: Record<string, unknown> | null, rec: Record<string, unknown>, lines: number): string {
  const key = name ? normType(name) : ''
  const verb = toolVerbs()[key] ?? ''
  const obj = objectOf([args, rec])
  const sep = verb && /[a-z]/.test(verb) ? ' · ' : ' '
  const head = verb ? (obj ? `${verb}${sep}${obj}` : verb) : name ?? t('工具')
  const text = lines > 1 ? t('{0} · {1} 行', [head, lines]) : head
  return text.length > 96 ? `${text.slice(0, 96)}…` : text
}

/** 折叠态次行：结果纯文本首行；对象输出返回空串（原始 JSON 只进展开体）。 */
function resultLine(rec: Record<string, unknown>): string {
  for (const k of OUT_KEYS) {
    const v = rec[k]
    if (typeof v === 'string' && v.trim()) {
      const first = v.split('\n').map((l) => l.trim()).find(Boolean) ?? ''
      return first.length > 90 ? `${first.slice(0, 90)}…` : first
    }
    if (v && typeof v === 'object') return ''
  }
  return ''
}

/** 展开体的原始记录：缩进 JSON + 字段数，长文封顶后自滚动。 */
function rawOf(rec: Record<string, unknown>): { payload: string; fieldsCount: number } {
  let payload: string
  try {
    payload = JSON.stringify(rec, null, 2)
  } catch {
    payload = String(rec)
  }
  if (payload.length > 6000) payload = t('{0} …（已截断）', [payload.slice(0, 6000)])
  return { payload, fieldsCount: Object.keys(rec).length }
}

/**
 * 把一条 `pi://event` 记录折算为可展示的行。
 *
 * 返回 `null` 表示这条与视图无关（空记录 / 裸过程标量之外的无信息记录），
 * 调用方不应把它塞进事件流。
 */
function classifyRow(rec: unknown): PiEventRow | null {
  // 桥在子进程退出时 emit 的是裸字符串 `"process_exit"`，不是对象。
  if (typeof rec === 'string') {
    const kind = TYPE_KIND[normType(rec)]
    if (kind === 'exit' || kind === 'settled') {
      return {
        kind,
        title: kind === 'exit' ? t('内核进程退出') : t('本轮落定'),
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
        title: name ?? (named === 'tool_call' ? t('调用工具') : t('工具返回')),
        detail,
        at,
      }
    }
    const labels: Record<string, string> = {
      turn_start: t('新一轮开始'),
      settled: t('本轮落定'),
      exit: t('内核进程退出'),
      lifecycle: t('系统事件'),
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

/**
 * 视图入口：先按原有语义折算，再补折叠态主文与展开体原文。
 *
 * `kind` / `title` / `detail` / `at` 的含义一律不动（用量面板、智能体浏览器和
 * 单测都吃这四个字段），新字段全部可选，缺省时视图退回 `title`。
 */
export function classifyEvent(rec: unknown): PiEventRow | null {
  const row = classifyRow(rec)
  if (!row || !rec || typeof rec !== 'object') return row

  const obj = rec as Record<string, unknown>
  const raw = typeof obj.type === 'string' ? obj.type : undefined
  const { payload, fieldsCount } = rawOf(obj)
  const base: PiEventRow = { ...row, type: raw, payload, fieldsCount }

  if (base.kind === 'tool_call' || base.kind === 'tool_result') {
    const out = OUT_KEYS.map((k) => obj[k]).find((v) => typeof v === 'string' && v.trim())
    base.label = toolLabel(
      firstString(obj, NAME_KEYS),
      firstObject(obj, ARG_KEYS),
      obj,
      outLines(out),
    )
    base.result = base.kind === 'tool_result' ? resultLine(obj) : ''
    return base
  }

  if (base.kind === 'other') {
    // 未识别事件：折叠态只给「事件名 + 字段数」，payload 一律收进展开体。
    base.label = t('未识别事件 {0} · {1} 字段', [raw ?? row.title, fieldsCount])
    return base
  }

  base.label = row.title
  return base
}
