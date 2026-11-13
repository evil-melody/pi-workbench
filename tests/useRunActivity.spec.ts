import { describe, expect, it, vi } from 'vitest'

/**
 * 侧栏「运行中」转圈的数据源：只认 `pi://event` 的事件类型。
 * 这里把 Tauri 的 listen 换成桩，验证「亮起 → 延迟熄灭 → 不被噪声续命」。
 */
const state = vi.hoisted(() => ({ handler: null as null | ((e: { payload: unknown }) => void) }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (_name: string, cb: (e: { payload: unknown }) => void) => {
    state.handler = cb
    return () => {
      state.handler = null
    }
  }),
}))

/** 每个用例都拿一份全新的模块实例（单例 ref 不能被上一个用例污染）。 */
async function load() {
  vi.resetModules()
  vi.stubGlobal('window', { __TAURI_INTERNALS__: {} })
  const { useRunActivity } = await import('@/composables/useRunActivity')
  const api = useRunActivity()
  await new Promise((r) => setTimeout(r, 0))
  expect(state.handler).toBeTypeOf('function')
  return api
}

const emit = (type: string) => state.handler!({ payload: { type } })

describe('useRunActivity · 侧栏运行中转圈', () => {
  it('活跃事件点亮，agent_settled 后延迟 1.2s 熄灭', async () => {
    const { running } = await load()
    vi.useFakeTimers()
    try {
      expect(running.value).toBe(false)
      emit('run_start')
      expect(running.value).toBe(true)
      emit('agent_settled')
      // 延迟窗口内仍算运行中（follow_up 会接着跑下一轮，不能闪断）
      await vi.advanceTimersByTimeAsync(1000)
      expect(running.value).toBe(true)
      await vi.advanceTimersByTimeAsync(400)
      expect(running.value).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('收尾窗口内来了下一轮，转圈不中断也不提前熄灭', async () => {
    const { running } = await load()
    vi.useFakeTimers()
    try {
      emit('run_start')
      emit('agent_settled')
      await vi.advanceTimersByTimeAsync(600)
      emit('turn_start')
      await vi.advanceTimersByTimeAsync(1200)
      expect(running.value).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('无关事件不给收尾续命（settle 之后不会被 stats 噪声拖住）', async () => {
    const { running } = await load()
    vi.useFakeTimers()
    try {
      emit('run_start')
      emit('agent_settled')
      await vi.advanceTimersByTimeAsync(600)
      emit('stats')
      await vi.advanceTimersByTimeAsync(700)
      expect(running.value).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
