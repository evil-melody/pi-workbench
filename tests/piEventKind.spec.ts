import { describe, expect, it } from 'vitest'
import { classifyEvent } from '@/utils/piEventKind'

describe('classifyEvent', () => {
  it('识别点分与下划线的事件名写法', () => {
    for (const type of ['turn/start', 'turn_start', 'turnStart']) {
      expect(classifyEvent({ type })?.kind).toBe('turn_start')
    }
    for (const type of ['tool/call', 'tool_call', 'toolStart']) {
      expect(classifyEvent({ type })?.kind).toBe('tool_call')
    }
    for (const type of ['tool/result', 'tool_result', 'toolEnd']) {
      expect(classifyEvent({ type })?.kind).toBe('tool_result')
    }
  })

  it('message_update 折算为 message', () => {
    expect(
      classifyEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'hi' } })?.kind,
    ).toBe('message')
  })

  it('agent_settled 与 process_exit 各归其位', () => {
    expect(classifyEvent({ type: 'agent_settled' })?.kind).toBe('settled')
    expect(classifyEvent({ type: 'process_exit' })?.kind).toBe('exit')
  })

  it('按字段形状推断工具调用（内核改事件名也能用）', () => {
    expect(classifyEvent({ tool: 'read', status: 'started' })?.kind).toBe('tool_call')
    expect(classifyEvent({ toolName: 'shell', status: 'running' })?.kind).toBe('tool_call')
    expect(classifyEvent({ name: 'grep', args: { p: 'src' } })?.kind).toBe('tool_call')
  })

  it('按字段形状推断工具结果', () => {
    expect(classifyEvent({ tool: 'read', output: 'file body', status: 'success' })?.kind).toBe('tool_result')
    expect(classifyEvent({ tool_name: 'grep', result: '2 hits' })?.kind).toBe('tool_result')
  })

  it('工具名与输出进标题与详情', () => {
    const row = classifyEvent({ tool: 'read_file', args: { path: 'a.ts' }, output: 'ok' })
    expect(row?.title).toContain('read_file')
    expect(row?.detail).toContain('a.ts')
    expect(row?.detail).toContain('ok')
  })

  it('详情超长时截断，避免刷屏', () => {
    const row = classifyEvent({ tool: 't', output: 'x'.repeat(500) })
    expect(row).not.toBeNull()
    expect((row?.detail.length ?? 0)).toBeLessThan(200)
  })

  it('非对象与空记录返回 null（不进事件流）', () => {
    expect(classifyEvent(null)).toBeNull()
    expect(classifyEvent(undefined)).toBeNull()
    // 无信息量的裸标量（不是桥定义的结束信号）直接丢弃
    expect(classifyEvent('heartbeat')).toBeNull()
    expect(classifyEvent(42)).toBeNull()
    expect(classifyEvent({})).toBeNull()
  })

  it('过程标量字符串中的结束信号折叠为 exit / settled 事件', () => {
    expect(classifyEvent('process_exit')?.kind).toBe('exit')
    expect(classifyEvent('agent_settled')?.kind).toBe('settled')
  })

  it('未知事件不静默丢弃，归入 other 但带原始 type', () => {
    const row = classifyEvent({ type: 'some_future_event', payload: 1 })
    expect(row?.kind).toBe('other')
    expect(row?.title).toContain('some_future_event')
  })

  it('识别桥侧合成的工具事件（type 为 tool_call / tool_result）', () => {
    const call = classifyEvent({
      type: 'tool_call',
      toolName: 'read',
      toolArgs: { path: '/tmp/a.rs' },
      pi_ts: 1_700_000_000_000,
      pi_seq: 3,
    })
    expect(call?.kind).toBe('tool_call')
    expect(call?.title).toBe('read')
    expect(call?.detail).toContain('a.rs')

    const done = classifyEvent({
      type: 'tool_result',
      toolName: 'read',
      toolArgs: 'fn main() {}',
      pi_ts: 1_700_000_000_050,
      pi_seq: 4,
    })
    expect(done?.kind).toBe('tool_result')
    expect(done?.title).toBe('read')
    expect(done?.detail).toContain('fn main()')
  })

  it('有 pi_ts 时以桥的到达时刻为准，避免 IPC 乱序打乱时间线', () => {
    const row = classifyEvent({ type: 'agent_settled', pi_ts: 1_700_000_000_123 })
    expect(row?.at).toBe(1_700_000_000_123)
  })

  it('无 pi_ts 时退回本地时刻', () => {
    const before = Date.now()
    const row = classifyEvent({ type: 'agent_settled' })
    expect(row?.at).toBeGreaterThanOrEqual(before)
  })
})
