import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  emptyUsageState,
  extractUsage,
  fmtCost,
  fmtTokens,
  humanizeProviderError,
  TOOL_PENDING,
  type EventCtx,
} from '@/composables/piEvents'
import type { PiMsg } from '@/composables/usePi'

/** 组装一个可反复复用的受理上下文；nextId 保证每次调用都拿到新 id。 */
function ctx(messages: PiMsg[] = []): EventCtx {
  let n = 0
  return { messages, streaming: true, nextId: () => `m${n++}`, usage: emptyUsageState() }
}

/** 一条真实的内核 usage 形状（字段与 @earendil-works/pi-ai 的 Usage 对齐）。 */
function usage(overrides: Record<string, unknown> = {}) {
  return {
    input: 1200,
    output: 340,
    cacheRead: 800,
    cacheWrite: 100,
    totalTokens: 2440,
    cost: { input: 0.001, output: 0.002, cacheRead: 0.0001, cacheWrite: 0.0002, total: 0.0033 },
    ...overrides,
  }
}

function textDelta(delta: string) {
  return {
    type: 'message_update',
    assistantMessageEvent: { type: 'text_delta', delta },
  }
}

describe('applyEvent · text_delta', () => {
  it('连续的 delta 合并进同一条 assistant 消息', () => {
    const c = ctx()
    applyEvent(c, textDelta('你好'))
    applyEvent(c, textDelta('，'))
    applyEvent(c, textDelta('世界'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].text).toBe('你好，世界')
    expect(c.messages[0].streaming).toBe(true)
  })

  it('同一条消息内 id 只分配一次', () => {
    const c = ctx()
    applyEvent(c, textDelta('a'))
    applyEvent(c, textDelta('b'))
    expect(c.messages[0].id).toBeDefined()
  })

  it('上一条已落定时再来 delta，开新消息而不是续写', () => {
    const c = ctx()
    applyEvent(c, textDelta('第一轮'))
    c.messages[0].streaming = false
    applyEvent(c, textDelta('第二轮'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[1].text).toBe('第二轮')
  })

  it('user 消息之后的第一条 delta 属于 assistant', () => {
    const c = ctx([{ id: 'u1', role: 'user', text: '写个 hello' }])
    applyEvent(c, textDelta('好的'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[1].role).toBe('assistant')
  })

  it('缺少 assistantMessageEvent 的记录不改动消息列表', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update' })
    expect(c.messages).toHaveLength(0)
  })
})

describe('applyEvent · 工具事件与收尾', () => {
  it('toolcall_start 插一条带 tool 标记的消息（start/delta/end 只记 start，不三行噪音）', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_start' } })
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'toolcall_delta', delta: '{"a"' } })
    expect(c.messages).toHaveLength(1)
    // start 不带 name → 中性占位，绝不显示 toolcall_start 字面量冒充工具名
    expect(c.messages[0].tool).toBe(TOOL_PENDING)
    expect(c.messages[0].text).toBe('')
  })

  it('start 无名占座 → toolcall_end 带名按 callId 回填真名', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'c1' } },
    })
    expect(c.messages[0].tool).toBe(TOOL_PENDING)
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'edit', arguments: {} },
      },
    })
    expect(c.messages[0].tool).toBe('edit')
  })

  it('start 有名时直接显示真名，不经占位', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'c1', name: 'bash' } },
    })
    expect(c.messages[0].tool).toBe('bash')
  })

  it('end 不带 id 时就近回填最近的占位 chip', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start' },
    })
    applyEvent(c, { type: 'tool_execution_start', toolCallId: '', toolName: 'read', args: {} })
    expect(c.messages[0].tool).toBe('read')
  })

  it('单独到达的 end（无占座 chip）不凭空造 chip', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', toolCall: { id: 'c9', name: 'edit', arguments: {} } },
    })
    expect(c.messages).toHaveLength(0)
  })

  it('旧版工具事件名（tool_use 等）仍插 chip，不丢兼容', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'tool_use' } })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].tool).toBe('tool_use')
  })

  it('agent_settled 把最后一条消息的 streaming 置 false', () => {
    const c = ctx()
    applyEvent(c, textDelta('施工中'))
    expect(c.messages[0].streaming).toBe(true)
    applyEvent(c, { type: 'agent_settled' })
    expect(c.messages[0].streaming).toBe(false)
  })

  it('空消息列表上收到 agent_settled 不报错', () => {
    const c = ctx()
    expect(() => applyEvent(c, { type: 'agent_settled' })).not.toThrow()
    expect(c.messages).toHaveLength(0)
  })
})

describe('applyEvent · 脏数据防御', () => {
  it.each([null, undefined, 42, 'x', [], true])('忽略 %p', (rec) => {
    const c = ctx()
    applyEvent(c, rec)
    expect(c.messages).toHaveLength(0)
  })

  it('delta 不是字符串时按空串处理，不产生 undefined', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'text_delta' } })
    expect(c.messages[0].text).toBe('')
  })
})

describe('applyEvent · token 用量（真实内核数据）', () => {
  it('message_update.usage（会话累计）镜像到 ctx.usage.last', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('hi'), usage: usage() })
    expect(c.usage.last).not.toBeNull()
    expect(c.usage.last?.input).toBe(1200)
    expect(c.usage.last?.totalTokens).toBe(2440)
    expect(c.usage.last?.cost.total).toBeCloseTo(0.0033)
  })

  it('后续累计事件覆盖 last（内核维护累计，前端只镜像）', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('a'), usage: usage() })
    applyEvent(c, { ...textDelta('b'), usage: usage({ input: 2000, totalTokens: 3240 }) })
    expect(c.usage.last?.input).toBe(2000)
    expect(c.usage.last?.totalTokens).toBe(3240)
  })

  it('message_end.message.usage 挂回最后一条 assistant 消息', () => {
    const c = ctx()
    applyEvent(c, textDelta('回答正文'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'assistant', usage: usage({ input: 10, output: 20, totalTokens: 30 }) },
    })
    expect(c.messages[0].usage?.input).toBe(10)
    expect(c.messages[0].usage?.output).toBe(20)
    expect(c.messages[0].usage?.totalTokens).toBe(30)
  })

  it('message_end 的 user 消息不挂 usage', () => {
    const c = ctx()
    applyEvent(c, textDelta('回答正文'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'user', usage: usage() },
    })
    expect(c.messages[0].usage).toBeUndefined()
  })

  it('usage 缺关键字段（非 number）时整条忽略，不产生半残数据', () => {
    const c = ctx()
    applyEvent(c, { ...textDelta('hi'), usage: { input: 'x', output: 1, totalTokens: 2 } })
    expect(c.usage.last).toBeNull()
  })

  it('extractUsage 缺失 cost 时按 0 补齐而非拒绝', () => {
    const u = extractUsage({ input: 1, output: 2, totalTokens: 3 })
    expect(u).not.toBeNull()
    expect(u?.cost.total).toBe(0)
    expect(u?.cacheRead).toBe(0)
  })
})

describe('用量格式化', () => {
  it('fmtTokens：<1000 原样、千位一位小数、百万位两位', () => {
    expect(fmtTokens(0)).toBe('0')
    expect(fmtTokens(999)).toBe('999')
    expect(fmtTokens(1234)).toBe('1.2k')
    expect(fmtTokens(1000)).toBe('1k')
    expect(fmtTokens(2_500_000)).toBe('2.50M')
  })

  it('fmtCost：小额四位小数、常规两位', () => {
    expect(fmtCost(0)).toBe('$0')
    expect(fmtCost(0.0033)).toBe('$0.0033')
    expect(fmtCost(0.5)).toBe('$0.50')
  })
})

describe("humanizeProviderError", () => {
  const RAW_429 =
    "OpenAI API error (429): {\"code\":\"\",\"message\":\"You’ve reached the API rate limit for free users.\",\"type\":\"upstream_error\"}"

  it("解析内嵌 JSON 取 message 字段", () => {
    expect(humanizeProviderError(RAW_429)).toBe(
      "You’ve reached the API rate limit for free users.",
    )
  })

  it("去掉 message 里的 request id 后缀（同一限流错误各次重试文案一致，去重才能命中）", () => {
    const raw =
      "OpenAI API error (429): {\"code\":\"\",\"message\":\"You’ve reached the API rate limit for free users. (request id: 20261012080953155597400jYVE3VHZ)\",\"type\":\"upstream_error\"}"
    expect(humanizeProviderError(raw)).toBe(
      "You’ve reached the API rate limit for free users.",
    )
  })

  it("JSON 不完整时原样返回", () => {
    const raw = "OpenAI API error (503): {\"code\":\"model_not_fo"
    expect(humanizeProviderError(raw)).toBe(raw)
  })

  it("空值 / 非字符串 → 未知错误", () => {
    expect(humanizeProviderError("")).toBe("未知错误")
    expect(humanizeProviderError(undefined)).toBe("未知错误")
    expect(humanizeProviderError(42)).toBe("未知错误")
  })

  it("无 JSON 的纯文本原样返回", () => {
    expect(humanizeProviderError("connection refused")).toBe("connection refused")
  })
})

describe("applyEvent · 模型错误可见性（空白修复）", () => {
  const RAW_429 =
    "OpenAI API error (429): {\"code\":\"\",\"message\":\"You’ve reached the API rate limit for free users.\"}"

  it("message_end 带 errorMessage 落成系统消息（humanize 后）", () => {
    const c = ctx()
    applyEvent(c, {
      type: "message_end",
      message: { role: "assistant", content: [], errorMessage: RAW_429 },
    })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].role).toBe("system")
    expect(c.messages[0].text).toBe(
      "模型请求失败：You’ve reached the API rate limit for free users.",
    )
  })

  it("重试刷屏去重：同轮相同错误只报一次；重试进度原地更新成一行", () => {
    const c = ctx()
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    applyEvent(c, { type: "auto_retry_start", attempt: 1, delayMs: 2000 })
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    applyEvent(c, { type: "auto_retry_start", attempt: 2, delayMs: 4000 })
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    applyEvent(c, { type: "auto_retry_end", attempt: 3, finalError: RAW_429 })
    expect(c.messages.map((m) => m.text)).toEqual([
      "模型请求失败：You’ve reached the API rate limit for free users.",
      "模型请求失败，自动重试中（第 2 次，4s 后）…",
    ])
  })

  it("同一限流错误带不同 request id 仍算同一条（去重不漏）", () => {
    const c = ctx()
    const mk = (rid: string) =>
      `OpenAI API error (429): {"code":"","message":"You’ve reached the API rate limit for free users. (request id: ${rid})"}`
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: mk("rid-A") } })
    applyEvent(c, { type: "auto_retry_start", attempt: 1, delayMs: 2000 })
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: mk("rid-B") } })
    expect(c.messages.filter((m) => m.text.includes("rate limit"))).toHaveLength(1)
  })

  it("不同错误各自落一条（503 → 429 不互相吞）", () => {
    const c = ctx()
    const raw503 =
      "OpenAI API error (503): {\"code\":\"model_not_found\",\"message\":\"No available channel for model agnes-2.0-flash.\"}"
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: raw503 } })
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    expect(c.messages).toHaveLength(2)
    expect(c.messages[0].text).toContain("No available channel")
    expect(c.messages[1].text).toContain("rate limit")
  })

  it("新一轮（user 消息隔开）允许再次报同类错误", () => {
    const c = ctx()
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    c.messages.push({ id: "u1", role: "user", text: "再试一次" })
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    expect(c.messages.filter((m) => m.role === "system")).toHaveLength(2)
  })

  it("usage 挂载不受 errorMessage 分支影响", () => {
    const c = ctx([{ id: "a0", role: "assistant", text: "hi" }])
    applyEvent(c, {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 10, output: 5, totalTokens: 15, cost: { total: 0.1 } },
      },
    })
    expect(c.messages[0].usage?.totalTokens).toBe(15)
  })

  it("auto_retry_end 的最终失败与首轮错误同文案时去重", () => {
    const c = ctx()
    applyEvent(c, { type: "message_end", message: { role: "assistant", content: [], errorMessage: RAW_429 } })
    applyEvent(c, { type: "auto_retry_end", attempt: 3, finalError: RAW_429 })
    expect(c.messages.filter((m) => m.text.startsWith("模型请求"))).toHaveLength(1)
  })
})

/**
 * G2：文件改动可见性。tool_execution_start（外层，带 args）与 message_update
 * 内层 toolcall_end（带 toolCall.arguments）都能折算成 fileChanges。
 */
describe('applyEvent · 文件改动（G2）', () => {
  const editStart = (path: string, id = 'c1') => ({
    type: 'tool_execution_start',
    toolCallId: id,
    toolName: 'edit',
    args: { path, edits: [{ oldText: 'a', newText: 'b' }] },
  })

  it('tool_execution_start 的 edit 参数落成 fileChanges', () => {
    const c = ctx()
    applyEvent(c, editStart('src/a.ts'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].role).toBe('assistant')
    expect(c.messages[0].fileChanges).toHaveLength(1)
    expect(c.messages[0].fileChanges![0].path).toBe('src/a.ts')
    expect(c.messages[0].fileChanges![0].tool).toBe('edit')
  })

  it('write 参数同样落盘', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'tool_execution_start',
      toolCallId: 'w1',
      toolName: 'write',
      args: { path: 'src/new.ts', content: 'x\ny' },
    })
    expect(c.messages[0].fileChanges![0].content).toBe('x\ny')
  })

  it('同一轮连续编辑归并进同一条消息', () => {
    const c = ctx()
    applyEvent(c, editStart('src/a.ts', 'c1'))
    applyEvent(c, editStart('src/b.ts', 'c2'))
    applyEvent(c, editStart('src/a.ts', 'c3'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].fileChanges).toHaveLength(3)
  })

  it('toolcall_end 内层事件同样提取，且与 tool_execution_start 按 id 去重', () => {
    const c = ctx()
    applyEvent(c, editStart('src/a.ts', 'c1'))
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'a', newText: 'b' }] } },
      },
    })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].fileChanges).toHaveLength(1)
  })

  it('toolcall_end 单独到达（无 tool_execution_start）也能提取', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c9', name: 'write', arguments: { path: 'src/w.ts', content: 'hello' } },
      },
    })
    expect(c.messages[0].fileChanges).toHaveLength(1)
    expect(c.messages[0].fileChanges![0].tool).toBe('write')
  })

  it('非 edit/write 工具不产生 fileChanges', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'tool_execution_start',
      toolCallId: 'b1',
      toolName: 'bash',
      args: { command: 'ls' },
    })
    expect(c.messages.every((m) => !m.fileChanges)).toBe(true)
  })

  it('agent_settled 后新一轮编辑另起一条消息', () => {
    const c = ctx()
    applyEvent(c, editStart('src/a.ts', 'c1'))
    applyEvent(c, { type: 'agent_settled' })
    applyEvent(c, editStart('src/b.ts', 'c2'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[0].fileChanges).toHaveLength(1)
    expect(c.messages[1].fileChanges).toHaveLength(1)
  })

  it('同一响应内：先编辑后文本，后续编辑挂到文本消息下（不另起条）', () => {
    const c = ctx()
    applyEvent(c, editStart('src/a.ts', 'c1'))
    applyEvent(c, textDelta('改完了'))
    applyEvent(c, editStart('src/b.ts', 'c2'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[0].fileChanges).toHaveLength(1)
    expect(c.messages[1].text).toBe('改完了')
    expect(c.messages[1].fileChanges).toHaveLength(1)
    expect(c.messages[1].fileChanges![0].path).toBe('src/b.ts')
  })
})
