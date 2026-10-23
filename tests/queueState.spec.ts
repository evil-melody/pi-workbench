import { describe, expect, it } from 'vitest'
import { readQueueUpdate } from '@/composables/piEvents'

/**
 * G6 消息队列：内核 `queue_update` 事件（steering + followUp 双队列）是
 * 队列 chip 的权威数据源——steer（本轮工具后、下次 LLM 前注入）与
 * follow_up（本轮完全结束后执行）都在入队/消费时回推。
 */
describe('readQueueUpdate', () => {
  const ev = (steering: unknown, followUp: unknown) => ({
    type: 'queue_update',
    steering,
    followUp,
  })

  it('合法形状：双数组原样解析', () => {
    expect(readQueueUpdate(ev(['插话一条'], ['排队甲', '排队乙']))).toEqual({
      steering: ['插话一条'],
      followUp: ['排队甲', '排队乙'],
    })
  })

  it('空队列：双空数组（入队被消费完的回推）', () => {
    expect(readQueueUpdate(ev([], []))).toEqual({ steering: [], followUp: [] })
  })

  it('非 queue_update 事件返回 null', () => {
    expect(readQueueUpdate({ type: 'message_end' })).toBeNull()
    expect(readQueueUpdate({ type: 'queue_update_typo' })).toBeNull()
  })

  it('形状非法（缺数组 / 数组含非字符串）返回 null，不污染队列状态', () => {
    expect(readQueueUpdate(ev(undefined, []))).toBeNull()
    expect(readQueueUpdate(ev([], null))).toBeNull()
    expect(readQueueUpdate(ev(['ok'], [42]))).toBeNull()
    expect(readQueueUpdate(ev('not-array', []))).toBeNull()
  })

  it('null / 非对象入参不抛', () => {
    expect(readQueueUpdate(null)).toBeNull()
    expect(readQueueUpdate(undefined)).toBeNull()
    expect(readQueueUpdate('queue_update')).toBeNull()
  })
})
