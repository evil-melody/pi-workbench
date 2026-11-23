import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  emptyUsageState,
  readSuggestions,
  type EventCtx,
} from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'

function ctx(): EventCtx {
  let n = 0
  return { messages: [] as PiMsg[], streaming: true, nextId: () => `m${n++}`, usage: emptyUsageState() }
}
const entry = (customType: string, suggestions: unknown) => ({
  type: 'entry_appended',
  entry: { type: 'custom', customType, data: { suggestions } },
})

describe('M5 推荐源事件折算', () => {
  it('readSuggestions 只认 pi_suggest custom entry', () => {
    expect(readSuggestions(entry('pi_suggest', ['甲', '乙']))).toEqual(['甲', '乙'])
    expect(readSuggestions(entry('other', ['甲']))).toBe(null)
    expect(readSuggestions({ type: 'entry_appended', entry: { type: 'message' } })).toBe(null)
    expect(readSuggestions({ type: 'entry_appended' })).toBe(null)
  })

  it('过滤非字符串与空白，全无效返回 null', () => {
    expect(readSuggestions(entry('pi_suggest', ['甲', '', 3, '  ', '乙']))).toEqual(['甲', '乙'])
    expect(readSuggestions(entry('pi_suggest', [1, null]))).toBe(null)
  })

  it('applyEvent 把推荐写进 ctx.suggestions，不落消息', () => {
    const c = ctx()
    applyEvent(c, entry('pi_suggest', ['甲', '乙', '丙']))
    expect(c.suggestions).toEqual(['甲', '乙', '丙'])
    expect(c.messages).toEqual([])
  })

  it('新推荐整体覆盖旧推荐', () => {
    const c = ctx()
    applyEvent(c, entry('pi_suggest', ['旧']))
    applyEvent(c, entry('pi_suggest', ['新']))
    expect(c.suggestions).toEqual(['新'])
  })

  it('非推荐 entry_appended 不动 suggestions', () => {
    const c = ctx()
    applyEvent(c, entry('pi_suggest', ['保留']))
    applyEvent(c, entry('other', ['噪声']))
    expect(c.suggestions).toEqual(['保留'])
  })
})
