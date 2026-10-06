import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { computed, getCurrentScope, inject, onScopeDispose, ref, type InjectionKey } from 'vue'
import { classifyEvent, type PiEventRow } from '@/utils/piEventKind'
import { IN_TAURI } from './usePi'

/**
 * `pi://event` 的面板侧订阅：保留一个定长环形缓冲，并把原始记录折算成视图行。
 *
 * 与 `usePi()` 分开订阅同一个事件：一个管消息列表，一个管轨迹/浏览器面板，
 * 两边互不阻塞；缓冲上限固定，长时间运行不会涨内存。
 */
export function usePiEvents(limit = 300) {
  const events = ref<PiEventRow[]>([])
  let un: UnlistenFn | null = null

  const stats = computed(() => {
    let calls = 0
    let turns = 0
    let exits = 0
    for (const e of events.value) {
      if (e.kind === 'tool_call') calls++
      else if (e.kind === 'turn_start') turns++
      else if (e.kind === 'exit') exits++
    }
    return { total: events.value.length, calls, turns, exits }
  })

  async function ensure() {
    if (un || !IN_TAURI) return
    try {
      un = await listen<unknown>('pi://event', (e) => {
        const row = classifyEvent(e.payload)
        if (!row) return
        const next = events.value
        next.push(row)
        // 超出上限即丢最旧的一条，保持定长。
        if (next.length > limit) next.splice(0, next.length - limit)
      })
    } catch {
      // 浏览器模式下 IPC 不可用，静默降级为空缓冲，由 UI 显示「内核未接入」。
      un = null
    }
  }

  /** 压入一条已归一化的行（超出上限丢最旧）。内核事件与本地留痕共用。 */
  function push(row: PiEventRow) {
    const next = events.value
    next.push(row)
    if (next.length > limit) next.splice(0, next.length - limit)
  }

  /** 内核尚无对应能力时的留痕行：明确标注，不冒充内核事件。 */
  function note(title: string, detail = '') {
    push({ kind: 'other', title, detail, at: Date.now() })
  }

  function reset() {
    events.value = []
  }

  // 只在组件/作用域内注册清理；裸调用（如单测）不注册，避免 Vue 告警。
  if (getCurrentScope()) {
    onScopeDispose(() => {
      un?.()
      un = null
    })
  }

  return { events, stats, ensure, push, note, reset }
}

/** usePiEvents 实例类型：供会话页 provide 给各面板共享同一条缓冲。 */
export type PiEventStream = ReturnType<typeof usePiEvents>

/**
 * 会话页共享的事件流注入键。
 *
 * 面板分散在左右两栏，各自 `usePiEvents()` 会各自建一条监听（同一事件被
 * 消费两次），故在 ChatView 建一个实例注入下去，保证只有一条订阅、一份缓冲。
 */
export const PI_EVENTS: InjectionKey<PiEventStream> = Symbol('pi-events')

/** 取会话级事件流；未提供时返回 null，调用方按空缓冲降级。 */
export function usePiEventsInjected(): PiEventStream | null {
  return inject(PI_EVENTS, null)
}
