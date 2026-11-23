import { describe, expect, it } from 'vitest'
import { shouldWarnKernelExit } from '@/composables/usePi'

describe('shouldWarnKernelExit', () => {
  it('未发消息（空闲退出）不提示：内核由后端自动拉起', () => {
    expect(shouldWarnKernelExit({ inFlight: false, sinceStop: 60_000, sinceNotice: 60_000 })).toBe(
      false,
    )
  })

  it('请求在飞且不是计划内停止：提示', () => {
    expect(shouldWarnKernelExit({ inFlight: true, sinceStop: 60_000, sinceNotice: 60_000 })).toBe(
      true,
    )
  })

  it('计划内停止（换项目 / 换模型 / 空闲回收）的伴生退出不提示', () => {
    expect(shouldWarnKernelExit({ inFlight: true, sinceStop: 800, sinceNotice: 60_000 })).toBe(
      false,
    )
  })

  it('同一次退出的第二条重复事件被去重', () => {
    expect(shouldWarnKernelExit({ inFlight: true, sinceStop: 60_000, sinceNotice: 300 })).toBe(
      false,
    )
  })
})
