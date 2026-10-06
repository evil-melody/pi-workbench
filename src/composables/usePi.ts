import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { ref } from 'vue'
import { flattenTree, type FlatNode, type PiTreeNode } from '@/composables/useSessionTree'
import { applyEvent, emptyUsageState, type PiUsage, type UsageState } from '@/composables/piEvents'

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
  let un: UnlistenFn | null = null
  let seq = 0

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
   */
  function rpc<T = any>(type: string, payload: Record<string, unknown> = {}): Promise<T> {
    if (!IN_TAURI) return Promise.reject(new Error(NO_KERNEL))
    return invoke<T>('pi_call', { json: JSON.stringify({ ...payload, type }) })
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
    applyEvent(
      {
        messages: messages.value,
        streaming: streaming.value,
        nextId: () => `a${seq++}`,
        usage: usage.value,
      },
      rec,
    )
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

  function flushDelta() {
    deltaTimer = null
    const rec = pendingDelta
    pendingDelta = null
    if (rec) applyNow(rec)
  }

  function handle(rec: any) {
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
      applyNow(rec)
      return
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
  }
}
