import { describe, expect, it } from 'vitest'
import { usePiEvents } from '@/composables/usePiEvents'
import type { PiEventRow } from '@/utils/piEventKind'

function row(kind: PiEventRow['kind'], title = 't'): PiEventRow {
  return { kind, title, detail: '', at: Date.now() }
}

describe('usePiEvents', () => {
  it('浏览器模式下 ensure 不订阅也不抛错', async () => {
    const api = usePiEvents(10)
    await expect(api.ensure()).resolves.toBeUndefined()
    expect(api.events.value).toEqual([])
  })

  it('push 累加事件并统计各类数量', () => {
    const api = usePiEvents(10)
    api.push(row('tool_call', 'read'))
    api.push(row('tool_result', 'read'))
    api.push(row('turn_start'))
    api.push(row('exit'))
    expect(api.events.value).toHaveLength(4)
    expect(api.stats.value).toMatchObject({ total: 4, calls: 1, turns: 1, exits: 1 })
  })

  it('超出上限丢弃最旧的一条，缓冲定长', () => {
    const api = usePiEvents(3)
    for (let i = 0; i < 6; i++) api.push(row('tool_call', `#${i}`))
    expect(api.events.value).toHaveLength(3)
    expect(api.events.value.map((e) => e.title)).toEqual(['#3', '#4', '#5'])
    expect(api.stats.value.calls).toBe(3)
  })

  it('note 生成 other 类留痕行', () => {
    const api = usePiEvents(10)
    api.note('目标地址', 'https://example.com')
    const last = api.events.value[0]
    expect(last?.kind).toBe('other')
    expect(last?.title).toBe('目标地址')
    expect(last?.detail).toBe('https://example.com')
  })

  it('reset 清空缓冲', () => {
    const api = usePiEvents(10)
    api.push(row('message', 'hi'))
    api.reset()
    expect(api.events.value).toEqual([])
    expect(api.stats.value.total).toBe(0)
  })
})
