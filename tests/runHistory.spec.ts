// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp, h, nextTick, type App } from 'vue'
import RunHistory from '@/components/chat/RunHistory.vue'

/**
 * 运行记录列表的真实挂载用例：
 * - 「···」菜单全量项与顺序（对齐 WorkBuddy）
 * - 分享任务 → clipboard 写 markdown 摘要 / 失败降级弹窗
 * - 批量操作：多选态、全选、逐条 invoke run_meta_update
 * - 删除确认 / 重命名 / 打开文件夹 / 独立窗口 / 归档开关
 *
 * 后端（run_meta / journal 合并 / reveal_path / open_replay_window）按契要 mock。
 */

const invokeMock = vi.hoisted(() =>
  vi.fn<(cmd: string, args?: Record<string, unknown>) => Promise<unknown>>(),
)
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

// useReplay 经 usePi 读 IN_TAURI：jsdom 里没有 Tauri 运行时，直接桩成桌面模式。
vi.mock('@/composables/usePi', () => ({
  IN_TAURI: true,
  splitPromptBody: (s: string) => ({ text: s }),
}))

const T0 = new Date(2024, 0, 2, 10, 0).getTime()

/** 后端 pi_journal_sessions 合并后的段（含 pinned / archived / renamed）。 */
const SESSIONS = [
  {
    index: 0,
    cwd: '/repo/a',
    started_at_ms: T0,
    ended_at_ms: T0 + 3_600_000,
    events: 42,
    prompts: 3,
    title: '修复登录页样式',
    pinned: true,
    archived: false,
    renamed: false,
  },
  {
    index: 1,
    cwd: '/repo/a',
    started_at_ms: T0 - 7_200_000,
    ended_at_ms: T0 - 6_000_000,
    events: 20,
    prompts: 2,
    title: '补充单元测试',
    archived: false,
  },
  {
    index: 2,
    cwd: '/repo/a',
    started_at_ms: T0 - 86_400_000,
    ended_at_ms: T0 - 86_000_000,
    events: 9,
    prompts: 1,
    title: '旧任务（已归档）',
    archived: true,
  },
]

/** 后端 run_meta sidecar。 */
const META = [
  { cwd: '/repo/a', index: 0, pinned: true, archived: false, deleted: false },
  { cwd: '/repo/a', index: 2, pinned: false, archived: true, deleted: false },
]

const clipboard = vi.hoisted(() => ({ writeText: vi.fn<(text: string) => Promise<void>>() }))
Object.defineProperty(window.navigator, 'clipboard', {
  value: clipboard,
  configurable: true,
})

const mounted: App[] = []

function mountRunHistory() {
  const errors: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const app = createApp({
    render: () =>
      h(RunHistory, {
        cwd: '/repo/a',
        pageSize: 5,
        onOpen: () => {},
      }),
  })
  app.config.errorHandler = (e) => errors.push(e)
  app.mount(host)
  mounted.push(app)
  return { app, host, errors }
}

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 0))
  await nextTick()
}

const rows = (host: HTMLElement) => [...host.querySelectorAll<HTMLElement>('.rh-item')]
const menuOf = () => document.querySelector<HTMLElement>('.ctx-menu')
const menuItems = () => [...document.querySelectorAll<HTMLButtonElement>('.ctx-menu .ctx-menu-item')]
const menuItem = (text: string) =>
  menuItems().find((b) => b.textContent?.trim() === text)

/** 打开某一行的「···」菜单。 */
async function openRowMenu(host: HTMLElement, rowIndex: number) {
  rows(host)[rowIndex].querySelector<HTMLButtonElement>('.rh-more-btn')!.click()
  await flush()
  expect(menuOf()).not.toBeNull()
}

const updateCalls = () =>
  invokeMock.mock.calls.filter(([cmd]) => cmd === 'run_meta_update')

describe('RunHistory', () => {
  beforeEach(() => {
    invokeMock.mockReset()
    invokeMock.mockImplementation(async (cmd: string, args?: Record<string, unknown>) => {
      switch (cmd) {
        case 'pi_journal_sessions':
          // 后端默认过滤 archived；includeArchived=true 才带出。
          return SESSIONS.filter((s) => (args?.includeArchived === true ? true : !s.archived))
        case 'run_meta_list':
        case 'run_meta_update':
          return META
        case 'reveal_path':
        case 'open_replay_window':
          return null
        default:
          throw new Error(`unexpected invoke: ${cmd}`)
      }
    })
    clipboard.writeText.mockReset()
    clipboard.writeText.mockResolvedValue(undefined)
  })

  afterEach(() => {
    while (mounted.length) mounted.pop()!.unmount()
    document.body.innerHTML = ''
  })

  it('渲染记录列表：置顶段置前 + 星标，归档计数按钮就位', async () => {
    const { host, errors } = mountRunHistory()
    await flush()

    expect(errors).toEqual([])
    const list = rows(host)
    expect(list).toHaveLength(2)
    // 后端合并置顶 + listRunHistory 稳定置前：置顶段在第一行
    expect(list[0].querySelector('.rh-title')!.textContent).toBe('修复登录页样式')
    expect(list[0].querySelector('.rh-pin')).not.toBeNull()
    expect(list[1].querySelector('.rh-pin')).toBeNull()
    expect(list[0].textContent).toContain('3 轮')
    const archivedBtn = [...host.querySelectorAll<HTMLButtonElement>('.rh-more')].find((b) =>
      b.textContent?.includes('查看归档'),
    )
    expect(archivedBtn?.textContent).toContain('1')
  })

  it('「···」菜单全量项与顺序（对齐 WorkBuddy），删除是危险项', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 0)

    expect(menuItems().map((b) => b.textContent?.trim())).toEqual([
      '打开这条记录',
      '取消置顶',
      '重命名',
      '分享任务',
      '在独立窗口中打开',
      '打开文件夹',
      '批量操作',
      '归档',
      '删除任务',
    ])
    expect(menuOf()!.querySelectorAll('.ctx-menu-sep')).toHaveLength(2)
    const del = menuItem('删除任务')!
    expect(del.className).toContain('danger')
  })

  it('分享任务：markdown 摘要进剪贴板并 toast「已复制」', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 0)
    menuItem('分享任务')!.click()
    await flush()

    expect(clipboard.writeText).toHaveBeenCalledTimes(1)
    const md = clipboard.writeText.mock.calls[0]![0] as string
    expect(md).toContain('# 修复登录页样式')
    expect(md).toContain('- 起止时间：')
    expect(md).toContain('- 轮数：3 轮')
    expect(md).toContain('- 任务数：3')
    expect(md).toContain('- 工作目录：`/repo/a`')
    expect(menuOf()).toBeNull()
    expect(document.querySelector('.rh-toast')!.textContent).toBe('已复制任务摘要')
  })

  it('剪贴板被拒：降级弹窗手动复制，不假装成功', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 1)
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'))
    menuItem('分享任务')!.click()
    await flush()

    expect(document.querySelector('.rh-toast')).toBeNull()
    const panel = document.querySelector('.modal-panel')!
    expect(panel.textContent).toContain('复制失败')
    expect(panel.querySelector('.rh-share-pre')!.textContent).toContain('# 补充单元测试')
  })

  it('批量操作：进入多选态 → 勾选 → 逐条 invoke run_meta_update → 取消退出', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 0)
    menuItem('批量操作')!.click()
    await flush()

    // 多选态：条目前是公共 AppCheckbox（真渲染，含自绘 box），「···」让位
    expect(host.querySelectorAll('.rh-check .native')).toHaveLength(2)
    expect(host.querySelectorAll('.rh-more-btn')).toHaveLength(0)
    expect(host.querySelector('.bulk-bar')).not.toBeNull()

    // 点第二行 = 勾选（checkbox 选中态同步）
    rows(host)[1].click()
    await flush()
    expect(host.querySelector('.bulk-count')!.textContent).toBe('已选 1/2')
    const checkboxes = host.querySelectorAll<HTMLInputElement>('.rh-check .native')
    expect(checkboxes[0]!.checked).toBe(false)
    expect(checkboxes[1]!.checked).toBe(true)

    // 批量置顶 → 逐条 update（后端一次只收一条）
    const pinBtn = [...host.querySelectorAll<HTMLButtonElement>('.bulk-btn')].find(
      (b) => b.textContent?.trim() === '置顶',
    )!
    pinBtn.click()
    await flush()

    const calls = updateCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ cwd: '/repo/a', index: 1, patch: { pinned: true } })
    // 完成后清空选中但仍留在多选态（可继续操作）
    expect(host.querySelector('.bulk-count')!.textContent).toBe('已选 0/2')
    expect(host.querySelector('.bulk-bar')).not.toBeNull()

    // 全选 → 已选 2/2
    const box = document.querySelector<HTMLInputElement>('.bulk-all .native')!
    box.checked = true
    box.dispatchEvent(new Event('change', { bubbles: true }))
    await flush()
    expect(host.querySelector('.bulk-count')!.textContent).toBe('已选 2/2')

    // 取消退出多选态
    const cancelBtn = [...host.querySelectorAll<HTMLButtonElement>('.bulk-btn')].find(
      (b) => b.textContent?.trim() === '取消',
    )!
    cancelBtn.click()
    await flush()
    expect(host.querySelector('.bulk-bar')).toBeNull()
    expect(host.querySelectorAll('.rh-more-btn')).toHaveLength(2)
  })

  it('删除任务：AppModal 确认后软删除（run_meta_update deleted）', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 0)
    menuItem('删除任务')!.click()
    await flush()

    const panel = document.querySelector('.modal-panel')!
    expect(panel.textContent).toContain('删除这条记录')
    panel.querySelector<HTMLButtonElement>('.rh-btn.danger')!.click()
    await flush()

    const calls = updateCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ cwd: '/repo/a', index: 0, patch: { deleted: true } })
    expect(document.querySelector('.rh-toast')!.textContent).toBe('已删除 1 条记录')
  })

  it('重命名：AppModal + AppInput 写 title', async () => {
    const { host } = mountRunHistory()
    await flush()
    await openRowMenu(host, 1)
    menuItem('重命名')!.click()
    await flush()

    const input = document.querySelector<HTMLInputElement>('.modal-panel .app-input')!
    input.value = '登录页返工'
    input.dispatchEvent(new Event('input'))
    document.querySelector<HTMLButtonElement>('.modal-panel .rh-btn.primary')!.click()
    await flush()

    const calls = updateCalls()
    expect(calls).toHaveLength(1)
    expect(calls[0]![1]).toEqual({ cwd: '/repo/a', index: 1, patch: { title: '登录页返工' } })
  })

  it('打开文件夹 / 在独立窗口中打开：走后端命令', async () => {
    const { host } = mountRunHistory()
    await flush()

    await openRowMenu(host, 0)
    menuItem('打开文件夹')!.click()
    await flush()
    expect(
      invokeMock.mock.calls.find(([cmd]) => cmd === 'reveal_path')?.[1],
    ).toEqual({ path: '/repo/a' })

    await openRowMenu(host, 0)
    menuItem('在独立窗口中打开')!.click()
    await flush()
    expect(
      invokeMock.mock.calls.find(([cmd]) => cmd === 'open_replay_window')?.[1],
    ).toEqual({ cwd: '/repo/a', index: 0 })
  })

  it('归档开关：查看归档带出归档记录（置灰），菜单变「取消归档」', async () => {
    const { host } = mountRunHistory()
    await flush()

    const archivedBtn = [...host.querySelectorAll<HTMLButtonElement>('.rh-more')].find((b) =>
      b.textContent?.includes('查看归档'),
    )!
    archivedBtn.click()
    await flush()

    const list = rows(host)
    expect(list).toHaveLength(3)
    // 置顶段仍稳定置前（不被归档视图打乱），归档段置灰带出
    const archivedIdx = list.findIndex((r) =>
      r.querySelector('.rh-title')!.textContent?.includes('旧任务'),
    )
    expect(archivedIdx).toBeGreaterThanOrEqual(0)
    expect(list[archivedIdx].className).toContain('archived')

    await openRowMenu(host, archivedIdx)
    const labels = menuItems().map((b) => b.textContent?.trim())
    expect(labels).toContain('取消归档')
    expect(labels).not.toContain('归档')
  })
})
