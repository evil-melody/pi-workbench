import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { computed, readonly, ref } from 'vue'
import { extractUsage, type PiUsage } from './piEvents'
import { classifyEvent } from '@/utils/piEventKind'
import { IN_TAURI } from './usePi'

/**
 * 全局实时用量单一真源。
 *
 * 侧栏（`Sidebar`）与会话页不在同一棵组件树里 —— 侧栏是布局级、会话页是路由级，
 * `provide/inject` 覆盖不到。因此这里做成**模块级单例**：进程内只建一条
 * `pi://event` 监听，任何组件 `useUsageStore()` 拿到的都是同一份实时状态，
 * 不会出现「侧栏数字和页头数字不一致」或重复消费事件。
 *
 * 两个口径分开记，因为它们含义不同：
 * - `live`：内核进程内的**会话累计**（内核每条流式事件都带最新累计，重启归零）。
 * - `run`：本应用运行期的**跨内核累计**。内核重启（改模型 / 换目录）会让 `live`
 *   归零，检测到回退就把上一段累计结转到 `run`，避免数字凭空消失。
 */
export interface UsageTotals {
  input: number
  output: number
  totalTokens: number
  cost: number
}

function zero(): UsageTotals {
  return { input: 0, output: 0, totalTokens: 0, cost: 0 }
}

function toTotals(u: PiUsage): UsageTotals {
  return {
    input: u.input + u.cacheRead + u.cacheWrite,
    output: u.output,
    totalTokens: u.totalTokens,
    cost: u.cost.total,
  }
}

/** 内核进程内累计（最近一次上报值）。 */
const live = ref<PiUsage | null>(null)
/** 内核重启前已经结算掉的部分，结转计入 run。 */
const carried = ref<UsageTotals>(zero())
/** 本轮应用运行时的工具调用 / 轮次计数（来自同一个事件流）。 */
const calls = ref(0)
const turns = ref(0)
/** 最近一次收到用量事件的时间戳（毫秒）；为 0 表示还没开始对话。 */
const updatedAt = ref(0)

let unlisten: UnlistenFn | null = null
let starting: Promise<void> | null = null

/**
 * 消费一条 `pi://event` 原始记录。
 *
 * 导出是为了可测：单测里直接喂事件，不需要 Tauri 通道，
 * 也与 `piEvents.applyEvent` 的纯函数风格保持一致。
 */
export function pushUsageEvent(rec: unknown): void {
  const row = classifyEvent(rec)
  if (row) {
    if (row.kind === 'tool_call') calls.value++
    else if (row.kind === 'turn_start') turns.value++
  }
  const next = extractUsage((rec as { usage?: unknown } | null)?.usage)
  if (!next) return

  // 内核重启会让累计值回退：把上一段结转进 carried，再重新起算。
  const prev = live.value
  if (prev && next.totalTokens < prev.totalTokens) {
    const prevTotals = toTotals(prev)
    const c = carried.value
    carried.value = {
      input: c.input + prevTotals.input,
      output: c.output + prevTotals.output,
      totalTokens: c.totalTokens + prevTotals.totalTokens,
      cost: c.cost + prevTotals.cost,
    }
  }
  live.value = next
  updatedAt.value = Date.now()
}

/** 幂等：无论多少组件调用，进程内只建一条订阅。 */
function ensure(): Promise<void> {
  if (unlisten || !IN_TAURI) return Promise.resolve()
  if (!starting) {
    starting = listen<unknown>('pi://event', (e) => pushUsageEvent(e.payload))
      .then((un) => {
        unlisten = un
      })
      .catch(() => {
        // 浏览器预览下没有 Tauri 通道：降级为「无用量」，由 UI 说明原因。
        unlisten = null
      })
      .finally(() => {
        starting = null
      })
  }
  return starting
}

/** 本会话（内核进程内）累计。 */
const session = computed<UsageTotals>(() => (live.value ? toTotals(live.value) : zero()))

/** 本次运行（含内核重启前）累计。 */
const run = computed<UsageTotals>(() => {
  const c = carried.value
  const s = session.value
  return {
    input: c.input + s.input,
    output: c.output + s.output,
    totalTokens: c.totalTokens + s.totalTokens,
    cost: c.cost + s.cost,
  }
})

/** 是否已有真实数据：没有数据时 UI 必须显示「等待中」，不得编造数字。 */
const hasData = computed(() => live.value !== null)

export function useUsageStore() {
  return {
    session,
    run,
    calls: readonly(calls),
    turns: readonly(turns),
    updatedAt: readonly(updatedAt),
    hasData,
    ensure,
  }
}

/** 仅测试用：重置单例状态，避免用例间互相污染。 */
export function __resetUsageStore(): void {
  live.value = null
  carried.value = zero()
  calls.value = 0
  turns.value = 0
  updatedAt.value = 0
}
