// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick } from 'vue'
import WorkspacePicker from '@/components/chat/WorkspacePicker.vue'

/**
 * 工作目录选择器的真实挂载用例。
 *
 * 背景：真实 store 里的项目 path 可以是 null（先用模板建项目、之后再绑目录）。
 * 菜单渲染一个 null 路径时 `shortPath` 直接 `.replace()` 崩掉，Vue 把渲染错误吞在
 * 控制台里 —— 表现就是「点触发器没反应」。纯函数测试抓不到模板里的这次崩溃，
 * 必须真的把组件挂起来点一下。
 */

/** 复刻本机 store 的真实形态：一个无目录项目 + 一个已绑目录项目。 */
const PROJECTS = [
  { id: 'a', name: '产品需求全流程', path: null },
  { id: 'b', name: 'pi-workbench', path: '/Users/tatsuma/Documents/GIT/pi-workbench' },
]

const dialog = vi.hoisted(() => ({ open: vi.fn<() => Promise<string | null>>() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: dialog.open }))

/** 收集组件抛出的渲染/生命周期错误，避免「崩了但断言照样绿」。 */
function mount(props: any) {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({ render: () => h(WorkspacePicker, props) })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  return { app, host, errors }
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

const triggerOf = (host: HTMLElement) => host.querySelector<HTMLButtonElement>('.ws-trigger')!
const menu = () => document.querySelector<HTMLElement>('.ws-menu')

describe('WorkspacePicker', () => {
  beforeEach(() => {
    dialog.open.mockReset()
    dialog.open.mockResolvedValue(null)
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('项目路径为 null 时菜单照样能渲染（不再整块崩掉）', async () => {
    const { host, errors } = mount({ projects: PROJECTS, cwd: '' })
    triggerOf(host).click()
    await flush()

    expect(errors).toEqual([])
    expect(menu()).not.toBeNull()
    expect(menu()!.textContent).toContain('产品需求全流程')
    // 没绑目录的项目必须说清楚它缺什么，而不是只显示一个空行
    expect(menu()!.textContent).toContain('未绑定目录')
  })

  it('点未绑定目录的项目 → 就地拉起目录选择器并请求绑定', async () => {
    dialog.open.mockResolvedValue('/tmp/demo-dir')
    const picked: Array<{ id: string; dir: string }> = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    const app = createApp({
      render: () =>
        h(WorkspacePicker, {
          projects: PROJECTS,
          cwd: '',
          onBindDirectory: (e: { id: string; dir: string }) => picked.push(e),
        }),
    })
    app.mount(host)

    triggerOf(host).click()
    await flush()
    const opt = [...document.querySelectorAll<HTMLButtonElement>('.ws-menu .ws-opt')].find((b) =>
      b.textContent?.includes('产品需求全流程'),
    )
    expect(opt).toBeTruthy()
    opt!.click()
    await flush()

    expect(dialog.open).toHaveBeenCalledTimes(1)
    expect(picked).toEqual([{ id: 'a', dir: '/tmp/demo-dir' }])
  })

  it('点已绑目录的项目 → 请求切项目', async () => {
    const switched: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp({
      render: () =>
        h(WorkspacePicker, {
          projects: PROJECTS,
          cwd: '',
          onPickProject: (id: string) => switched.push(id),
        }),
    }).mount(host)

    triggerOf(host).click()
    await flush()
    const opt = [...document.querySelectorAll<HTMLButtonElement>('.ws-menu .ws-opt')].find((b) =>
      b.textContent?.includes('pi-workbench'),
    )
    opt!.click()
    await flush()

    expect(switched).toEqual(['b'])
    // 切完就收起，避免菜单浮在已经切走的界面上
    expect(menu()).toBeNull()
  })

  it('点当前项目本身不再发请求（无变化的重复动作）', async () => {
    const switched: string[] = []
    const host = document.createElement('div')
    document.body.appendChild(host)
    createApp({
      render: () =>
        h(WorkspacePicker, {
          projects: PROJECTS,
          cwd: '/Users/tatsuma/Documents/GIT/pi-workbench',
          onPickProject: (id: string) => switched.push(id),
        }),
    }).mount(host)

    triggerOf(host).click()
    await flush()
    const opt = [...document.querySelectorAll<HTMLButtonElement>('.ws-menu .ws-opt')].find((b) =>
      b.textContent?.includes('pi-workbench'),
    )
    opt!.click()
    await flush()

    expect(switched).toEqual([])
  })
})
