import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { withTimeout } from '../src/composables/asyncGuard'

describe('withTimeout · dispatch 链路防挂起护栏', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('promise 正常完成：返回其值，不等到超时', async () => {
    const p = withTimeout(Promise.resolve('ok'), 1000, 'fallback')
    const r = await p
    expect(r).toBe('ok')
  })

  it('promise 永不 settle：超时后落 fallback（主线程被堵场景）', async () => {
    const never = new Promise<string>(() => {})
    const p = withTimeout(never, 3_500, '')
    vi.advanceTimersByTime(3_500)
    expect(await p).toBe('')
  })

  it('promise 拒绝：落 fallback 而非向上抛（调用方已有 .catch 双保险）', async () => {
    const p = withTimeout(Promise.reject(new Error('boom')), 1000, 'safe')
    expect(await p).toBe('safe')
  })

  it('先完成先赢：完成之后超时不再覆盖结果', async () => {
    let release!: (v: string) => void
    const slow = new Promise<string>((r) => (release = r))
    const p = withTimeout(slow, 100, 'late-fallback')
    release('in-time')
    await vi.advanceTimersByTimeAsync(200)
    expect(await p).toBe('in-time')
  })
})
