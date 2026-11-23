import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 发送路径的状态语义（不挂载组件，只驱动 usePi 的事件入口）：
 * 1. 下发被内核拒绝时 streaming 必须复位，否则发送按钮永久变「停止」。
 * 2. 本轮未结束时内核被重启（切模型 / 改工具白名单），必须落系统消息并收尾。
 * 3. 空闲时重启不打扰用户。
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

// usePi 在模块加载时读 window.__TAURI_INTERNALS__ 判断是否桌面端。
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

function lastMsg(pi: { messages: { value: Array<{ role: string; text?: string }> } }) {
  return pi.messages.value[pi.messages.value.length - 1]
}

describe('发送路径状态', () => {
  beforeEach(() => {
    handlers.length = 0
    invokeMock.mockReset()
  })

  it('内核未启动：send 抛错且 streaming 复位，不残留流式态', async () => {
    invokeMock.mockRejectedValueOnce(new Error('pi 未启动'))
    const pi = await mount()
    await expect(pi.send('hi')).rejects.toThrow('pi 未启动')
    expect(pi.streaming.value).toBe(false)
    expect(pi.messages.value).toHaveLength(0)
  })

  it('本轮在飞时内核重启：落系统消息并结束流式态', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    const pi = await mount()
    await pi.send('hi')
    expect(pi.streaming.value).toBe(true)

    lastHandler()({ payload: { type: 'kernel_restarted', at: Date.now() } })

    expect(pi.streaming.value).toBe(false)
    expect(lastMsg(pi)?.role).toBe('system')
  })

  it('空闲时内核重启：不插系统消息', async () => {
    const pi = await mount()
    lastHandler()({ payload: { type: 'kernel_restarted', at: Date.now() } })
    expect(pi.messages.value).toHaveLength(0)
  })

  it('内核回执 success=false：落系统消息并结束流式态', async () => {
    invokeMock.mockResolvedValueOnce(undefined)
    const pi = await mount()
    await pi.send('hi')
    lastHandler()({
      payload: { type: 'response', success: false, error: 'no api key' },
    })
    expect(pi.streaming.value).toBe(false)
    expect(String(lastMsg(pi)?.text)).toContain('no api key')
  })
})

/**
 * 回合空闲超时：provider 挂起时 streaming 不能永久为真。
 * 判据是「距上次事件多久」，所以长任务只要持续吐事件就不该被打断。
 */
describe('回合空闲超时', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    handlers.length = 0
    invokeMock.mockReset()
    invokeMock.mockResolvedValue(undefined)
  })

  async function mountedStreaming() {
    const pi = await mount()
    await pi.send('hi')
    await nextTick() // 让 streaming 的 watcher 跑一次，看门狗起来
    return pi
  }

  function emit(payload: unknown) {
    lastHandler()({ payload })
  }

  it('阈值：普通 180s，工具执行中 600s', async () => {
    const { idleTimeoutMs } = await import('@/composables/usePi')
    expect(idleTimeoutMs(false)).toBe(180_000)
    expect(idleTimeoutMs(true)).toBe(600_000)
  })

  it('静默超过 180s：收口成超时，不是成功也不是取消', async () => {
    const pi = await mountedStreaming()
    await vi.advanceTimersByTimeAsync(181_000)

    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(1)
    const msg = lastMsg(pi)
    expect(msg?.role).toBe('system')
    expect(String(msg?.text)).toContain('超时')
    expect(String(msg?.text)).not.toContain('已中断')
  })

  it('持续有事件：跑了 5 分钟也不打断（判据是间隔不是总时长）', async () => {
    const pi = await mountedStreaming()
    for (let i = 0; i < 5; i++) {
      emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'x' } })
      await vi.advanceTimersByTimeAsync(60_000)
    }
    expect(pi.streaming.value).toBe(true)
    expect(pi.timeoutTick.value).toBe(0)
  })

  it('工具执行中放宽到 600s，超时才收口', async () => {
    const pi = await mountedStreaming()
    emit({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'bash' })
    await vi.advanceTimersByTimeAsync(300_000)
    expect(pi.streaming.value).toBe(true)
    await vi.advanceTimersByTimeAsync(310_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(1)
  })

  it('用户主动取消不留超时痕迹（两条路径可区分）', async () => {
    const pi = await mountedStreaming()
    await pi.abortTurn()
    await vi.advanceTimersByTimeAsync(400_000)
    expect(pi.streaming.value).toBe(false)
    expect(pi.timeoutTick.value).toBe(0)
    expect(pi.messages.value.some((m) => String(m.text).includes('超时'))).toBe(false)
  })
})
