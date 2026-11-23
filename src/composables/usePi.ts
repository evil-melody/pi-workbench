import { t } from '@/i18n'
import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentScope, onScopeDispose, ref, watch } from 'vue'
import { flattenTree, type FlatNode, type PiTreeNode } from '@/composables/useSessionTree'
import { applyEvent, emptyUsageState, type EventCtx, type PiUsage, type QueueState, type QueueMutation, type UsageState, emptyQueueState, queueEntries, mutateQueueSnapshot, readQueueUpdate } from '@/composables/piEvents'
import type { PiFileChange } from '@/utils/fileChanges'
import { stripAskInstruction, stripPlanInstruction } from '@/utils/planMode'
import { traceLog } from '@/composables/useWebLog'

/**
 * 浏览器模式（`npm run app:dev:web`）下没有 Tauri IPC，内核通道不可用。
 * 此时显式拒答，而不是抛底层错误导致 UI 卡在 loading。
 */
export const IN_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const noKernel = () =>
  t('当前是浏览器模式，Pi 内核未接入。请用 npm run app:dev 启动桌面 App 后再对话。')

/**
 * 内核退出要不要惊动用户。
 *
 * 三条同时成立才算「本轮真有内容可能丢失」：有请求在飞、不是计划内停止的伴生退出、
 * 且不是同一次退出被重复订阅推来的第二条。
 * 空闲时退出（未发消息）一律不提示——后端会自动拉起，提示只会制造恐慌。
 */
export function shouldWarnKernelExit(input: {
  inFlight: boolean
  sinceStop: number
  sinceNotice: number
}): boolean {
  return input.inFlight && input.sinceStop > 5_000 && input.sinceNotice >= 2_000
}

/**
 * 回合空闲超时判据：**多久没收到任何事件**，不是总共跑了多久。
 * 正常回合每个 token 增量 / 工具调用都会刷事件，180s 完全静默意味着 provider
 * 挂起或链路断了；工具执行期间内核不产生事件（一次 bash 可能跑很久），
 * 所以有工具在跑时放宽到 600s。长任务只要还在吐事件就一直不打断。
 */
export function idleTimeoutMs(toolRunning: boolean): number {
  return toolRunning ? 600_000 : 180_000
}

/** 看门狗巡检间隔：5s 一次，超时误差不超过一个 tick。 */
export const IDLE_WATCHDOG_TICK_MS = 5_000

export interface PiMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  tool?: string
  streaming?: boolean
  /**
   * 消息产生时刻（Date.now）：dsh `MessageIconActions` 那颗时钟的数据源。
   * journal 回放的消息没有本地时刻，可能缺失——消费方必须判空，缺就隐藏时钟，
   * 不许拿 id 或落盘时间编一个假时间。
   */
  ts?: number
  /** 该条 assistant 消息的真实 token 用量（provider 上报，message_end 时挂载）。 */
  usage?: PiUsage
  /** 用户消息附带的图片/文件（已落盘到 app_config_dir/attachments）。 */
  attachments?: PiAttachment[]
  /** 用户消息引用的既有内容（选区/表格/Widget），随 prompt 以文本块下发，非落盘文件。 */
  quotes?: PiQuote[]
  /**
   * 回放重建的「排队/插话」用户消息：已落 journal，但内核尚未把它回显成正式消息。
   * 内核消费后会推同样文本的 message_end，届时清掉此标记而不是再插一条。
   */
  queued?: boolean
  /**
   * 回放时由 `user_prompt` 合成事件重建的用户消息（任何模式）。
   * 内核稍后回显同一文本时按此标记去重，而不是凭 `queued`——普通 prompt 也要去重。
   */
  synth?: boolean
  /** G2：本条 assistant 消息涉及的文件改动（edit/write 工具调用，按调用顺序）。 */
  fileChanges?: PiFileChange[]
  /** G3：本条 user 消息对应的 checkpoint turn seq（>0 才可「回到此处」）。 */
  turnSeq?: number
  /** G5：本条 assistant 消息是计划模式产出——分步计划卡，等用户确认后执行。 */
  plan?: PiPlan
  /**
   * dsh 对齐：工具 chip 的调用 id（`toolcall_start.toolCall.id`）。
   * 名字回填会消费 callId→msgId 映射，参数/结果回填还要能定位到同一条 chip，
   * 所以把 id 存在消息上，不依赖那份会被清掉的映射。
   */
  toolCallId?: string
  /** 工具调用参数摘要（序列化后的文本，已截断）。 */
  toolArgs?: string
  /** 工具执行结果摘要（`tool_execution_end.result` 的文本/序列化，已截断）。 */
  toolResult?: string
  /** 工具执行失败（`tool_execution_end.isError`）。 */
  toolError?: boolean
  /**
   * 思考（thinking）文本聚合：内核 message_update 内层 thinking_delta 逐段追加，
   * 渲染成 turn 内的 Think 折叠行（对齐 dsh 的一轮 = Think → 正文 → 工具行）。
   */
  reasoning?: string
}

/** G5：计划卡状态。pending=待确认；executing=已批准、执行 prompt 已下发。 */
export interface PiPlan {
  steps: string[]
  /** 触发该计划的用户原始任务（执行 prompt 要带回它，防执行时丢目标）。 */
  task: string
  state: 'pending' | 'executing'
}

/** #76 M3：受影响文件（绝对路径 + 归属的最早备份轮）。 */
export interface RewindFile {
  path: string
  from_seq: number
}

/** G3：rewind 结果（Rust checkpoint_rewind 原样回传）。 */
export interface RewindReport {
  seq: number
  restored: RewindFile[]
  /** 随回退删除的新建文件。 */
  removed: RewindFile[]
  failed: string[]
  fork_entry_id: string | null
}

/** #76 M3：回退前 dry-run（Rust checkpoint_preview 原样回传）。 */
export interface RewindPreview {
  seq: number
  restore: RewindFile[]
  delete: RewindFile[]
  failed: string[]
}

/** 一条附件的引用：id/name 供 UI，path 供 Pi 按路径读取（内核当前只接受字符串 prompt）。 */
export interface PiAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  /** 绝对路径（已由后端 attachment_add 落盘）。 */
  path: string
  /** 字节数；旧 journal 无此字段，卡片按未知处理。 */
  size?: number
}

/**
 * 一条「引用」：把某段既有内容（assistant 正文选区、表格行、Widget 结果）摘出来
 * 附到新消息里，语义与附件不同——附件是磁盘文件的路径，引用是一段随 prompt 下发的文本。
 * 走独立通道，不混进 attachments 的 image/file 渲染。
 */
export interface PiQuote {
  id: string
  /** text=纯文本选区；table/widget 留给后续结果区引用（#66），数据层先支持三种。 */
  kind: 'text' | 'table' | 'widget'
  /** 被引用的原文（可多行）。 */
  text: string
  /** 用户附加的批注（可空）。 */
  note?: string
  /** 来源标注（哪条消息/哪个面板，可空，仅供 UI 悬停展示，不下发内核）。 */
  source?: string
}

/**
 * 构造发给 Pi 的 prompt 文本。
 *
 * Pi RPC 的 `prompt.message` 当前只接受字符串（实证：传 content 数组报
 * `text.startsWith is not a function`），所以多模态附件以「路径引用块」追加进文本，
 * Pi 用其文件工具按路径读取。保持 message 为字符串是硬约束，不可改成形如
 * `[{type:image_url}]` 的对象——那是内核侧的能力，工作端只能绕行。纯函数，可单测。
 */
/**
 * 附件块分隔标记：随 prompt 下发给内核，属于模型输入的一部分，
 * 不参与界面本地化——否则切换语言后回放解析会对不上。
 */
const ATTACHMENT_MARKER = '[附件 / attachments]' // i18n-ignore: model prompt marker
const QUOTE_MARKER = '[引用 / quotes]' // i18n-ignore: model prompt marker

/** 批注行前缀（仅当 quote 带 note 时输出）。 */
const QUOTE_NOTE_PREFIX = '批注: ' // i18n-ignore: model prompt marker

/**
 * 引用块的行内编码：多行原文压成一行，避免与附件块/空行解析规则打架。
 * `\n` → `\\n`，反斜杠 → `\\\\`。解码必须单遍成对消费：
 * 顺序两次 replace 会把 `C:\\new`（反斜杠+字母 n）里的 `\n` 误放出真换行。
 */
function encodeQuoteText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')
}
function decodeQuoteText(s: string): string {
  return s.replace(/\\(n|\\)/g, (_m, ch: string) => (ch === 'n' ? '\n' : '\\'))
}

/** 把引用块拼成下发文本（不含前导空行，由 buildPrompt 决定位置）。 */
function renderQuoteBlock(quotes: PiQuote[]): string {
  const lines = quotes.map((q, i) => {
    const head = `- [${i + 1}] ${encodeQuoteText(q.text)}`
    return q.note ? `${head}\n  ${QUOTE_NOTE_PREFIX}${encodeQuoteText(q.note)}` : head
  })
  return `${QUOTE_MARKER}\n${lines.join('\n')}`
}

export function buildPrompt(
  text: string,
  attachments?: PiAttachment[],
  quotes?: PiQuote[],
): string {
  let out = text
  // 引用块在附件块之前：splitPromptBody 先剥附件（总在最后），再剥引用。
  if (quotes && quotes.length > 0) out = `${out}\n\n${renderQuoteBlock(quotes)}`
  if (attachments && attachments.length > 0) {
    const lines = attachments.map((a) =>
      a.kind === 'image' ? `- image: ${a.path}` : `- file: ${a.path}`,
    )
    out = `${out}\n\n${ATTACHMENT_MARKER}\n${lines.join('\n')}`
  }
  return out
}

/** buildPrompt 的逆运算：从下发给内核的正文还原「用户原文 + 附件 + 引用」。
 *  dispatchToPi 会加 `preamble\n\n---\n\n` 前缀、buildPrompt 会追加引用/附件块，
 *  journal 回放时必须都剥掉，气泡里才显示用户原话而不是大段项目上下文。 */
export function splitPromptBody(body: string): {
  text: string
  attachments: PiAttachment[]
  quotes: PiQuote[]
} {
  const SEP = '\n\n---\n\n'
  const ATT = `\n\n${ATTACHMENT_MARKER}\n`
  const QT = `\n\n${QUOTE_MARKER}\n`
  const sepAt = body.indexOf(SEP)
  let rest = sepAt >= 0 ? body.slice(sepAt + SEP.length) : body
  // G5：plan/ask 指令前缀拼在最外，无 preamble（无 SEP）时会残留在 rest 头部，剥掉。
  rest = stripAskInstruction(stripPlanInstruction(rest))
  const attachments: PiAttachment[] = []
  const attAt = rest.indexOf(ATT)
  if (attAt >= 0) {
    const block = rest.slice(attAt + ATT.length)
    rest = rest.slice(0, attAt)
    for (const line of block.split('\n')) {
      const m = /^-\s*(image|file):\s*(.+)$/.exec(line.trim())
      if (!m) continue
      const p = m[2]
      attachments.push({
        id: `ra${attachments.length}`,
        name: p.split('/').pop() || p,
        kind: m[1] === 'image' ? 'image' : 'file',
        path: p,
      })
    }
  }
  // 附件块剥离后再找引用块——顺序不能反，否则引用解析会把附件路径行当正文吃掉。
  const quotes: PiQuote[] = []
  const qtAt = rest.indexOf(QT)
  if (qtAt >= 0) {
    const block = rest.slice(qtAt + QT.length)
    rest = rest.slice(0, qtAt)
    let cur: PiQuote | null = null
    for (const raw of block.split('\n')) {
      // 与 renderQuoteBlock 严格镜像（`- [n] ` / `  批注: ` 都是精确单空格）：
      // 宽松的 \s* + trimEnd 会把原文首尾的空格当格式符吃掉，往返就不无损了。
      const head = /^- \[\d+\] (.*)$/.exec(raw)
      if (head) {
        cur = { id: `rq${quotes.length}`, kind: 'text', text: decodeQuoteText(head[1]) }
        quotes.push(cur)
        continue
      }
      const note = /^  批注: (.*)$/.exec(raw) // i18n-ignore: model prompt marker (parse side)
      if (note && cur) cur.note = decodeQuoteText(note[1])
    }
  }
  return { text: rest, attachments, quotes }
}

export interface PiTreeData {
  tree: PiTreeNode[]
  leafId: string | null
}

export function usePi() {
  const messages = ref<PiMsg[]>([])
  const streaming = ref(false)
  const tree = ref<PiTreeData>({ tree: [], leafId: null })
  /** 会话树视图（摊平后）。 */
  const nodes = ref<FlatNode[]>([])
  /** 会话级 token 用量（内核真实上报，非估算）。 */
  const usage = ref<UsageState>(emptyUsageState())
  /**
   * G5：plan 轮待确认计划。dispatchToPi 在 plan 模式发送前置值，
   * 该轮 assistant 回复落定时由 applyEvent 消费（解析成计划卡）并清空。
   * 跨模块可见是为了让 eventCtx 用 getter/setter 桥接，消费写回同一 ref。
   */
  const planPending = ref<{ task: string } | null>(null)
  /**
   * M5：本轮落定后扩展产出的延续问题。eventCtx 用 getter/setter 桥接，
   * 新条目到达整体覆盖；用户发送/换会话时前端自行清空。
   */
  const suggestions = ref<string[]>([])
  /**
   * G6：消息队列（steer 插话 + follow_up 排队）。以内核 queue_update 事件为
   * 权威数据源——入队/消费内核都会回推，前端不维护副账。
   */
  const queue = ref<QueueState>(emptyQueueState())
  let un: UnlistenFn | null = null
  /** 订阅并发保护：`un` 在 await 之后才赋值，两次并发 ensure 会各挂一条监听。 */
  let ensuring: Promise<void> | null = null
  let seq = 0
  /** 最近一次内核主动停止/重启时刻（ms）：抑制伴生的 process_exit 系统消息。 */
  let lastKernelStoppedAt = 0
  /** 最近一次弹出「内核已退出」的时刻：同一退出被多个订阅者各推一条时去重。 */
  let lastExitNoticeAt = 0
  /** 最近一次收到回合内任何事件的时刻（ms）：空闲看门狗的唯一判据。 */
  let lastTurnEventAt = 0
  /** 正在执行的工具调用 id：有工具在跑时超时阈值放宽（工具期间内核不发事件）。 */
  const activeTools = new Set<string>()
  let watchdogTimer: ReturnType<typeof setInterval> | null = null
  /**
   * 超时收口信号：每收口一次 +1。ChatView 据此做内核自检（活着就 abort 收轮、
   * 死了就重新拉起）并把消息放回输入框——超时不是取消，用户要能立刻续上。
   */
  const timeoutTick = ref(0)

  async function ensure() {
    if (un || !IN_TAURI) return
    if (!ensuring) {
      ensuring = listen<any>('pi://event', (e) => handle(e.payload))
        .then((fn) => {
          un = fn
        })
        .finally(() => {
          ensuring = null
        })
    }
    await ensuring
  }

  function start(cwd?: string) {
    if (!IN_TAURI) return Promise.reject(new Error(noKernel()))
    return invoke('pi_start', { cwd: cwd ?? null })
  }

  function stop() {
    if (!IN_TAURI) return Promise.resolve()
    return invoke('pi_stop')
  }

  /** 原地重启内核：改模型 / 改工具白名单后调用，新配置在新进程里生效。 */
  function restart() {
    if (!IN_TAURI) return Promise.reject(new Error(noKernel()))
    return invoke('pi_restart')
  }

  /**
   * 全双工 RPC：下发一条 Pi 命令，等它自己的响应返回。
   * 响应之外的流式事件走 `pi://event`，两条通道互不阻塞。
   * `timeoutMs` 可选：默认 30s，压缩（compact）这类长操作要放宽。
   */
  function rpc<T = any>(
    type: string,
    payload: Record<string, unknown> = {},
    timeoutMs?: number,
  ): Promise<T> {
    if (!IN_TAURI) return Promise.reject(new Error(noKernel()))
    return invoke<T>('pi_call', {
      json: JSON.stringify({ ...payload, type }),
      ...(timeoutMs ? { timeout_ms: timeoutMs } : {}),
    })
  }

  /** 取会话树并刷新视图。 */
  async function refreshTree() {
    const data = await rpc<PiTreeData>('get_tree')
    tree.value = data ?? { tree: [], leafId: null }
    nodes.value = flattenTree(tree.value.tree, tree.value.leafId)
    return tree.value
  }

  /** 从某个条目分叉：Pi 把分支游标移到该条目，之后新的 prompt 就从这里继续。 */
  async function forkFrom(entryId: string) {
    await rpc('fork', { entryId })
    await refreshTree()
  }

  /**
   * G3：开轮快照。prompt 下发前调用：Rust 记下当前会话树叶子并打 marker，
   * 返回 turn seq（挂在 user 消息上，「回到此处」用）。失败返回 0（不阻断发送）。
   */
  async function beginTurn(promptHead: string): Promise<number> {
    if (!IN_TAURI) return 0
    try {
      return await invoke<number>('checkpoint_begin_turn', {
        prompt_head: promptHead.slice(0, 80),
      })
    } catch {
      return 0
    }
  }

  /**
   * G3：回到某轮之前——还原**该轮起** edit/write 改过的文件、删除该轮起新建的
   * 文件（#76 区间语义）+ fork 会话树。bash 产生的变更不在快照范围（对齐
   * Claude Code checkpoint 限制）。
   */
  async function rewindTurn(seq: number): Promise<RewindReport> {
    const rep = await invoke<RewindReport>('checkpoint_rewind', { seq })
    await refreshTree().catch(() => {})
    return rep
  }

  /** #76 M3：回退前 dry-run——确认框列受影响产物用（不落盘）。 */
  async function previewTurn(seq: number): Promise<RewindPreview> {
    return await invoke<RewindPreview>('checkpoint_preview', { seq })
  }

  function pushUser(text: string, attachments?: PiAttachment[], quotes?: PiQuote[]) {
    messages.value.push({
      id: `u${seq++}`,
      role: 'user',
      text,
      ts: Date.now(),
      ...(attachments?.length ? { attachments } : {}),
      ...(quotes?.length ? { quotes } : {}),
    })
  }

  /** 系统级提示（内核不可用 / 下发失败等）：必须进消息流，用户才看得见发生了什么。 */
  function pushSystem(text: string) {
    messages.value.push({ id: `s${seq++}`, role: 'system', text })
  }

  /**
   * 发送前先把用户原文落 journal（在乐观气泡出现后立刻调用）。
   *
   * 下发前还要收集项目上下文（最多 3.5s）；这段窗口内刷新 / 重挂载会丢掉
   * 尚未下发的消息。先落一条 `user_prompt`，回放即可还原；
   * 随后的 `send(..., journaled=true)` 不再重复合成。
   */
  function noteUser(
    text: string,
    attachments?: PiAttachment[],
    quotes?: PiQuote[],
  ): Promise<boolean> {
    if (!IN_TAURI) return Promise.resolve(false)
    const payload = {
      text,
      mode: 'prompt',
      ...(attachments?.length ? { attachments } : {}),
      ...(quotes?.length ? { quotes } : {}),
    }
    return invoke('pi_note_user', { json: JSON.stringify(payload) }).then(
      () => true,
      () => false,
    )
  }

  /**
   * `expert`：本次运行的专家身份。桥侧据此把白名单写进项目策略文件，
   * 并在链路里落 `expert_start`（带 handoffFrom 时标成交接）。
   */
  function send(
    text: string,
    attachments?: PiAttachment[],
    expert?: { id: string; handoffFrom?: string },
    journaled = false,
    quotes?: PiQuote[],
  ) {
    if (!IN_TAURI) return Promise.reject(new Error(noKernel()))
    // message 必须是字符串（Pi 协议约束）；附件以路径引用块、引用以文本块追加进文本。
    const cmd = {
      id: `c${Date.now()}`,
      type: 'prompt',
      message: buildPrompt(text, attachments, quotes),
      ...(attachments?.length ? { attachments } : {}),
      ...(quotes?.length ? { quotes } : {}),
      ...(journaled ? { journaled: true } : {}),
      ...(expert
        ? { expertId: expert.id, ...(expert.handoffFrom ? { handoffFrom: expert.handoffFrom } : {}) }
        : {}),
    }
    streaming.value = true
    return invoke('pi_send', { json: JSON.stringify(cmd) }).catch((e) => {
      streaming.value = false
      throw e
    })
  }

  /** 排队/插话也必须走 pi_send：只有它会把 user_prompt 落 journal（pi_call 不会）。 */
  function sendQueued(
    type: 'follow_up' | 'steer',
    text: string,
    attachments?: PiAttachment[],
    quotes?: PiQuote[],
  ) {
    if (!IN_TAURI) return Promise.reject(new Error(noKernel()))
    const cmd = {
      id: `c${Date.now()}`,
      type,
      message: buildPrompt(text, attachments, quotes),
      ...(attachments?.length ? { attachments } : {}),
      ...(quotes?.length ? { quotes } : {}),
    }
    return invoke('pi_send', { json: JSON.stringify(cmd) })
  }

  /** 只消费流式事件。`pi://event` 里已不含命令响应（响应由 pi_call 路由）。 */
  /** 应用一条事件到状态（不含节流判断）。 */
  function applyNow(rec: any) {
    // ctx 跨事件复用：fileGroupId（G2 文件改动归组）必须跨事件保留，
    // 每条事件新建 ctx 会把归组状态冲掉。
    if (!eventCtx) {
      eventCtx = {
        messages: messages.value,
        streaming: streaming.value,
        nextId: () => `a${seq++}`,
        usage: usage.value,
        fileGroupId: null,
        // G5：getter/setter 桥接 planPending——applyEvent 消费后写回的 null
        // 必须同步到 ChatView 看到的同一个 ref，值拷贝会残留上一轮的待确认态。
        get planPending() {
          return planPending.value
        },
        set planPending(v) {
          planPending.value = v
        },
        // M5：推荐源同 planPending——applyEvent 写入写回同一 ref。
        get suggestions() {
          return suggestions.value
        },
        set suggestions(v) {
          suggestions.value = v ?? []
        },
      }
    }
    applyEvent(eventCtx, rec)
    // 结束信号属于本 composable 的状态，不在 applyEvent 里动。
    // 这里不再从 `message_update` 把 running 拉回 true：节流后的延迟事件会在
    // `agent_settled` 之后才落盘，反向复活 streaming，界面永久停在「等待模型响应…」。
    // 实时置 true 由 `handle` 负责。
    if (rec?.type === 'agent_settled' || rec?.type === 'process_exit') streaming.value = false
  }

  /**
   * 流式合并：一条待应用的 `message_update`，配合下面的定时器按帧落盘。
   * 内核这些事件只带**增量**（`text_delta.delta`），同帧内必须累加；
   * 直接覆盖会把整段回复丢成空消息（实测本地小模型一次回复落在一帧内）。
   */
  let pendingDelta: any = null
  let deltaTimer: ReturnType<typeof setTimeout> | null = null
  /** 跨事件复用的事件受理上下文（G2 文件改动归组 / G5 待确认计划状态挂在上面）。 */
  let eventCtx: EventCtx | null = null

  function flushDelta() {
    deltaTimer = null
    const rec = pendingDelta
    pendingDelta = null
    if (rec) applyNow(rec)
  }

  /** 收掉看门狗：正常落定 / 用户取消 / 超时收口都走这里。 */
  function stopWatchdog() {
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    activeTools.clear()
  }

  /**
   * 空闲超时收口：这一轮不再等 provider。
   *
   * 与「用户取消」是两种结果：取消是用户意图（`abort:graceful` + 中断收据），
   * 这里是链路无响应（`turn:timeout` + 系统消息 + 消息回填输入框）。
   * 收口前先把已收到的增量冲掉，用户看到的正文不因超时丢字。
   */
  function onIdleTimeout() {
    const limit = idleTimeoutMs(activeTools.size > 0)
    const idle = Date.now() - lastTurnEventAt
    traceLog('turn:timeout', `idle=${idle}ms limit=${limit}ms tools=${activeTools.size}`)
    if (deltaTimer) {
      clearTimeout(deltaTimer)
      deltaTimer = null
    }
    if (pendingDelta) {
      const p = pendingDelta
      pendingDelta = null
      applyNow(p)
    }
    streaming.value = false
    for (const m of messages.value) if (m.streaming) m.streaming = false
    pushSystem(
      t('等待模型响应超时：{0} 秒内没有任何事件，已停止等待。可重新发送这条消息继续。', [
        Math.round(limit / 1000),
      ]),
    )
    // 内核若只是 provider 挂起，abort 能把这一轮收掉，下次发送不会撞上残留状态；
    // 若内核已不可用，这次调用失败，由 ChatView 的 get_tree 自检决定重启。
    rpc('abort', {}, 5_000).catch((e) => traceLog('turn:timeout-abort-fail', String(e)))
    stopWatchdog()
    timeoutTick.value++
  }

  /** 开/续看门狗：每次 streaming 变 true 重置计时，之后只由事件刷新。 */
  function armWatchdog() {
    lastTurnEventAt = Date.now()
    stopWatchdog()
    watchdogTimer = setInterval(() => {
      if (!streaming.value) {
        stopWatchdog()
        return
      }
      if (Date.now() - lastTurnEventAt >= idleTimeoutMs(activeTools.size > 0)) onIdleTimeout()
    }, IDLE_WATCHDOG_TICK_MS)
  }

  const stopStreamWatch = watch(streaming, (on) => (on ? armWatchdog() : stopWatchdog()))

  function handle(rec: any) {
    // 任何事件都算「内核还活着」：空闲判据只看距上次事件的间隔，不看总时长。
    lastTurnEventAt = Date.now()
    // 工具执行期间内核不发增量事件，用调用 id 维护在跑集合，阈值据此放宽。
    const callId = String(rec?.toolCallId ?? rec?.toolName ?? '')
    if (callId) {
      if (rec?.type === 'tool_execution_start') activeTools.add(callId)
      else if (rec?.type === 'tool_execution_end') {
        activeTools.delete(callId)
        if (rec?.toolName) activeTools.delete(String(rec.toolName))
      }
    }
    // G6：队列回推（steer/follow_up 入队与消费时内核都会发）——chip 的权威数据源。
    if (rec?.type === 'queue_update') {
      const q = readQueueUpdate(rec)
      if (q) queue.value = q
      return
    }
    // `pi_send` 是 fire-and-forget：内核对该 prompt 的失败回执（无 API key、
    // 模型不可用等）没有接收方，由后端回推进事件流。不在这里落地，用户看到的
    // 就是「消息发出去了，然后什么都没有」——连 streaming 都不会结束。
    if (rec?.type === 'response' && rec.success === false) {
      pushSystem(t('内核返回失败：{0}', [rec.error ?? t('未知错误')]))
      streaming.value = false
      return
    }
    // 结束类事件低频且带状态语义：立即应用，不节流。
    if (rec?.type === 'agent_settled' || rec?.type === 'process_exit') {
      // 先把待落盘的增量冲掉：否则它会在落定之后才应用，正文丢失且
      // 流式游标挂死。冲完再应用结束态，顺序与内核语义一致。
      if (deltaTimer) {
        clearTimeout(deltaTimer)
        deltaTimer = null
      }
      if (pendingDelta) {
        const p = pendingDelta
        pendingDelta = null
        applyNow(p)
      }
      // 内核自灭必须让用户看见：否则消息停在「已发送」，表现为「点了没反应」。
      // 主动重启（pi_restart）会先发 kernel_restarted，5 秒内的 process_exit 视为重启伴生，不打扰。
      if (rec?.type === 'process_exit') {
        const sinceStop = Date.now() - lastKernelStoppedAt
        // 只在「有请求在飞」时提示：未发消息就退出，用户没有可能丢失的内容，
        // 提示只会制造恐慌。计划内停止与意外退出由后端按停止世代区分并自动拉起。
        const inFlight = streaming.value
        const sinceNotice = Date.now() - lastExitNoticeAt
        traceLog('kernel:exit-event', `sinceStop=${sinceStop}ms inFlight=${inFlight}`)
        if (shouldWarnKernelExit({ inFlight, sinceStop, sinceNotice })) {
          lastExitNoticeAt = Date.now()
          pushSystem(
            t('Pi 内核进程已退出，本条消息可能没有送达。请重开会话页或重启 App 重新拉起内核。'),
          )
        }
      }
      applyNow(rec)
      return
    }
    if (rec?.type === 'kernel_restarted') {
      lastKernelStoppedAt = Date.now()
      // 新内核没有旧队列，前端照旧显示就会出现「排队中」但永远不会执行。
      queue.value = emptyQueueState()
      // 切模型 / 改工具白名单会在本轮未结束时重启内核，本轮已被丢弃。
      // 只记时间戳不提示，用户看到的就是「消息发出去了，然后没有下文」。
      if (streaming.value) {
        pushSystem(t('内核已重启（模型或工具配置变更），本轮回复已中断，可重新发送。'))
        streaming.value = false
      }
    }
    // `message_update` 在长回复里是逐字级的：每条都触发整列消息重渲染，
    // 主线程会饱和到「整窗卡死 + IMK run loop 报错」。合并成 ~60ms 一帧，
    // 渲染成本从「每条事件一次」降到「每秒十几次」，观感仍是流式。
    if (rec?.type === 'message_update') {
      streaming.value = true
      const ev = rec.assistantMessageEvent
      const prev = pendingDelta?.assistantMessageEvent
      // 同帧内同类型的增量累加，其它事件（toolcall_* / text_end）保持后到覆盖。
      if (
        prev &&
        ev &&
        prev.type === ev.type &&
        (ev.type === 'text_delta' || ev.type === 'thinking_delta') &&
        typeof prev.delta === 'string' &&
        typeof ev.delta === 'string'
      ) {
        pendingDelta = { ...rec, assistantMessageEvent: { ...ev, delta: prev.delta + ev.delta } }
      } else {
        pendingDelta = rec
      }
      if (!deltaTimer) deltaTimer = setTimeout(flushDelta, 60)
      return
    }
    applyNow(rec)
  }

  /**
   * G1 优雅中断：走内核原生 `abort` RPC——只中止当前轮，子进程与上下文
   * （会话树、journal）全部保留；`pi_stop` 杀进程降级为兜底路径。
   * 本地立即收 streaming 相位，不等内核回声（abort 后事件流可能不再发声）。
   */
  async function abortTurn() {
    if (!IN_TAURI) return
    // 先落态再发 RPC：abort 的往返窗口里看门狗不能抢跑成「超时」。
    // 取消与超时必须是两种结果，同一次里不允许两条都记。
    streaming.value = false
    stopWatchdog()
    for (const m of messages.value) if (m.streaming) m.streaming = false
    try {
      await rpc('abort')
    } finally {
      streaming.value = false
      // dsh 中断时给 running 的 root 合成落定：abort 后内核不再发 message_end，
      // 流式消息会永远停在 streaming=true——UI 挂着流式光标、不出收据和操作行。
      for (const m of messages.value) if (m.streaming) m.streaming = false
    }
  }

  /** 显式停止内核前调用：抑制伴生的 process_exit 系统消息（用户主动停的不该再报警）。 */
  function suppressExitNotice() {
    lastKernelStoppedAt = Date.now()
  }

  /**
   * G6：流式中入队（内核 follow_up）——本轮完全结束（无工具调用、无 steer
   * 消息）后自动执行为新 prompt。附件走 buildPrompt 路径引用块，与 send 一致。
   */
  async function followUp(text: string, attachments?: PiAttachment[], quotes?: PiQuote[]) {
    await sendQueued('follow_up', text, attachments, quotes)
  }

  /**
   * G6：插话（内核 steer）——本轮工具调用跑完后、下次 LLM 调用前注入，
   * 用来把跑偏的 agent 拽回当前输入（对齐 Cursor 的 mid-turn 引导）。
   */
  async function steerTurn(text: string, attachments?: PiAttachment[], quotes?: PiQuote[]) {
    await sendQueued('steer', text, attachments, quotes)
  }

  /**
   * G6：清空双队列。内核返回被清出的文本（steering/followUp），
   * 调用方可选择恢复回编辑器——清空不该让用户白打一遍字。
   */
  async function clearQueue(): Promise<QueueState> {
    return await rpc<QueueState>('clear_queue')
  }

  /**
   * #69 M7：队列变更（重排/编辑/删除）的统一编排。内核没有重排命令，
   * 但 `clear_queue` 返回全部排队文本——清空 → 在快照上做变更 → 按新序
   * 逐条重发，权威仍在内核（queue_update 回推逐条收敛 UI，零副账）。
   *
   * 快照漂移（clear 与重发之间内核消费了一条）：变更在旧快照上可能越界——
   * 越界回退为「原序回发」，白忙一场但零损失。重发中途失败：尽力按原快照
   * 回发后抛出，调用方落「队列操作失败，请稍后重试」进消息流。
   *
   * 重发用**下发全文**走 sendQueued：body 已带 buildPrompt 的标记块，
   * 无附件/引用时 buildPrompt(body) === body 原样——二次包装会把块越裹越多。
   */
  async function applyQueueOp(mutation: QueueMutation): Promise<void> {
    const cleared = await rpc<QueueState>('clear_queue')
    const snap: QueueState = { steering: cleared?.steering ?? [], followUp: cleared?.followUp ?? [] }
    const next = mutateQueueSnapshot(snap, mutation) ?? snap
    try {
      for (const e of queueEntries(next)) {
        await sendQueued(e.seg === 'steer' ? 'steer' : 'follow_up', e.body)
      }
    } catch (e) {
      // 尽力补救：原序回发，每条失败不阻断下一条——能回来多少是多少。
      for (const s of queueEntries(snap)) {
        await sendQueued(s.seg === 'steer' ? 'steer' : 'follow_up', s.body).catch(() => {})
      }
      throw e
    }
  }

  // AUDIT-002：`pi://event` 监听必须随组件作用域销毁退订，否则路由切换/重建后
  // 旧 handler 继续消费事件，表现为重复消息与状态错乱。
  // 只在组件/作用域内注册清理；裸调用（如单测）不注册，避免 Vue 告警。
  // ensure() 的 `if (un || ...) return` 已保证不会重复注册。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      un?.()
      un = null
      stopStreamWatch()
      stopWatchdog()
    })
  }

  return {
    messages,
    streaming,
    tree,
    nodes,
    usage,
    ensure,
    start,
    stop,
    restart,
    send,
    noteUser,
    pushUser,
    pushSystem,
    rpc,
    refreshTree,
    forkFrom,
    beginTurn,
    rewindTurn,
    previewTurn,
    abortTurn,
    suppressExitNotice,
    timeoutTick,
    planPending,
    suggestions,
    queue,
    followUp,
    steerTurn,
    clearQueue,
    applyQueueOp,
  }
}
