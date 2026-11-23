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

  it('回放通道：排队消息先落 user_prompt，内核回显后不重复', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, { type: 'user_prompt', text: '再查一下日志', queued: true })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0]).toMatchObject({ role: 'user', text: '再查一下日志', queued: true })
    // 内核真正消费后回显同一段文本：只清标记，不再插一条。
    applyEvent(c, userEnd('再查一下日志'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].queued).toBeUndefined()
  })

  it('实时通道的 user_prompt 不落气泡（pushUser 已落过）', () => {
    const c = ctx()
    applyEvent(c, { type: 'user_prompt', text: '再查一下日志', queued: true })
    expect(c.messages).toHaveLength(0)
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

/**
 * 用户消息不落盘的四条真实路径（journal 实测：修复前 13k 行里 0 条 user_prompt）。
 * 发送时（prompt / follow_up / steer）都必须先落一条 `user_prompt`，
 * 回放才能在内核还没回显、切换会话或刷新时还原气泡。
 */
describe('applyEvent · 用户消息四类场景', () => {
  const userEnd = (text: string) => ({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

  function replay(events: unknown[]): PiMsg[] {
    const c = ctx()
    c.replay = true
    for (const ev of events) applyEvent(c, ev as any)
    return c.messages
  }

  it('运行中发第二条（follow_up）：重载后仍在，内核回显不重复', () => {
    const journal = [
      { type: 'run_start', runId: 'r1', prompt: '第一条' },
      { type: 'user_prompt', runId: 'r1', text: '第一条', mode: 'prompt', queued: false },
      { type: 'user_prompt', runId: 'r1', text: '跑完顺便看下日志', mode: 'follow_up', queued: true },
      userEnd('第一条'),
    ]
    const messages = replay(journal)
    expect(messages.filter((m) => m.role === 'user').map((m) => m.text)).toEqual(['第一条', '跑完顺便看下日志'])
    // 内核之后才消费 follow_up：只清标记，不再冒一条重复气泡。
    const c = ctx(messages)
    c.replay = true
    applyEvent(c, userEnd('跑完顺便看下日志'))
    expect(c.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(c.messages[1].queued).toBeUndefined()
  })

  it('运行中插话（steer）：重载后仍在', () => {
    const messages = replay([
      { type: 'user_prompt', runId: 'r1', text: '别改测试', mode: 'steer', queued: true },
    ])
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'user', text: '别改测试', queued: true })
  })

  it('发送后立刻切会话再切回：内核还没回显也不丢，回显后只留一条', () => {
    const journal = [
      { type: 'user_prompt', runId: 'r2', text: '查一下构建失败', mode: 'prompt', queued: false },
    ]
    expect(replay(journal).map((m) => m.text)).toEqual(['查一下构建失败'])
    const afterEcho = replay([...journal, userEnd('查一下构建失败')])
    expect(afterEcho).toHaveLength(1)
    expect(afterEcho[0].synth).toBeUndefined()
  })

  it('前端重挂载：同一 journal 回放两次结果一致，不叠加', () => {
    const journal = [
      { type: 'user_prompt', runId: 'r3', text: '一', mode: 'prompt', queued: false },
      userEnd('一'),
      { type: 'user_prompt', runId: 'r3', text: '二', mode: 'follow_up', queued: true },
    ]
    const first = replay(journal)
    const second = replay(journal)
    expect(first.map((m) => m.text)).toEqual(['一', '二'])
    expect(second.map((m) => m.text)).toEqual(['一', '二'])
  })

  it('落盘顺序颠倒（内核回显先到）：同文本不叠成两条', () => {
    // 读线程与合成事件各持句柄，极快回显时 message_end 可能先落盘。
    const messages = replay([
      userEnd('顺手看下日志'),
      { type: 'user_prompt', runId: 'r4', text: '顺手看下日志', mode: 'follow_up', queued: true },
    ])
    const users = messages.filter((m) => m.role === 'user')
    expect(users).toHaveLength(1)
    expect(users[0].text).toBe('顺手看下日志')
  })

  it('多条排队消息逐条消标记，不被后一个回显一次性清空', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, { type: 'user_prompt', text: '排队一', mode: 'follow_up', queued: true })
    applyEvent(c, { type: 'user_prompt', text: '排队二', mode: 'follow_up', queued: true })
    applyEvent(c, userEnd('排队一'))
    expect(c.messages.map((m) => [m.text, m.queued])).toEqual([
      ['排队一', undefined],
      ['排队二', true],
    ])
    applyEvent(c, userEnd('排队二'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages.every((m) => m.synth === undefined)).toBe(true)
  })

  it('合成事件带完整附件元数据时优先使用（name/size）', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, {
      type: 'user_prompt',
      text: '分析这张图',
      mode: 'prompt',
      queued: false,
      attachments: [{ id: 'a1', name: 'shot.png', kind: 'image', path: '/x/shot.png', size: 2048 }],
    })
    expect(c.messages[0].attachments).toEqual([
      { id: 'a1', name: 'shot.png', kind: 'image', path: '/x/shot.png', size: 2048 },
    ])
  })
})

/**
 * #65 引用回放：引用与附件同构但语义不同——引用是一段随 prompt 下发的文本，
 * 走独立 `[引用 / quotes]` 块 + 独立富字段。两条通道都要还原：
 * 内核回显只有 marker 块（块解析），崩溃窗口的 user_prompt 带富字段（优先）。
 */
describe('applyEvent · 引用回放（#65）', () => {
  const userEnd = (text: string) => ({
    type: 'message_end',
    message: { role: 'user', content: [{ type: 'text', text }] },
  })

  it('内核回显：引用块还原成 quotes、正文剥干净', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, userEnd('接着分析\n\n[引用 / quotes]\n- [1] 第一段结论\n  批注: 看这里'))
    expect(c.messages[0].text).toBe('接着分析')
    expect(c.messages[0].quotes).toHaveLength(1)
    expect(c.messages[0].quotes![0]).toMatchObject({ kind: 'text', text: '第一段结论', note: '看这里' })
  })

  it('多行引用往返无损（编码把 \n 压成 \\n）', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, userEnd('看这段\n\n[引用 / quotes]\n- [1] 第一行\\n第二行'))
    expect(c.messages[0].quotes![0].text).toBe('第一行\n第二行')
  })

  it('引用 + 附件同轮：两块各自还原，不互相污染', () => {
    const c = ctx()
    c.replay = true
    applyEvent(
      c,
      userEnd('图文并参\n\n[引用 / quotes]\n- [1] 一句引用\n\n[附件 / attachments]\n- image: /x/a.png'),
    )
    expect(c.messages[0].text).toBe('图文并参')
    expect(c.messages[0].quotes).toHaveLength(1)
    expect(c.messages[0].attachments).toHaveLength(1)
  })

  it('只有引用、无正文：仍然落气泡（引用单独发送合法）', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, userEnd('\n\n[引用 / quotes]\n- [1] 光秃秃的一句引用'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].text).toBe('')
    expect(c.messages[0].quotes![0].text).toBe('光秃秃的一句引用')
  })

  it('user_prompt 富字段优先于块解析（保留 id/note 原样）', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, {
      type: 'user_prompt',
      text: '接着分析',
      mode: 'prompt',
      quotes: [{ id: 'q7', kind: 'text', text: '富字段原文', note: '批注', source: '来自回复' }],
    })
    expect(c.messages[0].quotes).toEqual([
      { id: 'q7', kind: 'text', text: '富字段原文', note: '批注', source: '来自回复' },
    ])
  })

  it('先落 user_prompt（富字段）、内核后回显（仅块）：不回退覆盖成块解析', () => {
    const c = ctx()
    c.replay = true
    applyEvent(c, {
      type: 'user_prompt',
      text: '接着分析',
      mode: 'prompt',
      quotes: [{ id: 'q7', kind: 'text', text: '富字段原文' }],
    })
    applyEvent(c, userEnd('接着分析\n\n[引用 / quotes]\n- [1] 块解析原文'))
    expect(c.messages).toHaveLength(1)
    // 富字段的 id 更准，块解析不该反向覆盖。
    expect(c.messages[0].quotes![0].id).toBe('q7')
  })
})
