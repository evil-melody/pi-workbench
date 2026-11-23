// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, reactive } from 'vue'
import TraceDrawer from '@/components/chat/TraceDrawer.vue'

/**
 * 过程抽屉的真实挂载守卫。
 *
 * 背景：`TABS` 用了 `computed` 但漏了 import，setup 在 `open=false` 时也会执行，
 * 于是每进一次对话页就抛 `ReferenceError`，组件实例残缺后父组件更新接着抛
 * `instance.update is not a function`。typecheck 能抓到，但曾经因为输出被截断
 * 误判为通过 —— 这里用真实挂载把这类「setup 就炸」钉死。
 */

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(async () => null) }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => undefined) }))

// jsdom 没有 ResizeObserver；抽屉的标签条溢出检测用它，缺了会当成组件错误。
globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function mount(props: any) {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(TraceDrawer, props) })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  return { app, host, errors }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

const baseProps: any = {
  calls: 0,
  state: { phase: 'idle', delivered: false, children: [] },
  running: false,
  messages: [],
  sessionId: 'test-session',
  usage: null,
  turns: 0,
  steps: 0,
  projectId: null,
}

describe('TraceDrawer', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('收起时挂载不报错', async () => {
    const { app, errors } = mount({ ...baseProps, open: false })
    await flush()
    expect(errors).toEqual([])
    app.unmount()
  })

  it('开关十次不报错（覆盖 props.open 的每次更新）', async () => {
    const props = reactive({ ...baseProps, open: false })
    const errors: unknown[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({ render: () => h(TraceDrawer, props) })
    app.config.errorHandler = (e) => errors.push(e)
    app.mount(host)
    for (let i = 0; i < 10; i++) {
      props.open = true
      await flush()
      props.open = false
      await flush()
    }
    expect(errors).toEqual([])
    app.unmount()
  })
})
