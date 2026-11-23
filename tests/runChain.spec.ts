import { describe, expect, it } from 'vitest'
import { classifyEvent } from '@/utils/piEventKind'
import { buildRunChains, createRunChainStore, runSummary, stageLabel } from '@/utils/runChain'

/** 按桥侧信封形状造事件，走与真实流完全相同的 classifyEvent 入口。 */
function row(ev: Record<string, unknown>) {
  const out = classifyEvent({ agentId: 'main', ...ev })
  if (!out) throw new Error(`事件未归类: ${JSON.stringify(ev)}`)
  return out
}

describe('buildRunChains', () => {
  it('按 runId / spanId 收成一条链路，模型与工具各有起止', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-1', runStartedAt: 100, prompt: '修 bug', pi_ts: 100 }),
      row({
        type: 'turn_start',
        runId: 'run-1',
        spanId: 't1',
        spanKind: 'turn',
        spanStartedAt: 101,
        pi_ts: 101,
      }),
      row({
        type: 'message_start',
        message: { role: 'assistant' },
        runId: 'run-1',
        spanId: 'm1',
        parentSpanId: 't1',
        spanKind: 'model',
        spanStartedAt: 110,
        pi_ts: 110,
      }),
      row({
        type: 'tool_execution_start',
        toolCallId: 'c1',
        toolName: 'bash',
        args: { command: 'pnpm test' },
        runId: 'run-1',
        spanId: 'x1',
        parentSpanId: 'm1',
        spanKind: 'tool',
        spanStartedAt: 120,
        pi_ts: 120,
      }),
      row({
        type: 'tool_execution_end',
        toolCallId: 'c1',
        toolName: 'bash',
        isError: true,
        result: { content: [{ type: 'text', text: 'exit code 1' }] },
        runId: 'run-1',
        spanId: 'x1',
        parentSpanId: 'm1',
        spanKind: 'tool',
        spanStartedAt: 120,
        spanEndedAt: 180,
        pi_ts: 180,
      }),
      row({
        type: 'message_end',
        message: { role: 'assistant' },
        runId: 'run-1',
        spanId: 'm1',
        parentSpanId: 't1',
        spanKind: 'model',
        spanStartedAt: 110,
        spanEndedAt: 200,
        pi_ts: 200,
      }),
      row({
        type: 'agent_settled',
        runId: 'run-1',
        spanId: 't1',
        spanKind: 'turn',
        spanStartedAt: 101,
        spanEndedAt: 210,
        runEndedAt: 210,
        runStatus: 'ok',
        pi_ts: 210,
      }),
    ]

    const chains = buildRunChains(events)
    expect(chains).toHaveLength(1)
    const chain = chains[0]
    expect(chain.runId).toBe('run-1')
    expect(chain.prompt).toBe('修 bug')
    expect(chain.status).toBe('ok')
    expect(chain.degraded).toBe(false)
    expect(chain.stages.map((s) => s.kind)).toContain('model')
    const tool = chain.stages.find((s) => s.kind === 'tool')!
    expect(tool.status).toBe('failed')
    expect(tool.startedAt).toBe(120)
    expect(tool.endedAt).toBe(180)
    expect(tool.error).toContain('exit code 1')
    // 失败只落在环节上，整轮仍是落定完成；摘要要同时给出失败数。
    const summary = runSummary(chain, 999)
    expect(summary.parts.join(' ')).toContain('1 次工具失败')
    expect(summary.duration).toBe(110)
  })

  it('工具门拒绝进入 blocked，而不是混成 failed', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-2', runStartedAt: 10, prompt: 'rm', pi_ts: 10 }),
      row({
        type: 'extension_ui_request',
        id: 'g1',
        method: 'confirm',
        title: '执行 bash?',
        runId: 'run-2',
        spanId: 'g-1',
        spanKind: 'gate',
        spanStartedAt: 20,
        pi_ts: 20,
      }),
      row({
        type: 'gate_decision',
        gateId: 'g1',
        confirmed: false,
        runId: 'run-2',
        spanId: 'g-1',
        spanKind: 'gate',
        spanStartedAt: 20,
        spanEndedAt: 40,
        pi_ts: 40,
      }),
      row({ type: 'agent_settled', runId: 'run-2', runEndedAt: 50, runStatus: 'ok', pi_ts: 50 }),
    ]
    const gate = buildRunChains(events)[0].stages.find((s) => s.kind === 'gate')!
    expect(gate.status).toBe('blocked')
    expect(gate.endedAt).toBe(40)
    expect(stageLabel(gate)).toBe('工具门判定')
  })

  it('老事件没有信封时按轮次降级，不伪造 span', () => {
    const events = [
      row({ type: 'turn_start', pi_ts: 1 }),
      row({ type: 'tool_call', tool: 'read', args: { path: 'a.ts' }, pi_ts: 2 }),
      row({ type: 'tool_result', tool: 'read', output: 'ok', pi_ts: 3 }),
      row({ type: 'agent_settled', pi_ts: 4 }),
    ]
    const chain = buildRunChains(events)[0]
    expect(chain.degraded).toBe(true)
    expect(chain.stages.some((s) => s.kind === 'tool' && s.status === 'ok')).toBe(true)
  })

  it('中断时未收口的环节跟着整轮变成已中断', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-3', runStartedAt: 10, prompt: '查日志', pi_ts: 10 }),
      row({ type: 'turn_start', runId: 'run-3', spanId: 't3', spanKind: 'turn', spanStartedAt: 11, pi_ts: 11 }),
      row({
        type: 'message_start',
        message: { role: 'assistant' },
        runId: 'run-3',
        spanId: 'm3',
        parentSpanId: 't3',
        spanKind: 'model',
        spanStartedAt: 20,
        pi_ts: 20,
      }),
      row({
        type: 'tool_execution_start',
        toolCallId: 'c3',
        toolName: 'read',
        args: { path: '.pi/logs/failure.log' },
        runId: 'run-3',
        spanId: 'x3',
        parentSpanId: 'm3',
        spanKind: 'tool',
        spanStartedAt: 30,
        pi_ts: 30,
      }),
      row({ type: 'process_exit', runId: 'run-3', runEndedAt: 99, runStatus: 'interrupted', pi_ts: 99 }),
    ]
    const chain = buildRunChains(events)[0]
    expect(chain.status).toBe('cancelled')
    expect(chain.endedAt).toBe(99)
    const tool = chain.stages.find((s) => s.kind === 'tool')!
    expect(tool.status).toBe('cancelled')
    expect(tool.endedAt).toBe(99)
    // 整轮中断后不允许还有环节停在进行中。
    expect(chain.stages.filter((s) => s.endedAt == null)).toHaveLength(0)
  })

  it('专家身份进入链路，交接带上一家来源', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-e1', runStartedAt: 10, prompt: '评审', pi_ts: 10 }),
      row({
        type: 'expert_start',
        runId: 'run-e1',
        expertId: 'reviewer',
        expertName: '代码评审专家',
        allowedTools: ['read', 'grep'],
        pi_ts: 11,
      }),
      row({ type: 'agent_settled', runId: 'run-e1', runEndedAt: 20, runStatus: 'ok', pi_ts: 20 }),
      row({ type: 'run_start', runId: 'run-e2', runStartedAt: 30, prompt: '实现', pi_ts: 30 }),
      row({
        type: 'expert_start',
        runId: 'run-e2',
        expertId: 'coder',
        expertName: '实现专家',
        handoffFrom: 'reviewer',
        pi_ts: 31,
      }),
      row({ type: 'agent_settled', runId: 'run-e2', runEndedAt: 40, runStatus: 'ok', pi_ts: 40 }),
    ]
    const [first, second] = buildRunChains(events)
    const takeOver = first.stages.find((s) => s.kind === 'expert')!
    expect(takeOver.label).toBe('专家 代码评审专家 接管')
    expect(takeOver.startedAt).toBe(11)
    expect(takeOver.detail).toContain('可用工具 2 个')
    const handoff = second.stages.find((s) => s.kind === 'expert')!
    expect(handoff.label).toBe('交接给专家 实现专家')
    expect(handoff.detail).toContain('来自 reviewer')
    expect(stageLabel(handoff)).toBe('交接给专家 实现专家')
  })

  it('被下一次请求顶掉的旧 run 收口为已中断', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-a', runStartedAt: 10, prompt: '一', pi_ts: 10 }),
      row({ type: 'run_start', runId: 'run-b', runStartedAt: 100, prompt: '二', pi_ts: 100 }),
      row({ type: 'agent_settled', runId: 'run-b', runEndedAt: 150, runStatus: 'ok', pi_ts: 150 }),
    ]
    const [first, second] = buildRunChains(events)
    expect(first.status).toBe('cancelled')
    expect(first.endedAt).toBe(100)
    expect(second.status).toBe('ok')
  })

  it('节点顺序按首次出现固定，不因后到事件的时间戳更早而重排', () => {
    const events = [
      row({ type: 'run_start', runId: 'run-o', runStartedAt: 10, prompt: '顺序', pi_ts: 10 }),
      row({
        type: 'message_start',
        message: { role: 'assistant' },
        runId: 'run-o',
        spanId: 'm-o',
        spanKind: 'model',
        spanStartedAt: 20,
        pi_ts: 20,
      }),
      row({
        type: 'tool_execution_start',
        toolCallId: 'late',
        toolName: 'bash',
        args: { command: 'echo late' },
        runId: 'run-o',
        spanId: 'later',
        parentSpanId: 'm-o',
        spanKind: 'tool',
        spanStartedAt: 200,
        pi_ts: 21,
      }),
      // 后到，但 spanStartedAt 更早：位置不能往前插，否则图会在追加帧里跳。
      row({
        type: 'tool_execution_start',
        toolCallId: 'early',
        toolName: 'bash',
        args: { command: 'echo early' },
        runId: 'run-o',
        spanId: 'earlier',
        parentSpanId: 'm-o',
        spanKind: 'tool',
        spanStartedAt: 150,
        pi_ts: 22,
      }),
    ]
    const tools = buildRunChains(events)[0].stages.filter((s) => s.kind === 'tool')
    expect(tools.map((s) => s.key)).toEqual(['run-o:later', 'run-o:earlier'])
  })

  it('run_start 缺失时用信封 runStartedAt 兜底，起止时间不漂', () => {
    const events = [
      row({
        type: 'message_start',
        message: { role: 'assistant' },
        runId: 'run-z',
        runStartedAt: 50,
        spanId: 'm-z',
        spanKind: 'model',
        spanStartedAt: 120,
        pi_ts: 120,
      }),
      row({ type: 'agent_settled', runId: 'run-z', runStartedAt: 50, runEndedAt: 300, runStatus: 'ok', pi_ts: 300 }),
    ]
    const chain = buildRunChains(events)[0]
    expect(chain.startedAt).toBe(50)
    // 起始行被缓冲淘汰后仍保留「请求进入」节点，节点集合不缩水。
    expect(chain.stages[0].kind).toBe('request')
  })

  it('createRunChainStore 在事件滑出缓冲后仍保留已出现过的节点', () => {
    const all = [
      row({ type: 'run_start', runId: 'run-s', runStartedAt: 1, prompt: '长任务', pi_ts: 1 }),
      row({ type: 'kernel_start', runId: 'run-s', runStartedAt: 1, pi_ts: 1 }),
      row({
        type: 'message_start',
        message: { role: 'assistant' },
        runId: 'run-s',
        spanId: 'm-s',
        spanKind: 'model',
        spanStartedAt: 3,
        pi_ts: 3,
      }),
    ]
    for (let i = 0; i < 40; i++) {
      all.push(
        row({
          type: 'tool_execution_start',
          toolCallId: `c${i}`,
          toolName: 'bash',
          args: { command: `step ${i}` },
          runId: 'run-s',
          spanId: `x${i}`,
          spanKind: 'tool',
          spanStartedAt: 10 + i,
          pi_ts: 10 + i,
        }),
        row({
          type: 'tool_execution_end',
          toolCallId: `c${i}`,
          toolName: 'bash',
          result: { content: [{ type: 'text', text: 'ok' }] },
          runId: 'run-s',
          spanId: `x${i}`,
          spanKind: 'tool',
          spanStartedAt: 10 + i,
          spanEndedAt: 11 + i,
          pi_ts: 11 + i,
        }),
      )
    }

    const store = createRunChainStore()
    store.sync(all.slice(0, 12))
    const baseline = buildRunChains(store.sync(all.slice(0, 20)))[0].stages.map((s) => s.key)
    expect(baseline[0]).toBe('run-s:request')
    expect(baseline[1]).toBe('run-s:kernel')

    // 环形缓冲向右滑动：起始行与最早期工具行被淘汰，已出现的节点只增不减、顺序不变。
    for (let cut = 0; cut < all.length; cut += 7) {
      const buffer = all.slice(cut, cut + 300)
      const keys = buildRunChains(store.sync(buffer))[0].stages.map((s) => s.key)
      expect(keys.slice(0, baseline.length)).toEqual(baseline)
      expect(keys.length).toBeGreaterThanOrEqual(baseline.length)
    }
  })
})
