import { describe, expect, it } from 'vitest'
import { applyEvent, emptyUsageState, type EventCtx } from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'

/** 同款上下文工厂；planPending 模拟 ChatView 在 plan 轮发送前挂上的待确认计划。 */
function ctx(messages: PiMsg[] = [], planPending: { task: string } | null = null): EventCtx {
  let n = 0
  return { messages, streaming: true, nextId: () => `m${n++}`, usage: emptyUsageState(), planPending }
}

function usage() {
  return {
    input: 100,
    output: 50,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 150,
    cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
  }
}

/** 一轮 plan 模式的完整事件序列：流式文本 → message_end 落定。 */
function planTurn(c: EventCtx, text: string) {
  applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } })
  applyEvent(c, { type: 'message_end', message: { role: 'assistant', content: [], usage: usage() } })
  applyEvent(c, { type: 'agent_settled' })
}

/**
 * G5 Plan 模式：plan 轮（ctx.planPending 有值）的 assistant 回复落定时
 * 解析成分步计划卡挂到该消息上；非 plan 轮与无计划格式的回复都不挂。
 */
describe('applyEvent · plan 计划卡挂载（G5）', () => {
  it('plan 轮：assistant 回复含编号计划 → 挂 plan（steps + task + pending）', () => {
    const c = ctx([], { task: '修索引死锁' })
    planTurn(c, '计划如下：\n1. 读索引模块\n2. 修死锁\n3. 补测试')
    expect(c.messages).toHaveLength(1)
    const m = c.messages[0]
    expect(m.plan).toEqual({
      steps: ['读索引模块', '修死锁', '补测试'],
      task: '修索引死锁',
      state: 'pending',
    })
    // 落定后 usage 照常挂（计划卡与 token 行不互斥）。
    expect(m.usage).toBeTruthy()
  })

  it('planPending 只消费一次：同轮第二个 message_end 不再挂计划', () => {
    const c = ctx([], { task: '任务甲' })
    planTurn(c, '1. 步骤一\n2. 步骤二')
    expect(c.messages[0].plan?.steps).toEqual(['步骤一', '步骤二'])
    // 第二轮普通回复（pendingPlan 已清空）：不挂 plan，也不落 system 提示。
    planTurn(c, '补充说明')
    expect(c.messages[1].plan).toBeUndefined()
    expect(c.messages.filter((m) => m.role === 'system')).toHaveLength(0)
  })

  it('plan 轮但回复无计划格式：不挂卡，落一条 system 明示', () => {
    const c = ctx([], { task: '讲个笑话' })
    planTurn(c, '好吧，直接说结论：没什么可计划的。')
    expect(c.messages[0].plan).toBeUndefined()
    expect(c.messages[1].role).toBe('system')
    expect(c.messages[1].text).toContain('未解析到分步计划')
  })

  it('非 plan 轮（planPending=null）：编号列表回复也不挂计划卡', () => {
    const c = ctx()
    planTurn(c, '我做了三件事：\n1. 修了 A\n2. 改了 B')
    expect(c.messages[0].plan).toBeUndefined()
    expect(c.messages.filter((m) => m.role === 'system')).toHaveLength(0)
  })

  it('回放通道不挂计划卡（journal 回放没有 pendingPlan 语义）', () => {
    const c = ctx([], null)
    c.replay = true
    planTurn(c, '1. 历史步骤')
    expect(c.messages[0].plan).toBeUndefined()
  })
})

/**
 * G6 排队/插话会往流式中的对话末尾插 user 气泡——agent_settled 与
 * message_end 不能假设「最后一条」就是目标 assistant 消息，否则光标
 * 永驻、usage 挂丢（G6 路径首次触发的潜伏 bug）。
 */
describe('applyEvent · 流式中插入 user 消息后的收尾（G6）', () => {
  it('agent_settled 收的是最后一条 assistant 的 streaming（不是末尾的 user 气泡）', () => {
    const c = ctx()
    // 一轮进行中：assistant 文本流式
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '干到一半' } })
    // G6：流式中提交排队消息，pushUser 插到末尾
    c.messages.push({ id: 'u1', role: 'user', text: '顺便把测试补上' })
    // 本轮落定
    applyEvent(c, { type: 'agent_settled' })
    const assistant = c.messages.find((m) => m.role === 'assistant')
    expect(assistant?.streaming).toBe(false)
    // user 气泡不被误伤（它本来就没有 streaming 语义）
    expect(c.messages[c.messages.length - 1].role).toBe('user')
  })

  it('message_end 的 usage 挂到该轮 assistant（末尾是 user 也不挂错）', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '干到一半' } })
    c.messages.push({ id: 'u1', role: 'user', text: '插话一句' })
    applyEvent(c, { type: 'message_end', message: { role: 'assistant', content: [], usage: usage() } })
    const assistant = c.messages.find((m) => m.role === 'assistant')
    expect(assistant?.usage).toBeTruthy()
    expect(c.messages[c.messages.length - 1].usage).toBeUndefined()
  })
})
