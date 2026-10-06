import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 目录选择器的兜底逻辑。
 *
 * 这里守的是一个具体的线上事故：系统目录选择器一旦不返回，界面就永远停在
 * 「正在选择…」——用户看到的就是「换目录直接卡死」。所以超时复位与
 * 「取消后迟到的结果必须丢弃」这两条必须有测试兜着。
 */
const { openMock } = vi.hoisted(() => ({ openMock: vi.fn() }))
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openMock }))

const { cancelPendingPick, pickDirectoryGuarded } = await import('@/composables/useDirPicker')

beforeEach(() => {
  openMock.mockReset()
})

describe('pickDirectoryGuarded', () => {
  it('正常路径：返回所选目录且不标记超时', async () => {
    openMock.mockResolvedValue('/tmp/workspace')
    await expect(pickDirectoryGuarded(undefined, 50)).resolves.toEqual({
      dir: '/tmp/workspace',
      timedOut: false,
    })
  })

  it('用户取消（open 返回 null）视作未选择，而不是超时', async () => {
    openMock.mockResolvedValue(null)
    await expect(pickDirectoryGuarded(undefined, 50)).resolves.toEqual({
      dir: null,
      timedOut: false,
    })
  })

  it('系统选择器不返回时按超时复位，不把界面挂死在等待态', async () => {
    openMock.mockImplementation(() => new Promise(() => {}))
    await expect(pickDirectoryGuarded(undefined, 20)).resolves.toEqual({
      dir: null,
      timedOut: true,
    })
  })

  it('取消等待后，迟到的选择结果被丢弃', async () => {
    let release: (v: string) => void = () => {}
    openMock.mockImplementation(
      () =>
        new Promise<string>((resolve) => {
          release = resolve
        }),
    )
    const pending = pickDirectoryGuarded(undefined, 1000)
    cancelPendingPick()
    release('/tmp/late')
    await expect(pending).resolves.toEqual({ dir: null, timedOut: false })
  })

  it('插件报错时降级为「未选择」，不抛出', async () => {
    openMock.mockRejectedValue(new Error('dialog 不可用'))
    await expect(pickDirectoryGuarded(undefined, 50)).resolves.toEqual({
      dir: null,
      timedOut: false,
    })
  })
})
