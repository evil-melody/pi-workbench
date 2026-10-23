import { describe, expect, it } from 'vitest'
import { applyEvent, emptyUsageState, type EventCtx } from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'

/** 与 piEvents.spec.ts 同款上下文工厂（nextId 每次新 id）。 */
function ctx(messages: PiMsg[] = []): EventCtx {
  let n = 0
  return { messages, streaming: true, nextId: () => `m${n++}`, usage: emptyUsageState() }
}

function usage() {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  }
}

/**
 * G4 会话持久化回放：journal 里的 user prompt 走 message_end（role=user）。
 * 实时通道必须忽略（pushUser 已乐观落过，再落就是重复气泡）；
 * 回放通道（ctx.replay=true）才重建，且正文要剥掉 preamble/附件块。
 */
describe('applyEvent · 回放 user 消息（G4）', () => {
  const userEnd = (text: string) => ({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

  it('实时通道：role=user 的 message_end 不产生重复气泡', () => {
    const c = ctx()
    applyEvent(c, userEnd('帮我改 foo'))
    expect(c.messages).toHaveLength(0)
  })

  it('回放通道：user 消息落成 user 气泡，正文剥掉 preamble 前缀', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, userEnd('[项目上下文]\n一堆\n\n---\n\n帮我改 foo'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].role).toBe('user')
    expect(c.messages[0].text).toBe('帮我改 foo')
  })

  it('回放通道：附件块还原成 attachments', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, userEnd('分析这张图\n\n[附件 / attachments]\n- image: /x/a.png'))
    expect(c.messages[0].text).toBe('分析这张图')
    expect(c.messages[0].attachments).toHaveLength(1)
    expect(c.messages[0].attachments![0]).toMatchObject({ kind: 'image', path: '/x/a.png' })
  })

  it('回放通道：role=system 的轮次注入消息不进气泡', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'system', content: '', sections: { addendum: '## 当前角色' } },
    })
    expect(c.messages).toHaveLength(0)
  })

  it('回放通道：assistant 文本消息正常重建（与实时同一路径）', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: '好的' },
    })
    applyEvent(c, { type: 'message_end', message: { role: 'assistant', content: [], usage: usage() } })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].role).toBe('assistant')
    expect(c.messages[0].text).toBe('好的')
  })
})
