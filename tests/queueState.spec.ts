import { describe, expect, it } from 'vitest'
import { readQueueUpdate, queueEntries, mutateQueueSnapshot, emptyQueueState } from '@/composables/piEvents'

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

/** #69 M7：重排/编辑/删除的纯原语——clear+重发编排的底座。 */
describe('queueEntries', () => {
  it('扁平化：插话段在前，段内序号从 0', () => {
    const es = queueEntries({ steering: ['甲', '乙'], followUp: ['丙'] })
    expect(es).toEqual([
      { seg: 'steer', index: 0, body: '甲' },
      { seg: 'steer', index: 1, body: '乙' },
      { seg: 'followup', index: 0, body: '丙' },
    ])
  })

  it('空快照 → 空数组', () => {
    expect(queueEntries(emptyQueueState())).toEqual([])
  })
})

describe('mutateQueueSnapshot', () => {
  const snap = () => ({ steering: ['甲', '乙'], followUp: ['丙', '丁'] })

  it('段内移动不改段：丙→丁 换序后 steer 段原样', () => {
    const out = mutateQueueSnapshot(snap(), { kind: 'move', from: 2, to: 3 })
    expect(out).toEqual({ steering: ['甲', '乙'], followUp: ['丁', '丙'] })
  })

  it('跨段移动 = 类型转换：丙拖到甲之前变成插话', () => {
    const out = mutateQueueSnapshot(snap(), { kind: 'move', from: 2, to: 0 })
    expect(out).toEqual({ steering: ['丙', '甲', '乙'], followUp: ['丁'] })
  })

  it('插话拖到末尾变排队：乙落到丁之后', () => {
    const out = mutateQueueSnapshot(snap(), { kind: 'move', from: 1, to: 3 })
    expect(out).toEqual({ steering: ['甲'], followUp: ['丙', '丁', '乙'] })
  })

  it('原快照不被就地修改（权威态零副作用）', () => {
    const src = snap()
    mutateQueueSnapshot(src, { kind: 'move', from: 0, to: 3 })
    expect(src).toEqual(snap())
  })

  it('越界 / 原地不动 → null（调用方不发命令）', () => {
    expect(mutateQueueSnapshot(snap(), { kind: 'move', from: 0, to: 0 })).toBeNull()
    expect(mutateQueueSnapshot(snap(), { kind: 'move', from: -1, to: 2 })).toBeNull()
    expect(mutateQueueSnapshot(snap(), { kind: 'move', from: 0, to: 9 })).toBeNull()
    expect(mutateQueueSnapshot(snap(), { kind: 'remove', at: 4 })).toBeNull()
  })

  it('删除：remove 1 去掉乙', () => {
    expect(mutateQueueSnapshot(snap(), { kind: 'remove', at: 1 })).toEqual({
      steering: ['甲'],
      followUp: ['丙', '丁'],
    })
  })

  it('编辑：改正文、段不动；空文本 → null', () => {
    expect(mutateQueueSnapshot(snap(), { kind: 'edit', at: 2, body: '丙改' })).toEqual({
      steering: ['甲', '乙'],
      followUp: ['丙改', '丁'],
    })
    expect(mutateQueueSnapshot(snap(), { kind: 'edit', at: 0, body: '   ' })).toBeNull()
  })

  it('单条列表移动不炸（无邻居，保持原段）', () => {
    expect(mutateQueueSnapshot({ steering: ['独'], followUp: [] }, { kind: 'move', from: 0, to: 0 })).toBeNull()
  })
})
