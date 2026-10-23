import { describe, expect, it } from 'vitest'
import { selectSessionByIndex, selectSessionEvents } from '@/composables/useReplay'

/**
 * G4：journal 是多项目共用的（内核按 cwd 启停，事件全部流进同一个
 * events.jsonl）。回放必须只取**当前项目**最近一次会话，否则 A 项目的
 * 对话会串到 B 项目里。分段依据是 pi_start 落的 session_open 标记（带 cwd）。
 */
describe('selectSessionEvents', () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra })
  const open = (cwd: string) => ev('session_open', { cwd })

  it('取最后一个 cwd 匹配的 session_open 之后的事件', () => {
    const events = [
      open('/repo/a'),
      ev('message_end', { n: 1 }),
      open('/repo/b'),
      ev('message_end', { n: 2 }),
      open('/repo/a'),
      ev('message_end', { n: 3 }),
      ev('message_end', { n: 4 }),
    ]
    const got = selectSessionEvents(events, '/repo/a')
    expect(got.map((e) => e.n)).toEqual([3, 4])
  })

  it('段尾截到下一个 session_open：不把后一个项目的段包进来', () => {
    const events = [
      open('/repo/a'),
      ev('message_end', { n: 1 }),
      open('/repo/b'),
      ev('message_end', { n: 2 }),
    ]
    // /repo/a 的段只到下一个标记之前——n=2 属于 /repo/b，绝不出现。
    expect(selectSessionEvents(events, '/repo/a').map((e) => e.n)).toEqual([1])
  })

  it('cwd 尾斜杠视为同一目录', () => {
    const events = [open('/repo/a/'), ev('message_end', { n: 1 })]
    expect(selectSessionEvents(events, '/repo/a').map((e) => e.n)).toEqual([1])
  })

  it('有标记但都不匹配当前项目：不回放（不串项目）', () => {
    const events = [open('/repo/b'), ev('message_end', { n: 1 })]
    expect(selectSessionEvents(events, '/repo/a')).toEqual([])
  })

  it('无 cwd 参数（调试/全量模式）：返回全部事件', () => {
    const events = [open('/repo/b'), ev('message_end', { n: 1 })]
    // session_open 标记也在返回值里无妨：applyEvent 不认得的类型原样忽略。
    const got = selectSessionEvents(events, undefined)
    expect(got).toHaveLength(2)
    expect(got[1].n).toBe(1)
  })

  it('legacy journal 无 session_open 标记：全量返回（尽力而为）', () => {
    const events = [ev('message_end', { n: 1 }), ev('agent_settled')]
    expect(selectSessionEvents(events, '/repo/a')).toHaveLength(2)
  })

  it('session_open 是最后一条：该会话还没有消息，返回空', () => {
    const events = [open('/repo/a')]
    expect(selectSessionEvents(events, '/repo/a')).toEqual([])
  })
})

/**
 * 运行记录回放：按 journal 全局段号取段（配合 pi_journal_sessions 的 index）。
 */
describe('selectSessionByIndex', () => {
  const ev = (type: string, extra: Record<string, unknown> = {}) => ({ type, ...extra })
  const open = (cwd: string) => ev('session_open', { cwd })

  const events = [
    open('/repo/a'),
    ev('message_end', { n: 1 }),
    open('/repo/b'),
    ev('message_end', { n: 2 }),
    open('/repo/a'),
    ev('message_end', { n: 3 }),
    ev('message_end', { n: 4 }),
  ]

  it('段号 0：第一段（含到下一标记前）', () => {
    expect(selectSessionByIndex(events, 0).map((e) => e.n)).toEqual([1])
  })

  it('段号 2：最后一段到 journal 结尾', () => {
    expect(selectSessionByIndex(events, 2).map((e) => e.n)).toEqual([3, 4])
  })

  it('cwd 与段号不一致（journal 被轮转/清理）：返回空，绝不串项目', () => {
    expect(selectSessionByIndex(events, 1, '/repo/a')).toEqual([])
    expect(selectSessionByIndex(events, 0, '/repo/a').map((e) => e.n)).toEqual([1])
  })

  it('段号越界返回空', () => {
    expect(selectSessionByIndex(events, 99)).toEqual([])
    expect(selectSessionByIndex(events, -1)).toEqual([])
  })

  it('尾斜杠视为同一目录', () => {
    expect(selectSessionByIndex(events, 0, '/repo/a/').map((e) => e.n)).toEqual([1])
  })
})
