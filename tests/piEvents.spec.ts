import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  emptyUsageState,
  extractUsage,
  fmtCost,
  fmtTokens,
  type EventCtx,
} from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'

/** 组装一个可反复复用的受理上下文；nextId 保证每次调用都拿到新 id。 */
function ctx(messages: PiMsg[] = []): EventCtx {
  let n = 0
  return { messages, streaming: true, nextId: () => `m${n++}`, usage: emptyUsageState() }
}

/** 一条真实的内核 usage 形状（字段与 @earendil-works/pi-ai 的 Usage 对齐）。 */
function usage(overrides: Record<string, unknown> = {}) {
  return {
    input: 1200,
    output: 340,
    cacheRead: 800,
    cacheWrite: 100,
    totalTokens: 2440,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    ...overrides,
  }
}

function textDelta(delta: string) {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  }
}

describe('applyEvent · text_delta', () => {
  it('连续的 delta 合并进同一条 assistant 消息', () => {
    const c = ctx()
    applyEvent(c, textDelta('你好'))
    applyEvent(c, textDelta('，'))
    applyEvent(c, textDelta('世界'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].text).toBe('你好，世界')
    expect(c.messages[0].streaming).toBe(true)
  })

  it('同一条消息内 id 只分配一次', () => {
    const c = ctx()
    applyEvent(c, textDelta('a'))
    applyEvent(c, textDelta('b'))
    expect(c.messages[0].id).toBeDefined()
  })

  it('上一条已落定时再来 delta，开新消息而不是续写', () => {
    const c = ctx()
    applyEvent(c, textDelta('第一轮'))
    c.messages[0].streaming = false
    applyEvent(c, textDelta('第二轮'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[1].text).toBe('第二轮')
  })

  it('user 消息之后的第一条 delta 属于 assistant', () => {
    const c = ctx([{ id: 'u1', role: 'user', text: '写个 hello' }])
    applyEvent(c, textDelta('好的'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[1].role).toBe('assistant')
  })

  it('缺少 assistantMessageEvent 的记录不改动消息列表', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update' })
    expect(c.messages).toHaveLength(0)
  })
})

describe('applyEvent · 工具事件与收尾', () => {
  it('tool_* 事件插一条带 tool 标记的消息', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'tool_use' } })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].tool).toBe('tool_use')
    expect(c.messages[0].text).toBe('')
  })

  it('agent_settled 把最后一条消息的 streaming 置 false', () => {
    const c = ctx()
    applyEvent(c, textDelta('施工中'))
    expect(c.messages[0].streaming).toBe(true)
    applyEvent(c, { type: 'agent_settled' })
    expect(c.messages[0].streaming).toBe(false)
  })

  it('空消息列表上收到 agent_settled 不报错', () => {
    const c = ctx()
    expect(() => applyEvent(c, { type: 'agent_settled' })).not.toThrow()
    expect(c.messages).toHaveLength(0)
  })
})

describe('applyEvent · 脏数据防御', () => {
  it.each([null, undefined, 42, 'x', [], true])('忽略 %p', (rec) => {
    const c = ctx()
    applyEvent(c, rec)
    expect(c.messages).toHaveLength(0)
  })

  it('delta 不是字符串时按空串处理，不产生 undefined', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } })
    expect(c.messages[0].text).toBe('')
  })
})

describe('applyEvent · token 用量（真实内核数据）', () => {
  it('message_update.usage（会话累计）镜像到 ctx.usage.last', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('hi'), usage: usage() })
    expect(c.usage.last).not.toBeNull()
    expect(c.usage.last?.input).toBe(1200)
    expect(c.usage.last?.totalTokens).toBe(2440)
    expect(c.usage.last?.cost.total).toBeCloseTo(0.0033)
  })

  it('后续累计事件覆盖 last（内核维护累计，前端只镜像）', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('a'), usage: usage() })
    applyEvent(c, { ...textDelta('b'), usage: usage({ input: 2000, totalTokens: 3240 }) })
    expect(c.usage.last?.input).toBe(2000)
    expect(c.usage.last?.totalTokens).toBe(3240)
  })

  it('message_end.message.usage 挂回最后一条 assistant 消息', () => {
    const c = ctx()
    applyEvent(c, textDelta('回答正文'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'assistant', usage: usage({ input: 10, output: 20, totalTokens: 30 }) },
    })
    expect(c.messages[0].usage?.input).toBe(10)
    expect(c.messages[0].usage?.output).toBe(20)
    expect(c.messages[0].usage?.totalTokens).toBe(30)
  })

  it('message_end 的 user 消息不挂 usage', () => {
    const c = ctx()
    applyEvent(c, textDelta('回答正文'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'user', usage: usage() },
    })
    expect(c.messages[0].usage).toBeUndefined()
  })

  it('usage 缺关键字段（非 number）时整条忽略，不产生半残数据', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('hi'), usage: { input: 'x', output: 1, totalTokens: 2 } })
    expect(c.usage.last).toBeNull()
  })

  it('extractUsage 缺失 cost 时按 0 补齐而非拒绝', () => {
    const u = extractUsage({ input: 1, output: 2, totalTokens: 3 })
    expect(u).not.toBeNull()
    expect(u?.cost.total).toBe(0)
    expect(u?.cacheRead).toBe(0)
  })
})

describe('用量格式化', () => {
  it('fmtTokens：<1000 原样、千位一位小数、百万位两位', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(1000)).toBe('1k')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
  })

  it('fmtCost：小额四位小数、常规两位', () => {
    expect(fmtCost(0)).toBe('$0')
    expect(fmtCost(0.0033)).toBe('$0.0033')
    expect(fmtCost(0.5)).toBe('$0.50')
  })
})
