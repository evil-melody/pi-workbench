import { t } from '@/i18n'
import type { PiEventRow } from './piEventKind'

/**
 * 运行链路模型：把 `pi://event` 事件流折算成「一次请求一条链路」。
 *
 * 归属只认桥侧信封（`runId` / `spanId` / `spanKind` / 起止时间），不按事件顺序猜。
 * 老事件没有信封时退化成「按轮次聚合」的降级链路，并在界面上标注，绝不假装完整。
 */

export type StageKind =
  | 'request'
  | 'kernel'
  | 'expert'
  | 'model'
  | 'tool'
  | 'gate'
  | 'retry'
  | 'end'
export type StageStatus = 'run' | 'ok' | 'failed' | 'blocked' | 'timeout' | 'cancelled'

export interface RunStage {
  key: string
  kind: StageKind
  /** 工具段用事件行自带的折叠文案（`运行 bash · pnpm test`），其余段由界面按 kind 取词条。 */
  label?: string
  /** 输入摘要。 */
  detail: string
  /** 输出摘要。 */
  result: string
  status: StageStatus
  startedAt: number
  /** null 表示仍在进行。 */
  endedAt: number | null
  spanId?: string
  parentSpanId?: string
  /** 归属角色（桥侧 `agentId`），图形视图按它分道。 */
  agentId?: string
  /** 自动重试次数（仅 retry 段）。 */
  retries?: number
  /** 失败原因（门禁拒绝 / 重试终态）。 */
  error?: string
  /** 代表这条环节原始事件（展开体）。 */
  raw?: string
}

export interface RunChain {
  runId: string
  prompt: string
  startedAt: number
  endedAt: number | null
  status: StageStatus
  stages: RunStage[]
  /** true：老事件没有 runId/spanId，链路是按轮次拼的，粒度声明里要写清。 */
  degraded: boolean
}

/** 审批门超时（与 agent-tool-gate.ts 的 90s fail-closed 对齐）。 */
const GATE_TIMEOUT_MS = 90_000

type SpanAcc = { start?: PiEventRow; end?: PiEventRow; rows: PiEventRow[] }

function later(a: PiEventRow, b: PiEventRow): PiEventRow {
  return (a.at ?? 0) >= (b.at ?? 0) ? a : b
}

/** 只解析桥写入的 payload 字符串，失败就当没有——不能在渲染路径抛错。 */
function data(row: PiEventRow | undefined): Record<string, unknown> {
  if (!row?.payload) return {}
  try {
    const v = JSON.parse(row.payload)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function stageKey(runId: string, spanId: string): string {
  return `${runId}:${spanId}`
}

function accOf(map: Map<string, SpanAcc>, id: string): SpanAcc {
  let acc = map.get(id)
  if (!acc) {
    acc = { rows: [] }
    map.set(id, acc)
  }
  return acc
}

/** 工具返回正文：内核固定形状 `result.content[].text`。 */
function resultText(o: Record<string, unknown>): string {
  const result = o.result
  if (!result || typeof result !== 'object') return ''
  const content = (result as Record<string, unknown>).content
  if (!Array.isArray(content)) return ''
  const all = content
    .map((c) => (c && typeof c === 'object' ? String((c as Record<string, unknown>).text ?? '') : ''))
    .filter(Boolean)
    .join('\n')
  return all.length > 300 ? `${all.slice(0, 300)}…` : all
}

/** 模型段输出摘要：优先已归类文本行，其次从 `assistantMessageEvent.delta` 取。 */
function modelSummary(rows: PiEventRow[]): string {
  for (const r of [...rows].reverse()) {
    if (r.kind === 'message' && r.title) return r.title
  }
  for (const r of [...rows].reverse()) {
    const ev = data(r).assistantMessageEvent
    if (ev && typeof ev === 'object') {
      const delta = (ev as Record<string, unknown>).delta
      if (typeof delta === 'string' && delta.trim()) {
        const one = delta.replace(/\s+/g, ' ').trim()
        return one.length > 160 ? `${one.slice(0, 160)}…` : one
      }
    }
  }
  return ''
}

function stageFromSpan(runId: string, kind: string, spanId: string, acc: SpanAcc, now: number): RunStage | null {
  const start = acc.start
  const end = acc.end
  if (!start && !end) return null
  const anchor = start ?? end!
  const startedAt = anchor.spanStartedAt ?? anchor.at
  const endedAt = end?.spanEndedAt ?? (end && !start ? end.at : null)
  const base = {
    key: stageKey(runId, spanId),
    startedAt,
    endedAt,
    spanId,
    parentSpanId: (start ?? end)?.parentSpanId,
    agentId: (start ?? end)?.agentId,
    detail: '',
    result: '',
    status: (endedAt ? 'ok' : 'run') as StageStatus,
  }

  if (kind === 'model') {
    return { ...base, kind: 'model', result: modelSummary(acc.rows), raw: (end ?? start)?.payload }
  }

  if (kind === 'tool') {
    const out = data(end)
    const failed = out.isError === true
    const body = resultText(out) || end?.result || end?.detail || ''
    return {
      ...base,
      kind: 'tool',
      label: start?.label ?? start?.title ?? t('工具'),
      detail: start?.detail ?? '',
      result: body,
      status: endedAt ? (failed ? 'failed' : 'ok') : failed ? 'failed' : 'run',
      error: failed ? text(out.error) || body || t('工具执行失败') : '',
      raw: (end ?? start)?.payload,
    }
  }

  if (kind === 'gate') {
    const decided = end
    const expired = !decided && now - startedAt > GATE_TIMEOUT_MS
    const blocked = decided?.confirmed === false
    return {
      ...base,
      kind: 'gate',
      detail: start?.title ?? '',
      status: blocked ? 'blocked' : expired ? 'timeout' : endedAt ? 'ok' : 'run',
      error: blocked ? t('工具门拒绝') : expired ? t('审批超时') : '',
      raw: (decided ?? start)?.payload,
    }
  }

  if (kind === 'retry') {
    const attempt = data(start).attempt
    const done = data(end)
    const failed = done.success === false
    return {
      ...base,
      kind: 'retry',
      retries: typeof attempt === 'number' ? attempt : undefined,
      detail: text(data(start).errorMessage) || text(data(start).error),
      status: endedAt ? (failed ? 'failed' : 'ok') : 'run',
      error: failed ? text(done.finalError) : '',
      raw: (end ?? start)?.payload,
    }
  }

  return null
}

/**
 * 轮次起始时间：取信封 `runStartedAt`（每条事件都有）的最小值。
 *
 * 不能只认 `run_start` 行：事件缓冲是定长环形，最早的 `run_start` 会被淘汰，
 * 一旦找不到起始行，整轮的排序键就会往后漂，图和相邻轮次跟着换位。
 */
function runStartAt(rows: PiEventRow[]): number {
  let at = Number.POSITIVE_INFINITY
  for (const r of rows) at = Math.min(at, r.runStartedAt ?? r.at)
  return Number.isFinite(at) ? at : Date.now()
}

function buildRun(runId: string, rows: PiEventRow[], kernel?: PiEventRow, exitAt?: number): RunChain {
  const sorted = [...rows].sort((a, b) => (a.spanStartedAt ?? a.at) - (b.spanStartedAt ?? b.at))
  const startRow = sorted.find((r) => r.type === 'run_start')
  const startedAt = runStartAt(rows)
  const endRow = [...sorted].reverse().find((r) => r.runEndedAt != null)
  const endedAt = endRow?.runEndedAt ?? exitAt ?? null
  const interrupted = endRow?.runStatus === 'interrupted'

  const spans = new Map<string, SpanAcc>()
  // 按到达顺序建段：节点位置只跟「首次出现」有关，不随后续时间戳重排。
  for (const r of rows) {
    if (!r.spanId || !r.spanKind || r.spanKind === 'turn') continue
    const acc = accOf(spans, r.spanId)
    if (r.spanEndedAt != null) acc.end = acc.end ? later(acc.end, r) : r
    else if (!acc.start || (r.spanStartedAt ?? r.at) < (acc.start.spanStartedAt ?? acc.start.at)) acc.start = r
    acc.rows.push(r)
  }

  const now = Date.now()
  const stages: RunStage[] = []
  const requestAt = startRow?.runStartedAt ?? startedAt
  if (startRow || rows.length) {
    // `run_start` 滑出缓冲后仍保留「请求进入」节点：缺节点会让图变矮、下方内容整体上移。
    stages.push({
      key: `${runId}:request`,
      kind: 'request',
      detail: startRow?.prompt ?? '',
      result: '',
      status: 'ok',
      startedAt: requestAt,
      endedAt: requestAt,
      raw: startRow?.payload,
    })
  }
  if (kernel) {
    const exts = data(kernel).extensions
    stages.push({
      key: `${runId}:kernel`,
      kind: 'kernel',
      detail: Array.isArray(exts) ? exts.join(' · ') : '',
      result: text(data(kernel).pid),
      status: 'ok',
      startedAt: kernel.at,
      endedAt: kernel.at,
      raw: kernel.payload,
    })
  }
  // 骨干固定「请求进入 → 内核」，不按时间戳和 span 混排（kernel_start 常早于请求）。
  // 其余环节按「首次出现」定位：事件只会追加，节点位置就不该在后续帧里被重排。
  const firstSeen = new Map<string, number>()
  rows.forEach((r, i) => {
    if (r.spanId && !firstSeen.has(r.spanId)) firstSeen.set(r.spanId, i)
  })
  const timed: Array<{ order: number; at: number; stage: RunStage }> = []
  for (const [spanId, acc] of spans) {
    const kind = (acc.start ?? acc.end)?.spanKind ?? ''
    const stage = stageFromSpan(runId, kind, spanId, acc, now)
    if (stage) timed.push({ order: firstSeen.get(spanId) ?? 0, at: stage.startedAt, stage })
  }
  // 专家身份切换 / 交接：桥侧合成事件，落在自己的时刻上，图上能看出谁在跑、何时换人。
  rows.forEach((row, i) => {
    if (row.kind !== 'expert') return
    timed.push({
      order: i,
      at: row.at,
      stage: {
        key: `${runId}:${row.spanId ?? `expert-${i}`}`,
        kind: 'expert',
        label: row.label ?? row.title,
        detail: row.detail,
        result: '',
        status: 'ok',
        startedAt: row.at,
        endedAt: row.at,
        agentId: row.agentId,
        raw: row.payload,
      },
    })
  })
  timed.sort((a, b) => a.order - b.order || a.at - b.at)
  stages.push(...timed.map((x) => x.stage))

  // 终态：落定 / 中断 / 重试打穿。门禁拒绝与单工具失败只影响对应环节，不篡改整轮结论。
  let status: StageStatus = endedAt ? (interrupted ? 'cancelled' : 'ok') : 'run'
  const failedRetry = [...stages].reverse().find((s) => s.kind === 'retry' && s.status === 'failed')
  if (endedAt && failedRetry) status = 'failed'
  if (endedAt) {
    // 中断 / 被打断的轮次：未收口的环节跟着整轮落成「已中断」，
    // 不能让它停在进行中，也不能继续累计耗时。
    if (status === 'cancelled') {
      for (const s of stages) {
        if (s.endedAt != null) continue
        s.endedAt = endedAt
        if (s.status === 'run') s.status = 'cancelled'
      }
    }
    stages.push({
      key: `${runId}:end`,
      kind: 'end',
      detail: '',
      result: '',
      status,
      startedAt: endedAt,
      endedAt,
      raw: endRow?.payload,
    })
  }

  return {
    runId,
    prompt: startRow?.prompt ?? '',
    startedAt: startedAt,
    endedAt,
    status,
    stages,
    degraded: !runId.startsWith('run-'),
  }
}

/** 老事件（无 runId）：按 turn_start…settled 聚合，标记降级后照样能看。 */
function buildLegacy(events: PiEventRow[]): RunChain[] {
  const runs: RunChain[] = []
  let current: PiEventRow[] = []
  let seq = 0
  const flush = () => {
    if (!current.length) return
    const rows = current
    current = []
    const startedAt = rows[0].at
    const settledAt = [...rows].reverse().find((r) => r.kind === 'settled')?.at
    const stages: RunStage[] = []
    const tools = new Map<string, SpanAcc>()
    for (const r of rows) {
      if (r.kind === 'tool_call' || r.kind === 'tool_result') {
        const key = r.toolCallId || `tool-${tools.size}`
        const acc = accOf(tools, key)
        if (r.kind === 'tool_call') acc.start = r
        else acc.end = r
        acc.rows.push(r)
      }
    }
    for (const [key, acc] of tools) {
      const anchor = acc.start ?? acc.end!
      stages.push({
        key: `legacy-${seq}:${key}`,
        kind: 'tool',
        label: anchor.label ?? anchor.title,
        detail: anchor.detail,
        result: acc.end?.result || acc.end?.detail || '',
        status: acc.end ? (data(acc.end).isError === true ? 'failed' : 'ok') : 'run',
        startedAt: anchor.at,
        endedAt: acc.end?.at ?? null,
        raw: (acc.end ?? anchor).payload,
      })
    }
    const firstMsg = rows.find((r) => r.kind === 'message')
    if (firstMsg) {
      stages.unshift({
        key: `legacy-${seq}:model`,
        kind: 'model',
        detail: '',
        result: firstMsg.title,
        status: 'ok',
        startedAt: firstMsg.at,
        endedAt: firstMsg.at,
        raw: firstMsg.payload,
      })
    }
    stages.sort((a, b) => a.startedAt - b.startedAt)
    const status: StageStatus = settledAt ? 'ok' : 'run'
    runs.push({
      runId: `legacy-${++seq}`,
      prompt: '',
      startedAt,
      endedAt: settledAt ?? null,
      status,
      stages,
      degraded: true,
    })
  }
  for (const ev of events) {
    if (ev.kind === 'turn_start') {
      flush()
      current = [ev]
    } else if (current.length) {
      current.push(ev)
      if (ev.kind === 'settled') flush()
    }
  }
  flush()
  return runs
}

/** 入口：按 runId 分组；没有 runId 的老事件走降级聚合。 */
export function buildRunChains(events: PiEventRow[]): RunChain[] {
  const grouped = new Map<string, PiEventRow[]>()
  const kernelStarts: PiEventRow[] = []
  const exits: PiEventRow[] = []
  const bare: PiEventRow[] = []
  for (const ev of events) {
    if (ev.type === 'kernel_start') kernelStarts.push(ev)
    if (ev.kind === 'exit') exits.push(ev)
    if (ev.runId) {
      const list = grouped.get(ev.runId) ?? []
      list.push(ev)
      grouped.set(ev.runId, list)
    } else if (ev.kind !== 'exit' && ev.type !== 'kernel_start') {
      bare.push(ev)
    }
  }

  const runs: RunChain[] = []
  for (const [runId, rows] of grouped) {
    const startedAt = runStartAt(rows)
    const kernel = [...kernelStarts].reverse().find((k) => k.at <= startedAt)
    const exitAt = exits.find((e) => e.at >= startedAt)?.at
    runs.push(buildRun(runId, rows, kernel, exitAt))
  }
  if (bare.length) runs.push(...buildLegacy(bare))
  const ordered = runs.sort((a, b) => a.startedAt - b.startedAt)
  // 中止兜底：旧 run 没等到 settled 就被下一次请求顶掉——按「已中断」收口，
  // 不让它永远显示进行中。真实中断仍以 process_exit / runStatus 为准。
  for (let i = 0; i < ordered.length - 1; i++) {
    const run = ordered[i]
    if (run.endedAt != null) continue
    const next = ordered[i + 1]
    run.endedAt = next.startedAt
    run.status = 'cancelled'
    run.stages.push({
      key: `${run.runId}:end`,
      kind: 'end',
      detail: '',
      result: '',
      status: 'cancelled',
      startedAt: next.startedAt,
      endedAt: next.startedAt,
    })
    // 被顶掉时，最后一段还在跑的环节也一起收口，避免耗时无限增长。
    for (const s of run.stages) {
      if (s.endedAt != null) continue
      s.endedAt = next.startedAt
      if (s.status === 'run') s.status = 'cancelled'
    }
  }
  return ordered
}

/** 图上同时展示的轮次上限，和调用方的 `slice(-12)` 保持一致。 */
const KEEP_RUNS = 12
/** 内核拉起事件只用来绑定骨干节点，留最近若干条足够。 */
const KEEP_KERNELS = 24

/**
 * 链路图的数据源。
 *
 * 实时事件是定长环形缓冲，最旧的行会被淘汰；图如果每帧直接从缓冲重建，
 * `run_start` / `kernel_start` / 早期工具行滑出窗口时，节点会凭空消失、
 * 整张图变矮，下方内容一帧内整体上移。这里按事件对象增量累加，
 * 只保留最近 KEEP_RUNS 轮，让图的节点集合跟首次出现时一致。
 */
export function createRunChainStore() {
  let seen = new WeakSet<PiEventRow>()
  let kept: PiEventRow[] = []
  let runOrder: string[] = []
  let last: PiEventRow | null = null

  const reset = () => {
    seen = new WeakSet()
    kept = []
    runOrder = []
    last = null
  }

  return {
    /** 累积本轮新到的事件，返回可用于建链的完整行集。 */
    sync(events: PiEventRow[]): PiEventRow[] {
      if (!events.length) {
        if (kept.length) reset()
        return kept
      }
      // 缓冲被整体替换（切会话 / 重放）时旧数据必须清掉，否则图会串台。
      if (last && !events.includes(last)) reset()
      for (const ev of events) {
        if (seen.has(ev)) continue
        seen.add(ev)
        kept.push(ev)
        if (ev.runId && !runOrder.includes(ev.runId)) runOrder.push(ev.runId)
      }
      last = events[events.length - 1]
      if (runOrder.length > KEEP_RUNS) {
        runOrder = runOrder.slice(-KEEP_RUNS)
        const live = new Set(runOrder)
        kept = kept.filter((ev) => !ev.runId || live.has(ev.runId))
      }
      const kernels = kept.filter((ev) => ev.type === 'kernel_start')
      if (kernels.length > KEEP_KERNELS) {
        const drop = new Set(kernels.slice(0, kernels.length - KEEP_KERNELS))
        kept = kept.filter((ev) => !drop.has(ev))
      }
      return kept
    },
    reset,
  }
}

/** 一行摘要用词（状态）。 */
export function runStatusText(status: StageStatus): string {
  const table: Record<StageStatus, string> = {
    run: t('进行中'),
    ok: t('完成'),
    failed: t('失败'),
    blocked: t('被工具门拒绝'),
    timeout: t('等待审批超时'),
    cancelled: t('已中断'),
  }
  return table[status]
}

/** 阶段名。工具段用自己的折叠文案。 */
export function stageLabel(stage: RunStage): string {
  if (stage.kind === 'tool') return stage.label ?? t('工具')
  if (stage.kind === 'expert') return stage.label ?? t('专家接管')
  const table: Record<Exclude<StageKind, 'tool' | 'expert'>, string> = {
    request: t('请求进入'),
    kernel: t('内核拉起'),
    model: t('模型调用'),
    gate: t('工具门判定'),
    retry: t('自动重试'),
    end: t('轮次结束'),
  }
  return table[stage.kind as Exclude<StageKind, 'tool' | 'expert'>]
}

/** 阶段耗时：进行中的段用 now 推算，长任务会随每秒刷新持续增长。 */
export function stageElapsed(stage: RunStage, now: number): number {
  return Math.max(0, (stage.endedAt ?? now) - stage.startedAt)
}

/** 阶段是否「长任务」：超过 10s 仍未收口，界面要显式提示还在跑。 */
export const LONG_STAGE_MS = 10_000

export function isLongStage(stage: RunStage, now: number): boolean {
  return stage.endedAt == null && now - stage.startedAt >= LONG_STAGE_MS
}

/** 摘要片段：`模型 → 3 次工具 → 1 次工具失败 → 完成，2.4s`。 */
export function runSummary(run: RunChain, now: number): { parts: string[]; duration: number } {
  const tools = run.stages.filter((s) => s.kind === 'tool')
  const failed = tools.filter((s) => s.status === 'failed').length
  const blocked = run.stages.filter((s) => s.kind === 'gate' && s.status === 'blocked').length
  const parts: string[] = []
  if (run.stages.some((s) => s.kind === 'model')) parts.push(t('模型'))
  if (tools.length) parts.push(t('{0} 次工具', [tools.length]))
  if (failed) parts.push(t('{0} 次工具失败', [failed]))
  if (blocked) parts.push(t('{0} 次被拒', [blocked]))
  parts.push(runStatusText(run.status))
  return { parts, duration: Math.max(0, (run.endedAt ?? now) - run.startedAt) }
}
