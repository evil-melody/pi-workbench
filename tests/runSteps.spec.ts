import { describe, expect, it } from 'vitest'
import { currentRunToolCalls } from '../src/utils/runSteps'
import type { PiEventRow } from '../src/utils/piEventKind'

const row = (kind: PiEventRow['kind'], at: number, runId?: string): PiEventRow => ({
  kind,
  title: kind,
  detail: '',
  at,
  ...(runId ? { runId } : {}),
})

describe('本轮工具调用', () => {
  it('按 runId 聚合：turn_start 晚到也不会把调用切光', () => {
    const evs = [
      row('tool_call', 10, 'r1'),
      row('tool_call', 20, 'r1'),
      row('turn_start', 30, 'r1'),
    ]
    expect(currentRunToolCalls(evs).map((e) => e.at)).toEqual([10, 20])
  })

  it('跨轮不串台：只取最后一次调用的 runId', () => {
    const evs = [
      row('tool_call', 10, 'r1'),
      row('settled', 20),
      row('tool_call', 30, 'r2'),
      row('tool_call', 40, 'r2'),
    ]
    expect(currentRunToolCalls(evs).map((e) => e.at)).toEqual([30, 40])
  })

  it('无信封老事件：按最后落定之后取，仍不依赖 turn_start', () => {
    const evs = [row('tool_call', 10), row('settled', 20), row('tool_call', 30)]
    expect(currentRunToolCalls(evs).map((e) => e.at)).toEqual([30])
  })

  it('无调用返回空；无落定则全部算本轮', () => {
    expect(currentRunToolCalls([row('turn_start', 10)])).toEqual([])
    expect(currentRunToolCalls([row('tool_call', 10), row('tool_call', 20)]).length).toBe(2)
  })
})
