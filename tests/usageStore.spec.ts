import { beforeEach, describe, expect, it } from 'vitest'
import { __resetUsageStore, pushUsageEvent, useUsageStore } from '@/composables/useUsageStore'

/**
 * 实时用量卡的数据口径。
 *
 * 这里只测纯累加逻辑 —— 组件只是把 `session` / `run` 画出来，
 * 真正会出错的是「内核重启后数字应不应该归零」这类口径问题。
 */
function usageEvent(partial: {
  input: number
  output: number
  totalTokens: number
  cost?: number
  cacheRead?: number
  cacheWrite?: number
}) {
  return {
    type: 'message_update',
    usage: {
      input: partial.input,
      output: partial.output,
      cacheRead: partial.cacheRead ?? 0,
      cacheWrite: partial.cacheWrite ?? 0,
      totalTokens: partial.totalTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: partial.cost ?? 0 },
    },
  }
}

describe('useUsageStore', () => {
  beforeEach(() => __resetUsageStore())

  it('没有事件时不编造数字：hasData 为 false，session/run 全为 0', () => {
    const store = useUsageStore()
    expect(store.hasData.value).toBe(false)
    expect(store.session.value.totalTokens).toBe(0)
    expect(store.run.value.totalTokens).toBe(0)
    expect(store.updatedAt.value).toBe(0)
  })

  it('镜像内核上报的会话累计值（不是把每次增量相加）', () => {
    const store = useUsageStore()
    pushUsageEvent(usageEvent({ input: 100, output: 20, totalTokens: 120, cost: 0.01 }))
    pushUsageEvent(usageEvent({ input: 300, output: 50, totalTokens: 350, cost: 0.03 }))

    expect(store.hasData.value).toBe(true)
    expect(store.session.value.totalTokens).toBe(350)
    expect(store.session.value.output).toBe(50)
    expect(store.session.value.cost).toBeCloseTo(0.03)
    expect(store.run.value.totalTokens).toBe(350)
  })

  it('缓存读写计入「提示词」口径', () => {
    const store = useUsageStore()
    pushUsageEvent(
      usageEvent({ input: 100, output: 20, totalTokens: 200, cacheRead: 60, cacheWrite: 20 }),
    )
    expect(store.session.value.input).toBe(180)
  })

  it('内核重启（累计值回退）时结转而不是丢数', () => {
    const store = useUsageStore()
    pushUsageEvent(usageEvent({ input: 100, output: 20, totalTokens: 120, cost: 0.01 }))
    // 重启：累计从 120 回到 30
    pushUsageEvent(usageEvent({ input: 25, output: 5, totalTokens: 30, cost: 0.005 }))

    expect(store.session.value.totalTokens).toBe(30)
    expect(store.run.value.totalTokens).toBe(150)
    expect(store.run.value.cost).toBeCloseTo(0.015)
  })

  it('统计工具调用与轮次', () => {
    const store = useUsageStore()
    // 桥侧合成的工具事件（真实形状见 piEventKind.spec.ts）
    pushUsageEvent({ type: 'tool_call', toolName: 'read_file', toolArgs: { path: 'a.ts' } })
    pushUsageEvent({ type: 'turn_start' })
    pushUsageEvent({ type: 'agent_settled' })

    expect(store.calls.value).toBe(1)
    expect(store.turns.value).toBe(1)
  })

  it('形状非法的 usage 被忽略，不污染已有数据', () => {
    const store = useUsageStore()
    pushUsageEvent(usageEvent({ input: 10, output: 2, totalTokens: 12 }))
    pushUsageEvent({ type: 'message_update', usage: { input: 'x' } })
    pushUsageEvent(null)

    expect(store.session.value.totalTokens).toBe(12)
  })
})
