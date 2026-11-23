// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import PromptRail from '@/components/chat/PromptRail.vue'

/**
 * #68 M6 刻度条呈现层锁：双阈值、当前项高亮、列表展开两源（hover / 顶栏）、
 * 跳转事件载荷。
 *
 * jsdom 没有 ResizeObserver，也没有布局——组件对这两种缺失都有守卫
 * （RO 缺就不观察；宽度只读一次 getBoundingClientRect），这里用假 host
 * 元素把宽度灌成想要的值。
 */
function fakeHost(width: number): HTMLElement {
  const el = document.createElement('div')
  el.getBoundingClientRect = () => ({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect
  return el
}

const prompts = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `u${i + 1}`, text: `提问 ${i + 1}`, ts: undefined }))

function mount(
  props: Partial<{ prompts: any[]; activeId: string | null; host: HTMLElement | null; open: boolean }>,
) {
  const emits: Array<{ event: string; args: any[] }> = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  // reactive + v-model 语义：update:open 落回 props，否则 open 永远为真，
  // 收起断言测的就不是组件而是测试夹具本身（真实父层是 ChatView 的 v-model:open）。
  const live = reactive({ open: props.open ?? false })
  const app = createApp({
    render: () =>
      h(PromptRail, {
        prompts: props.prompts ?? [],
        activeId: props.activeId ?? null,
        host: props.host ?? fakeHost(800),
        open: live.open,
        onJump: (...a: any[]) => emits.push({ event: 'jump', args: a }),
        'onUpdate:open': (v: boolean) => {
          emits.push({ event: 'update:open', args: [v] })
          live.open = v
        },
      }),
  })
  app.mount(host)
  return { host, emits }
}

describe('#68 M6 刻度列阈值', () => {
  it('≥4 条提问且容器够宽 → 一提问一刻度', async () => {
    const { host } = mount({ prompts: prompts(5) })
    await nextTick()
    expect(host.querySelectorAll('.pr-tick').length).toBe(5)
  })

  it('不足 4 条 → 刻度列不常驻（列表仍可由顶栏入口展开）', async () => {
    const { host } = mount({ prompts: prompts(3) })
    await nextTick()
    expect(host.querySelectorAll('.pr-tick').length).toBe(0)
  })

  it('容器太窄（<560）→ 刻度列隐藏，哪怕提问很多', async () => {
    const { host } = mount({ prompts: prompts(8), host: fakeHost(520) })
    await nextTick()
    expect(host.querySelectorAll('.pr-tick').length).toBe(0)
  })

  it('当前提问的刻度带 active 标记（更长更深由 CSS 承担）', async () => {
    const { host } = mount({ prompts: prompts(4), activeId: 'u3' })
    await nextTick()
    const ticks = host.querySelectorAll('.pr-tick')
    expect(ticks.length).toBe(4)
    expect(ticks[2].classList.contains('active')).toBe(true)
    expect(Array.from(ticks).filter((x) => x.classList.contains('active')).length).toBe(1)
  })
})

describe('#68 M6 列表展开两源', () => {
  it('hover 刻度列 → 列表出现；移出 → 收起', async () => {
    const { host } = mount({ prompts: prompts(4) })
    await nextTick()
    const rail = host.querySelector('.prompt-rail') as HTMLElement
    expect(host.querySelector('.pr-list')).toBeFalsy()
    rail.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    expect(host.querySelectorAll('.pr-item').length).toBe(4)
    rail.dispatchEvent(new MouseEvent('mouseleave'))
    await nextTick()
    expect(host.querySelector('.pr-list')).toBeFalsy()
  })

  it('顶栏入口（open=true）→ 列表展开且不受轮数/宽度阈值约束', async () => {
    const { host } = mount({ prompts: prompts(2), open: true, host: fakeHost(400) })
    await nextTick()
    expect(host.querySelectorAll('.pr-tick').length).toBe(0)
    expect(host.querySelectorAll('.pr-item').length).toBe(2)
  })

  it('列表项：当前项 active、空正文落「（无正文）」兜底', async () => {
    const { host } = mount({
      prompts: [{ id: 'u1', text: '' }, { id: 'u2', text: '有正文' }],
      activeId: 'u1',
      open: true,
    })
    await nextTick()
    const items = host.querySelectorAll('.pr-item')
    expect(items[0].classList.contains('active')).toBe(true)
    expect(items[0].textContent).toContain('（无正文）')
    expect(items[1].textContent).toContain('有正文')
  })
})

describe('#68 M6 跳转', () => {
  it('点刻度 → emit jump 带提问 id', async () => {
    const { host, emits } = mount({ prompts: prompts(4), activeId: 'u4' })
    await nextTick()
    ;(host.querySelectorAll('.pr-tick')[1] as HTMLElement).click()
    await nextTick()
    const jump = emits.filter((e) => e.event === 'jump')
    expect(jump.length).toBe(1)
    expect(jump[0].args[0]).toBe('u2')
  })

  it('点列表项（顶栏入口态）→ jump + 收起请求（导航完成浮层让位）', async () => {
    const { host, emits } = mount({ prompts: prompts(2), open: true })
    await nextTick()
    ;(host.querySelectorAll('.pr-item')[0] as HTMLElement).click()
    await nextTick()
    expect(emits.find((e) => e.event === 'jump')?.args[0]).toBe('u1')
    const close = emits.find((e) => e.event === 'update:open')
    expect(close?.args[0]).toBe(false)
  })

  it('顶栏入口态 + 指针悬在浮层里点列表项 → 连 hover 态一起收，浮层真让位', async () => {
    const { host } = mount({ prompts: prompts(4), open: true })
    await nextTick()
    // 列表是 rail 根的子节点：指针爬进列表就触发了根容器的 mouseenter。
    // 只落 open 不清 hover，C2 点完列表仍然挂着——点击即让位意图，两源一起收。
    const rail = host.querySelector('.prompt-rail') as HTMLElement
    rail.dispatchEvent(new MouseEvent('mouseenter'))
    await nextTick()
    ;(host.querySelectorAll('.pr-item')[0] as HTMLElement).click()
    await nextTick()
    expect(host.querySelector('.pr-list')).toBeFalsy()
  })
})
