import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentScope, onScopeDispose, ref } from 'vue'
import { flattenTree, type FlatNode, type PiTreeNode } from '@/composables/useSessionTree'
import { applyEvent, emptyUsageState, type EventCtx, type PiUsage, type QueueState, type UsageState, emptyQueueState, readQueueUpdate } from '@/composables/piEvents'
import type { PiFileChange } from '@/utils/fileChanges'
import { stripPlanInstruction } from '@/utils/planMode'

/**
 * 浏览器模式（`npm run app:dev:web`）下没有 Tauri IPC，内核通道不可用。
 * 此时显式拒答，而不是抛底层错误导致 UI 卡在 loading。
 */
export const IN_TAURI =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window

const NO_KERNEL =
  '当前是浏览器模式，Pi 内核未接入。请用 npm run app:dev 启动桌面 App 后再对话。'

export interface PiMsg {
  id: string
  role: 'user' | 'assistant' | 'system'
  text: string
  tool?: string
  streaming?: boolean
  /** 该条 assistant 消息的真实 token 用量（provider 上报，message_end 时挂载）。 */
  usage?: PiUsage
  /** 用户消息附带的图片/文件（已落盘到 app_config_dir/attachments）。 */
  attachments?: PiAttachment[]
  /** G2：本条 assistant 消息涉及的文件改动（edit/write 工具调用，按调用顺序）。 */
  fileChanges?: PiFileChange[]
  /** G3：本条 user 消息对应的 checkpoint turn seq（>0 才可「回到此处」）。 */
  turnSeq?: number
  /** G5：本条 assistant 消息是计划模式产出——分步计划卡，等用户确认后执行。 */
  plan?: PiPlan
}

/** G5：计划卡状态。pending=待确认；executing=已批准、执行 prompt 已下发。 */
export interface PiPlan {
  steps: string[]
  /** 触发该计划的用户原始任务（执行 prompt 要带回它，防执行时丢目标）。 */
  task: string
  state: 'pending' | 'executing'
}

/** G3：rewind 结果（Rust checkpoint_rewind 原样回传）。 */
export interface RewindReport {
  seq: number
  restored: string[]
  failed: string[]
  fork_entry_id: string | null
}

/** 一条附件的引用：id/name 供 UI，path 供 Pi 按路径读取（内核当前只接受字符串 prompt）。 */
export interface PiAttachment {
  id: string
  name: string
  kind: 'image' | 'file'
  /** 绝对路径（已由后端 attachment_add 落盘）。 */
  path: string
}

/**
 * 构造发给 Pi 的 prompt 文本。
 *
 * Pi RPC 的 `prompt.message` 当前只接受字符串（实证：传 content 数组报
 * `text.startsWith is not a function`），所以多模态附件以「路径引用块」追加进文本，
 * Pi 用其文件工具按路径读取。保持 message 为字符串是硬约束，不可改成形如
 * `[{type:image_url}]` 的对象——那是内核侧的能力，工作端只能绕行。纯函数，可单测。
 */
export function buildPrompt(text: string, attachments?: PiAttachment[]): string {
  if (!attachments || attachments.length === 0) return text
  const lines = attachments.map((a) =>
    a.kind === 'image' ? `- image: ${a.path}` : `- file: ${a.path}`,
  )
  return `${text}\n\n[附件 / attachments]\n${lines.join('\n')}`
}

/** buildPrompt 的逆运算：从下发给内核的正文还原「用户原文 + 附件」。
 *  dispatchToPi 会加 `preamble\n\n---\n\n` 前缀、buildPrompt 会追加附件块，
 *  journal 回放时必须都剥掉，气泡里才显示用户原话而不是大段项目上下文。 */
export function splitPromptBody(body: string): { text: string; attachments: PiAttachment[] } {
  const SEP = '\n\n---\n\n'
  const ATT = '\n\n[附件 / attachments]\n'
  const sepAt = body.indexOf(SEP)
  let rest = sepAt >= 0 ? body.slice(sepAt + SEP.length) : body
  // G5：plan 指令前缀拼在最外，无 preamble（无 SEP）时会残留在 rest 头部，剥掉。
  rest = stripPlanInstruction(rest)
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
  return { text: rest, attachments }
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
   * G6：消息队列（steer 插话 + follow_up 排队）。以内核 queue_update 事件为
   * 权威数据源——入队/消费内核都会回推，前端不维护副账。
   */
  const queue = ref<QueueState>(emptyQueueState())
  let un: UnlistenFn | null = null
  let seq = 0
  /** 最近一次内核主动停止/重启时刻（ms）：抑制伴生的 process_exit 系统消息。 */
  let lastKernelStoppedAt = 0

  async function ensure() {
    if (un || !IN_TAURI) return
    un = await listen<any>('pi://event', (e) => handle(e.payload))
  }

  function start(cwd?: string) {
    if (!IN_TAURI) return Promise.reject(new Error(NO_KERNEL))
    return invoke('pi_start', { cwd: cwd ?? null })
  }

  function stop() {
    if (!IN_TAURI) return Promise.resolve()
    return invoke('pi_stop')
  }

  /** 原地重启内核：改模型 / 改工具白名单后调用，新配置在新进程里生效。 */
  function restart() {
    if (!IN_TAURI) return Promise.reject(new Error(NO_KERNEL))
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
    if (!IN_TAURI) return Promise.reject(new Error(NO_KERNEL))
    return invoke<T>('pi_call', {
      json: JSON.stringify({ ...payload, type }),
      ...(timeoutMs ? { timeoutMs } : {}),
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
        promptHead: promptHead.slice(0, 80),
      })
    } catch {
      return 0
    }
  }

  /**
   * G3：回到某轮之前——还原该轮 edit/write 改过的文件 + fork 会话树。
   * bash 产生的变更不在快照范围（对齐 Claude Code checkpoint 限制）。
   */
  async function rewindTurn(seq: number): Promise<RewindReport> {
    const rep = await invoke<RewindReport>('checkpoint_rewind', { seq })
    await refreshTree().catch(() => {})
    return rep
  }

  function pushUser(text: string, attachments?: PiAttachment[]) {
    messages.value.push({
      id: `u${seq++}`,
      role: 'user',
      text,
      ...(attachments?.length ? { attachments } : {}),
    })
  }

  /** 系统级提示（内核不可用 / 下发失败等）：必须进消息流，用户才看得见发生了什么。 */
  function pushSystem(text: string) {
    messages.value.push({ id: `s${seq++}`, role: 'system', text })
  }

  function send(text: string, attachments?: PiAttachment[]) {
    if (!IN_TAURI) return Promise.reject(new Error(NO_KERNEL))
    // message 必须是字符串（Pi 协议约束）；附件以路径引用块追加进文本。
    const cmd = {
      id: `c${Date.now()}`,
      type: 'prompt',
      message: buildPrompt(text, attachments),
    }
    streaming.value = true
    return invoke('pi_send', { json: JSON.stringify(cmd) }).catch((e) => {
      streaming.value = false
      throw e
    })
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
      }
    }
    applyEvent(eventCtx, rec)
    // 结束信号属于本 composable 的状态，不在 applyEvent 里动。
    if (rec?.type === 'agent_settled' || rec?.type === 'process_exit') streaming.value = false
    // 兜底：会话中途接管（如换会话/重连）时，用内核事件把 running 态拉回 true。
    else if (rec?.type === 'message_update' || rec?.type === 'message_start') streaming.value = true
  }

  /**
   * 流式合并：一条待应用的 `message_update`，配合下面的定时器按帧落盘。
   * 每条事件都带**累计全文**，所以后到的直接覆盖先到的，不需要排队。
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

  function handle(rec: any) {
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
      pushSystem(`内核返回失败：${rec.error ?? '未知错误'}`)
      streaming.value = false
      return
    }
    // 结束类事件低频且带状态语义：立即应用，不节流。
    if (rec?.type === 'agent_settled' || rec?.type === 'process_exit') {
      // 内核自灭必须让用户看见：否则消息停在「已发送」，表现为「点了没反应」。
      // 主动重启（pi_restart）会先发 kernel_restarted，5 秒内的 process_exit 视为重启伴生，不打扰。
      if (rec?.type === 'process_exit') {
        const sinceStop = Date.now() - lastKernelStoppedAt
        if (sinceStop > 5_000) {
          pushSystem('Pi 内核进程已退出，本条消息可能没有送达。请重开会话页或重启 App 重新拉起内核。')
        }
      }
      applyNow(rec)
      return
    }
    if (rec?.type === 'kernel_restarted') {
      lastKernelStoppedAt = Date.now()
    }
    // `message_update` 在长回复里是逐字级的：每条都触发整列消息重渲染，
    // 主线程会饱和到「整窗卡死 + IMK run loop 报错」。合并成 ~60ms 一帧，
    // 渲染成本从「每条事件一次」降到「每秒十几次」，观感仍是流式。
    if (rec?.type === 'message_update') {
      streaming.value = true
      pendingDelta = rec
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
    try {
      await rpc('abort')
    } finally {
      streaming.value = false
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
  async function followUp(text: string, attachments?: PiAttachment[]) {
    await rpc('follow_up', { message: buildPrompt(text, attachments) })
  }

  /**
   * G6：插话（内核 steer）——本轮工具调用跑完后、下次 LLM 调用前注入，
   * 用来把跑偏的 agent 拽回当前输入（对齐 Cursor 的 mid-turn 引导）。
   */
  async function steerTurn(text: string, attachments?: PiAttachment[]) {
    await rpc('steer', { message: buildPrompt(text, attachments) })
  }

  /**
   * G6：清空双队列。内核返回被清出的文本（steering/followUp），
   * 调用方可选择恢复回编辑器——清空不该让用户白打一遍字。
   */
  async function clearQueue(): Promise<QueueState> {
    return await rpc<QueueState>('clear_queue')
  }

  // AUDIT-002：`pi://event` 监听必须随组件作用域销毁退订，否则路由切换/重建后
  // 旧 handler 继续消费事件，表现为重复消息与状态错乱。
  // 只在组件/作用域内注册清理；裸调用（如单测）不注册，避免 Vue 告警。
  // ensure() 的 `if (un || ...) return` 已保证不会重复注册。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      un?.()
      un = null
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
    pushUser,
    pushSystem,
    rpc,
    refreshTree,
    forkFrom,
    beginTurn,
    rewindTurn,
    abortTurn,
    suppressExitNotice,
    planPending,
    queue,
    followUp,
    steerTurn,
    clearQueue,
  }
}
