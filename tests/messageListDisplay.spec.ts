// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import MessageList from '@/components/chat/MessageList.vue'
import { fmtClock } from '@/utils/timeAgo'

/**
 * 对话页显示逻辑细化（批 5）的呈现层锁：时钟三档、Think 摘要的运行/落定分档、
 * 中断回执、用户气泡时刻的「无 ts 就不显」。
 *
 * 和 messageListToolRow.spec.ts 同一个挂载口径——纯函数测不出「组件真的用上了」，
 * 这几条锁的就是接线。
 *
 * `ponytail:` abortTurn 里「把 streaming 消息收尾」那段不在这里测：`usePi()` 第一件事
 * 就是 `if (!IN_TAURI) return`（jsdom 里没有 `__TAURI_INTERNALS__`），要测就得 mock
 * 整个 IPC 层。升级路径是把收尾抽成可导出的纯函数再补测。
 */
const ROOT = '/Users/me/repo'

function mountList(list: any[], opts: { streaming?: boolean; interrupted?: boolean } = {}) {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(MessageList, {
        messages: list,
        streaming: opts.streaming ?? false,
        interrupted: opts.interrupted ?? false,
        artifacts: {},
        root: ROOT,
      }),
  })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  return { host, errors }
}

const summaryOf = (host: HTMLElement) =>
  host.querySelector('.crow-summary')?.textContent ?? ''

describe('fmtClock 三档', () => {
  const now = new Date(2026, 10, 1, 9, 5).getTime()

  it('同一天只给时分，跨日给月日，跨年给年', () => {
    expect(fmtClock(new Date(2026, 10, 1, 23, 59).getTime(), now)).toBe('23:59')
    expect(fmtClock(new Date(2026, 9, 30, 7, 3).getTime(), now)).toBe('10月30日')
    expect(fmtClock(new Date(2025, 0, 5, 8, 0).getTime(), now)).toBe('2025年')
  })

  it('补零两位：个位时分写成 0 前缀', () => {
    expect(fmtClock(new Date(2026, 10, 1, 4, 7).getTime(), now)).toBe('04:07')
  })

  it('没有数据源就是空串（回放消息不许编假时间）', () => {
    expect(fmtClock(undefined as unknown as number, now)).toBe('')
    expect(fmtClock(0, now)).toBe('')
  })
})

describe('Think 行摘要', () => {
  const reasoning = '先确认入口文件\n再看调用方\n最后跑类型检查'

  it('落定的 turn 固定显首行', async () => {
    const { host, errors } = mountList([
      { id: 'u1', role: 'user', text: '为什么白屏' },
      { id: 'a1', role: 'assistant', text: '因为头像没并进 turn。', reasoning },
    ])
    await nextTick()
    expect(errors).toEqual([])
    expect(summaryOf(host)).toBe('先确认入口文件')
  })

  it('流式中的末尾消息显最新一行（对齐 dsh running ? latestLine）', async () => {
    const { host } = mountList(
      [
        { id: 'u1', role: 'user', text: '为什么白屏' },
        { id: 'a1', role: 'assistant', text: '', reasoning, streaming: true },
      ],
      { streaming: true },
    )
    await nextTick()
    expect(summaryOf(host)).toBe('最后跑类型检查')
  })
})

describe('中断回执与时刻', () => {
  it('interrupted 的末尾 turn 渲染「已中断」收据', async () => {
    const { host, errors } = mountList(
      [
        { id: 'u1', role: 'user', text: '重构一下', ts: Date.now() },
        { id: 'a1', role: 'assistant', text: '先读一遍现有', ts: Date.now() },
        { id: 'u2', role: 'user', text: '继续', ts: Date.now() },
        { id: 'a2', role: 'assistant', text: '正在改', ts: Date.now() },
      ],
      { interrupted: true },
    )
    await nextTick()
    expect(errors).toEqual([])
    const line = host.querySelector('.msg-stopped')!
    expect(line.textContent?.trim()).toBe('已中断')
    // 回执只属于末尾那一轮
    expect(host.querySelectorAll('.msg-stopped')).toHaveLength(1)
    const turns = [...host.querySelectorAll<HTMLElement>('.msg-row.assistant')]
    expect(turns).toHaveLength(2)
    expect(turns[0].querySelector('.msg-stopped')).toBeNull()
    expect(turns[1].querySelector('.msg-stopped')).not.toBeNull()
  })

  it('未中断的 turn 不出回执', async () => {
    const { host } = mountList([{ id: 'a1', role: 'assistant', text: '好了', ts: Date.now() }])
    await nextTick()
    expect(host.querySelector('.msg-stopped')).toBeNull()
  })

  it('操作行时钟：有 ts 才显，回放消息整颗隐藏', async () => {
    const withTs = mountList([
      { id: 'u1', role: 'user', text: '跑一下', ts: Date.now() },
      { id: 'a1', role: 'assistant', text: '跑完了', ts: Date.now() },
    ])
    await nextTick()
    expect(withTs.host.querySelector('.ta-clock')?.textContent).toMatch(/\d{2}:\d{2}/)

    const replay = mountList([{ id: 'a2', role: 'assistant', text: '回放正文' }])
    await nextTick()
    expect(replay.host.querySelector('.ta-clock')).toBeNull()
  })

  it('用户气泡时刻只在 msg.ts 存在时出现', async () => {
    const { host } = mountList([
      { id: 'u1', role: 'user', text: '带时间', ts: Date.now() },
      { id: 'u2', role: 'user', text: '回放来的' },
    ])
    await nextTick()
    const clocks = [...host.querySelectorAll('.u-clock')]
    expect(clocks).toHaveLength(1)
    expect(clocks[0].textContent).toMatch(/\d{2}:\d{2}/)
  })
})
