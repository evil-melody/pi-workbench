import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 超时边界（可控时钟）：验证阈值两侧、计时重置、工具期回落、与取消的竞争、
 * 重复叠加、内核恰好退出、排队中触发。
 *
 * 全部用 vi.useFakeTimers 把 Date 与 setInterval 一起接管，断言可以精确到毫秒；
 * 真时钟版本见 .tmp/verify/ui-edges.mjs。
 */
type Handler = (e: { payload: unknown }) => void

const handlers: Handler[] = []
const invokeMock = vi.fn()

vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: Handler) => {
    handlers.push(cb)
    return () => {}
  }),
}))

;(globalThis as unknown as { window: unknown }).window = { __TAURI_INTERNALS__: {} }

async function mount() {
  const { usePi } = await import('@/composables/usePi')
  const pi = usePi()
  await pi.ensure()
  return pi
}

function lastHandler(): Handler {
  const h = handlers[handlers.length - 1]
  if (!h) throw new Error('未订阅到 pi://event')
  return h
}

function emit(payload: unknown) {
  lastHandler()({ payload })
}

const texts = (pi: { messages: { value: Array<{ text?: string }> } }) =>
  pi.messages.value.map((m) => String(m.text ?? ''))

describe('超时边界（可控时钟）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    handlers.length = 0
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  async function started() {
    const pi = await mount()
    await pi.send('hi')
    await nextTick()
    return pi
  }

  it('普通期：179s 不触发，180s 触发', async () => {
    const pi = await started()
    await vi.advanceTimersByTimeAsync(179_000)
    expect(pi.streaming.value).toBe(true)
    expect(pi.timeoutTick.value).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(1)
  })

  it('工具期：599s 不触发，601s 触发', async () => {
    const pi = await started()
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(599_000)
    expect(pi.streaming.value).toBe(true)
    expect(pi.timeoutTick.value).toBe(0)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(1)
  })

  it('边缘心跳：179s 来一条事件，计时重置而不是误判', async () => {
    const pi = await started()
    await vi.advanceTimersByTimeAsync(179_000)
    emit({ type: 'turn_start' })
    // 不重置的话，180s 的巡检点就该收口
    await vi.advanceTimersByTimeAsync(2_000)
    expect(pi.streaming.value).toBe(true)
    expect(pi.timeoutTick.value).toBe(0)
    // 从心跳再数满 180s 才收口（此刻距心跳 178s）
    await vi.advanceTimersByTimeAsync(176_000)
    expect(pi.streaming.value).toBe(true)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(pi.timeoutTick.value).toBe(1)
  })

  it('工具结束：阈值当场从 600s 回落到 180s', async () => {
    const pi = await started()
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(100_000)
    emit({ type: 'tool_execution_end', toolCallId: 't1', toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(178_000)
    expect(pi.streaming.value).toBe(true) // 工具期阈值下还远远没到
    await vi.advanceTimersByTimeAsync(7_000)
    expect(pi.timeoutTick.value).toBe(1) // 回落成 180s 后立刻收口
  })

  it('竞争：取消落在判定同一时刻，只归到取消', async () => {
    const pi = await started()
    await vi.advanceTimersByTimeAsync(179_999)
    await pi.abortTurn()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(0)
    expect(texts(pi).some((t) => t.includes('超时'))).toBe(false)
  })

  it('重复取消幂等；超时后再发又取消只记一条超时', async () => {
    const pi = await started()
    await pi.abortTurn()
    await pi.abortTurn()
    await vi.advanceTimersByTimeAsync(200_000)
    expect(pi.timeoutTick.value).toBe(0)

    await pi.send('again')
    await nextTick()
    await vi.advanceTimersByTimeAsync(181_000)
    expect(pi.timeoutTick.value).toBe(1)
    await pi.send('after-timeout')
    await nextTick()
    await vi.advanceTimersByTimeAsync(1_000)
    await pi.abortTurn()
    await vi.advanceTimersByTimeAsync(200_000)
    expect(pi.timeoutTick.value).toBe(1)
  })

  it('内核在判定时刻退出 / 重启：不补第二条超时', async () => {
    const pi = await started()
    await vi.advanceTimersByTimeAsync(179_500)
    emit({ type: 'process_exit', code: 1 })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(0)
    expect(texts(pi).some((t) => t.includes('等待模型响应超时'))).toBe(false)
  })

  it('排队中触发超时：队列不被前端私改，下一轮可正常开始', async () => {
    const pi = await started()
    emit({ type: 'queue_update', steering: [], followUp: ['queued task'] })
    await vi.advanceTimersByTimeAsync(181_000)
    expect(pi.timeoutTick.value).toBe(1)
    expect(pi.queue.value.followUp).toEqual(['queued task']) // 队列以内核回推为准
    emit({ type: 'queue_update', steering: [], followUp: [] })
    expect(pi.queue.value.followUp).toEqual([])
    await pi.send('next turn')
    await nextTick()
    expect(pi.streaming.value).toBe(true)
  })
})
