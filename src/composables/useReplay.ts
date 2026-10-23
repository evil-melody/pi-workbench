import { invoke } from '@tauri-apps/api/core'
import { ref } from 'vue'
import { IN_TAURI, type PiMsg, splitPromptBody } from '@/composables/usePi'
import { applyEvent, emptyUsageState, type EventCtx } from '@/composables/piEvents'

/**
 * 侧栏运行记录 → 对话页的跨组件回放请求。
 *
 * 侧栏活得比对话页久（点记录时对话页可能还没挂载），不能走 props：
 * 这里放一个模块级信箱，对话页 watch 到非空就消费回放并清空。
 */
export const pendingReplayIndex = ref<number | null>(null)

/**
 * A4/G4 崩溃重放与会话持久化：从 B2 journal（`pi_journal_read` 读回的
 * `pi://event` 审计流）重建会话转写。journal 每条事件都带 enrich 后的
 * seq/ts 锚点，按序喂给与实时通道同一套 `applyEvent` 折算——重放与实况
 * 走同一逻辑，不会分叉。
 *
 * G4 起转写覆盖双侧：user prompt 原文本就在 journal 里（message_end 的
 * role=user 实证），回放通道（ctx.replay）把它落成 user 气泡，正文剥掉
 * dispatchToPi 的 preamble 前缀与 buildPrompt 的附件块。
 */
export interface ReplayResult {
  messages: PiMsg[]
  /** journal 事件总数（含非消息事件）。 */
  eventCount: number
  error?: string
}

/// journal 是**多项目共用**的（内核按 cwd 启停，事件全流进同一个文件）。
/// 回放只取最后一个 cwd 匹配的 `session_open`（pi_start 落的标记）到**下一个**
/// 标记之间的事件——切到结尾会把下一个项目的段也包进来（串项目的根因）。
/// 尾斜杠视为同一目录。
export function selectSessionEvents(events: any[], cwd?: string): any[] {
  if (!cwd) return events
  const norm = normDir
  const target = norm(cwd)
  let start = -1
  let sawMarker = false
  for (let i = 0; i < events.length; i++) {
    const e = events[i]
    if (e && typeof e === 'object' && e.type === 'session_open') {
      sawMarker = true
      if (norm(e.cwd) === target) start = i
    }
  }
  // 有标记但都不匹配当前项目 → 这段 journal 属于别的项目，不回放。
  if (sawMarker && start < 0) return []
  // legacy journal（无标记）→ 全量尽力而为。
  if (start < 0) return events
  // 段尾 = 下一个 session_open（不论 cwd）；没有就是 journal 结尾。
  let end = events.length
  for (let i = start + 1; i < events.length; i++) {
    const e = events[i]
    if (e && typeof e === 'object' && e.type === 'session_open') {
      end = i
      break
    }
  }
  return events.slice(start + 1, end)
}

/** 从 journal 重建转写。`lastN` 限制只取末尾 N 条事件（缺省全量）。
 *  `cwd` 非空时只重建该项目的最近一次会话（见 selectSessionEvents）。
 *  `sessionIndex` 指定 journal 全局段号（来自 pi_journal_sessions 的 index，
 *  运行记录点击回放用）；给出时优先生效，`cwd` 退化为一致性校验。 */
export async function loadReplay(
  lastN?: number,
  cwd?: string,
  sessionIndex?: number,
): Promise<ReplayResult> {
  if (!IN_TAURI) {
    return { messages: [], eventCount: 0, error: '浏览器模式：journal 不可用' }
  }
  let events: any[]
  try {
    events = await invoke<any[]>('pi_journal_read', { lastN: lastN ?? null })
  } catch (e: any) {
    return { messages: [], eventCount: 0, error: String(e?.message ?? e) }
  }
  const scoped =
    sessionIndex !== undefined
      ? selectSessionByIndex(events, sessionIndex, cwd)
      : selectSessionEvents(events, cwd)
  const ctx: EventCtx = {
    messages: [],
    streaming: false,
    nextId: (() => {
      let i = 0
      return () => `r${i++}`
    })(),
    usage: emptyUsageState(),
    replay: true,
  }
  for (const ev of scoped) applyEvent(ctx, ev)
  // 流式中的尾巴消息落定：journal 最后一条未必是 agent_settled。
  for (const m of ctx.messages) m.streaming = false
  return { messages: ctx.messages, eventCount: scoped.length }
}

const normDir = (s: unknown) => String(s ?? '').replace(/\/+$/, '')

/**
 * 按 journal 全局段号取某一段（配合 `pi_journal_sessions` 的 index）。
 * `cwd` 给出时做一致性校验：段号与目录对不上（journal 被轮转/清理）返回空，
 * 绝不把别的项目的会话回放进当前对话。
 */
export function selectSessionByIndex(
  events: any[],
  sessionIndex: number,
  cwd?: string,
): any[] {
  const opens: { pos: number; cwd: string }[] = []
  events.forEach((e, i) => {
    if (e && typeof e === 'object' && e.type === 'session_open') {
      opens.push({ pos: i, cwd: String(e.cwd ?? '') })
    }
  })
  const seg = opens[sessionIndex]
  if (!seg) return []
  if (cwd && normDir(seg.cwd) !== normDir(cwd)) return []
  const end = sessionIndex + 1 < opens.length ? opens[sessionIndex + 1].pos : events.length
  return events.slice(seg.pos + 1, end)
}

/** 一条运行记录（journal 按 session_open 分段的摘要）。 */
export interface RunRecord {
  /** journal 全局段号，回放传给 loadReplay 的 sessionIndex。 */
  index: number
  cwd: string
  startedAtMs: number | null
  endedAtMs: number | null
  events: number
  /** 该段用户下发任务的次数。 */
  prompts: number
  /** 首条用户消息正文（已剥 preamble 前缀与附件块）。 */
  title: string
  /** run_meta：置顶（后端合并后随段返回，前端不自己合并）。 */
  pinned?: boolean
  /** run_meta：归档。默认列表不可见，includeArchived 时才带出。 */
  archived?: boolean
  /** run_meta：title 被用户重命名覆盖过（区别于 journal 首条消息）。 */
  renamed?: boolean
}

/**
 * 运行记录列表（WorkDSH「之前的运行记录」对位）：journal 按 session_open
 * 分段汇总，**新→旧**排序。`cwd` 给出时只列该项目的段。
 *
 * `includeArchived` 透传给后端 `pi_journal_sessions`：后端已在合并层
 * 过滤 deleted、默认过滤 archived、置顶段提前、title 覆盖——
 * 前端只负责透参与展示标记，不再做第二套合并。
 * 后端不可达 / 浏览器模式返回空数组（列表整体隐藏，不报错打扰）。
 */
export async function listRunHistory(cwd?: string, includeArchived = false): Promise<RunRecord[]> {
  if (!IN_TAURI) return []
  let all: any[]
  try {
    all = await invoke<any[]>('pi_journal_sessions', { includeArchived })
  } catch {
    return []
  }
  if (!Array.isArray(all)) return []
  const list = cwd ? all.filter((s) => normDir(s?.cwd) === normDir(cwd)) : all
  return list
    .map((s) => {
      const raw = String(s?.title ?? '')
      return {
        index: Number(s?.index),
        cwd: String(s?.cwd ?? ''),
        startedAtMs: Number.isFinite(s?.started_at_ms) ? Number(s.started_at_ms) : null,
        endedAtMs: Number.isFinite(s?.ended_at_ms) ? Number(s.ended_at_ms) : null,
        events: Number(s?.events) || 0,
        prompts: Number(s?.prompts) || 0,
        title: splitPromptBody(raw).text.trim(),
        pinned: s?.pinned === true,
        archived: s?.archived === true,
        renamed: s?.renamed === true,
      }
    })
    // 零任务的段（内核自动启停、只留启动标记）不是「运行记录」：
    // 列出来只会是一排「（该会话没有用户消息）」噪音。
    .filter((s) => Number.isInteger(s.index) && s.prompts > 0)
    .reverse()
    // 置顶稳定置前：后端合并已按置顶分组，reverse（新→旧）之后仍要保证
    // pinned 在列表头部。Array.prototype.sort 稳定，同组相对顺序不变。
    .sort((a, b) => Number(b.pinned ?? false) - Number(a.pinned ?? false))
}

/**
 * 独立回放窗口的 query 目标（后端 `open_replay_window` 用 hash 路由拉起：
 * `#/chat?replay=<段号>&cwd=<目录>`）。纯函数，可单测。
 *
 * 段号缺失 / 非整数 / 负数都视为「不是回放窗口」，返回 null；
 * cwd 缺省时退回空串（调用方决定要不要用活动项目目录兜底）。
 */
export function parseReplayQuery(
  query: Record<string, unknown> | undefined | null,
): { index: number; cwd: string } | null {
  const raw = query?.replay
  if (raw === undefined || raw === null || raw === '') return null
  const index = Number(raw)
  if (!Number.isInteger(index) || index < 0) return null
  const cwd = typeof query?.cwd === 'string' ? query.cwd : ''
  return { index, cwd }
}
