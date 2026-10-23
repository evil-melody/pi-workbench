// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { createApp, h, nextTick, ref } from 'vue'
import AppModal from '@/components/ui/AppModal.vue'

/**
 * AppModal 焦点行为（AUDIT-011）。
 *
 * 背景：原实现无 focus trap、无 autofocus，Esc 只在焦点恰好在面板内时生效——
 * 键盘用户按 Esc 多数情况没反应，Tab 会走到背后的页面。这里用 jsdom 真实挂载，
 * 断言「打开即聚焦 / Tab 循环 / Esc 全局关闭 / 关闭后还原焦点」。
 */

/** 每个用例后卸载并清空 body：Teleport 到 body 的弹层不清理会串味。 */
const cleanups: (() => void)[] = []
afterEach(() => {
  while (cleanups.length) cleanups.pop()!()
  document.body.innerHTML = ''
})

function mount(open = false) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const state = ref(open)
  const app = createApp({
    render: () =>
      h(
        AppModal,
        {
          open: state.value,
          title: '测试弹窗',
          'onUpdate:open': (v: boolean) => {
            state.value = v
          },
        },
        {
          default: () => h('button', { class: 'first-btn' }, '第一个'),
          footer: () => h('button', { class: 'last-btn' }, '最后一个'),
        },
      ),
  })
  app.mount(host)
  cleanups.push(() => app.unmount())
  return { host, state, app }
}

const backdrop = () => document.body.querySelector('.modal-backdrop') as HTMLElement
const activeInBackdrop = () => backdrop()?.contains(document.activeElement) ?? false

describe('AppModal · 焦点行为', () => {
  it('打开后焦点进入面板（首个可聚焦元素）', async () => {
    const { state } = mount(false)
    state.value = true
    await nextTick()
    await nextTick()
    expect(backdrop()).toBeTruthy()
    expect(activeInBackdrop()).toBe(true)
    expect(document.activeElement).toBe(backdrop().querySelector('.modal-close'))
  })

  it('挂载即打开（immediate）也有焦点管理', async () => {
    mount(true)
    await nextTick()
    await nextTick()
    expect(activeInBackdrop()).toBe(true)
  })

  it('Esc 全局关闭：不依赖焦点是否在面板内', async () => {
    const { state } = mount(true)
    await nextTick()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(state.value).toBe(false)
  })

  it('Tab 在面板内循环：末尾再 Tab 回首元素', async () => {
    mount(true)
    await nextTick()
    await nextTick()
    const first = backdrop().querySelector('.modal-close') as HTMLElement
    const last = backdrop().querySelector('.last-btn') as HTMLElement
    last.focus()
    expect(document.activeElement).toBe(last)
    last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }))
    expect(document.activeElement).toBe(first)
  })

  it('Shift+Tab 在首元素上回到末元素', async () => {
    mount(true)
    await nextTick()
    await nextTick()
    const first = backdrop().querySelector('.modal-close') as HTMLElement
    const last = backdrop().querySelector('.last-btn') as HTMLElement
    first.focus()
    first.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }),
    )
    expect(document.activeElement).toBe(last)
  })

  it('关闭后还原打开前的焦点宿主', async () => {
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    outside.focus()
    const { state } = mount(false)
    state.value = true
    await nextTick()
    await nextTick()
    expect(activeInBackdrop()).toBe(true)
    state.value = false
    await nextTick()
    await nextTick()
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })
})
