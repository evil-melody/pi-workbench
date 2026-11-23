// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/composables/usePi', () => ({ IN_TAURI: true }))
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => vi.fn()),
}))

import { stopRunActivity, useRunActivity } from '@/composables/useRunActivity'
import { stopApproval, useApproval } from '@/composables/useApproval'
import { installWebLogBridge, uninstallWebLogBridge } from '@/composables/useWebLog'

describe('模块级副作用收口', () => {
  it('全局运行态在根卸载后归零', async () => {
    const { running } = useRunActivity()
    await Promise.resolve()
    running.value = true
    stopRunActivity()
    expect(running.value).toBe(false)
  })

  it('审批监听可重复启停', async () => {
    const { ensure } = useApproval()
    await ensure()
    stopApproval()
    await expect(ensure()).resolves.toBeUndefined()
    stopApproval()
  })

  it('console 桥接卸载后还原原生方法', () => {
    const warn = console.warn
    const error = console.error
    installWebLogBridge()
    expect(console.warn).not.toBe(warn)
    uninstallWebLogBridge()
    expect(console.warn).toBe(warn)
    expect(console.error).toBe(error)
  })
})
