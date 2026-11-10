import { describe, expect, it } from 'vitest'
import {
  applyEvent,
  cacheHitPercent,
  emptyUsageState,
  extractUsage,
  fmtCost,
  fmtTokens,
  humanizeProviderError,
  statsSegments,
  TOOL_PENDING,
  toolPayloadText,
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

describe('applyEvent · 正文聚合（工具切碎修复）', () => {
  const toolStart = (id = 'c1', name?: string) => ({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: name ? { id, name } : { id } },
  })

  it('文本 → 工具 → 文本：聚合成一条正文 + 一条 chip（不再每段各成一个气泡）', () => {
    const c = ctx()
    applyEvent(c, textDelta('## 步骤\n'))
    applyEvent(c, toolStart('c1', 'edit'))
    applyEvent(c, textDelta('1. 先改 a\n'))
    applyEvent(c, toolStart('c2', 'bash'))
    applyEvent(c, textDelta('2. 再跑测试'))

    expect(c.messages).toHaveLength(3)
    const body = c.messages.filter((m) => !m.tool)
    const chips = c.messages.filter((m) => m.tool)
    expect(body).toHaveLength(1)
    expect(chips).toHaveLength(2)
    // 五段 delta 全落在同一条 streaming 消息里，markdown 结构不被工具调用拦腰截断
    expect(body[0].text).toBe('## 步骤\n1. 先改 a\n2. 再跑测试')
    expect(body[0].streaming).toBe(true)
    expect(chips.map((m) => m.tool)).toEqual(['edit', 'bash'])
  })

  it('工具先于文本：首个 delta 建正文，后续 delta 跳过 chip 续写同一条', () => {
    const c = ctx()
    applyEvent(c, toolStart('c1'))
    applyEvent(c, textDelta('调用完再解释'))
    applyEvent(c, textDelta('一句'))
    expect(c.messages).toHaveLength(2)
    expect(c.messages[0].tool).toBe(TOOL_PENDING)
    expect(c.messages[1].text).toBe('调用完再解释一句')
  })

  it('agent_settled 清的是正文消息的 streaming，chip 不受影响', () => {
    const c = ctx()
    applyEvent(c, textDelta('前半'))
    applyEvent(c, toolStart('c1', 'edit'))
    applyEvent(c, textDelta('后半'))
    applyEvent(c, { type: 'agent_settled' })

    const body = c.messages.find((m) => !m.tool)!
    const chip = c.messages.find((m) => m.tool)!
    expect(body.text).toBe('前半后半')
    expect(body.streaming).toBe(false)
    // chip 本来就没有 streaming 语义：收尾不该给它凭空补一个 false 光标位
    expect(chip.streaming).toBeUndefined()
  })

  it('message_end 的 usage 挂正文消息，不挂在末尾空 chip 上', () => {
    const c = ctx()
    applyEvent(c, textDelta('正文'))
    applyEvent(c, toolStart('c1', 'edit'))
    applyEvent(c, textDelta('续写'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'assistant', usage: usage({ input: 7, output: 8, totalTokens: 15 }) },
    })

    const body = c.messages.find((m) => !m.tool)!
    const chip = c.messages.find((m) => m.tool)!
    expect(body.usage?.totalTokens).toBe(15)
    expect(chip.usage).toBeUndefined()
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

/** dsh 对齐：工具行的参数 / 结果摘要。 */
describe('toolPayloadText · 工具载荷转文本', () => {
  it('字符串直接压边框（bash 的命令就是字符串）', () => {
    expect(toolPayloadText('  ls -la  ')).toBe('ls -la')
  })

  it('对象优先取 content 里的 text 块（内核 result 的常见形状）', () => {
    expect(toolPayloadText({ content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] })).toBe('ab')
  })

  it('取不到文本块时整体 JSON 序列化', () => {
    expect(toolPayloadText({ path: 'src/a.ts' })).toBe('{"path":"src/a.ts"}')
  })

  it('空参数对象返回空串（`edit · {}` 只会让工具行看起来坏了）', () => {
    expect(toolPayloadText({})).toBe('')
    expect(toolPayloadText([])).toBe('')
  })

  it('超长截断并加省略号', () => {
    const s = toolPayloadText({ path: 'x'.repeat(3000) }, 100)
    expect(s.length).toBeLessThanOrEqual(101)
    expect(s.endsWith('…')).toBe(true)
  })

  it('非对象非字符串（数字 / null）返回空串', () => {
    expect(toolPayloadText(42)).toBe('')
    expect(toolPayloadText(null)).toBe('')
  })
})

describe('applyEvent · 工具参数与结果回填（dsh 工具行）', () => {
  const start = (id: string) => ({
    type: 'message_update',
    assistantMessageEvent: { type: 'toolcall_start', toolCall: { id } },
  })

  it('toolcall_start 记下调用 id（参数/结果分属不同事件，靠它定位 chip）', () => {
    const c = ctx()
    applyEvent(c, start('c1'))
    expect(c.messages[0].toolCallId).toBe('c1')
  })

  it('0.87.1 形状：toolcall_start 顶层 {id, toolName} 直接拿到真名', () => {
    const c = ctx()
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', id: 'c1', toolName: 'bash' },
    })
    expect(c.messages[0].tool).toBe('bash')
    expect(c.messages[0].toolCallId).toBe('c1')
  })

  it('toolcall_end 的 arguments 回填成 toolArgs', () => {
    const c = ctx()
    applyEvent(c, start('c1'))
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: { id: 'c1', name: 'bash', arguments: { command: 'ls -la' } },
      },
    })
    expect(c.messages[0].tool).toBe('bash')
    expect(c.messages[0].toolArgs).toBe('{"command":"ls -la"}')
  })

  it('tool_execution_start 的 args 同样回填', () => {
    const c = ctx()
    applyEvent(c, start('c1'))
    applyEvent(c, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'bash', args: 'npm test' })
    expect(c.messages[0].toolArgs).toBe('npm test')
  })

  it('就近兜底只认仍是占位名的 chip：已回填真名的 chip 不会被错挂别人的参数', () => {
    const c = ctx()
    // 第一次调用已完整处理（真名 + 参数都在）
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_start', toolCall: { id: 'c1', name: 'read' } },
    })
    applyEvent(c, { type: 'tool_execution_start', toolCallId: 'c1', toolName: 'read', args: { path: 'a.ts' } })
    // 第二次调用的 end 不带 id（内核变体）→ 找不到占位 chip，静默跳过
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'toolcall_end', toolCall: { name: 'read', arguments: { path: 'b.ts' } } },
    })
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].toolArgs).toBe('{"path":"a.ts"}')
  })

  it('tool_execution_end 写 toolResult / toolError', () => {
    const c = ctx()
    applyEvent(c, start('c1'))
    applyEvent(c, {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'bash',
      result: { content: [{ type: 'text', text: 'total 0' }] },
      isError: false,
    })
    expect(c.messages[0].toolResult).toBe('total 0')
    expect(c.messages[0].toolError).toBeUndefined()
  })

  it('tool_execution_end 只认精确 callId：找不到 chip 就不凭空造一行', () => {
    const c = ctx()
    applyEvent(c, { type: 'tool_execution_end', toolCallId: 'zz', toolName: 'bash', result: 'x', isError: true })
    expect(c.messages).toHaveLength(0)
  })

  it('tool_execution_end 带 isError 时补真名并标记失败', () => {
    const c = ctx()
    applyEvent(c, start('c1'))
    applyEvent(c, {
      type: 'tool_execution_end',
      toolCallId: 'c1',
      toolName: 'edit',
      result: 'no such file',
      isError: true,
    })
    expect(c.messages[0].tool).toBe('edit')
    expect(c.messages[0].toolError).toBe(true)
    expect(c.messages[0].toolResult).toBe('no such file')
  })
})

describe('applyEvent · 思考（reasoning）聚合', () => {
  const think = (delta: string) => ({
    type: 'message_update',
    assistantMessageEvent: { type: 'thinking_delta', delta },
  })

  it('thinking_delta 逐段追加到当前 streaming 正文消息', () => {
    const c = ctx()
    applyEvent(c, think('先看'))
    applyEvent(c, think('一眼仓库'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].reasoning).toBe('先看一眼仓库')
    expect(c.messages[0].streaming).toBe(true)
  })

  it('思考与正文同属一条消息（一轮的 Think 与回答是一体的，拆两条会多一个头像）', () => {
    const c = ctx()
    applyEvent(c, think('想想'))
    applyEvent(c, textDelta('答案'))
    expect(c.messages).toHaveLength(1)
    expect(c.messages[0].reasoning).toBe('想想')
    expect(c.messages[0].text).toBe('答案')
  })

  it('agent_settled 收尾不清 reasoning（落定后 Think 行还得能展开看）', () => {
    const c = ctx()
    applyEvent(c, think('想过'))
    applyEvent(c, textDelta('答过'))
    applyEvent(c, { type: 'agent_settled' })
    expect(c.messages[0].streaming).toBe(false)
    expect(c.messages[0].reasoning).toBe('想过')
  })

  it('thinking_end 只兜空，不覆盖已聚合的增量', () => {
    const c = ctx()
    applyEvent(c, { type: 'message_update', assistantMessageEvent: { type: 'thinking_start' } })
    // start 无信息量：锚点消息等第一段 delta 到达时才建，否则就是一行空思考。
    expect(c.messages).toHaveLength(0)
    applyEvent(c, think('增量的'))
    applyEvent(c, think('思考'))
    applyEvent(c, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: '整段思考' },
    })
    expect(c.messages[0].reasoning).toBe('增量的思考')
    // 反例：完全没增量时（个别 provider 只在结束给全文），end 的全文才写进去。
    const c2 = ctx()
    applyEvent(c2, textDelta('正文'))
    applyEvent(c2, {
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_end', content: '  只有全文  ' },
    })
    expect(c2.messages[0].reasoning).toBe('只有全文')
  })

  it('message_end 的 thinking 内容块兜底（流式内层事件缺失时）', () => {
    const c = ctx()
    applyEvent(c, textDelta('答案'))
    applyEvent(c, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '  兜底的思考  ' },
          { type: 'text', text: '答案' },
        ],
      },
    })
    expect(c.messages[0].reasoning).toBe('兜底的思考')
  })

  it('已有增量聚合时 message_end 的 thinking 块不反向覆盖', () => {
    const c = ctx()
    applyEvent(c, think('增量思考'))
    applyEvent(c, {
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'thinking', thinking: '整块思考' }] },
    })
    expect(c.messages[0].reasoning).toBe('增量思考')
  })
})

describe('statsSegments · dsh 式统计行', () => {
  const u = (o: Record<string, unknown> = {}) =>
    extractUsage({ input: 100, output: 50, cacheRead: 300, cacheWrite: 50, totalTokens: 500, cost: { total: 0.02 }, ...o })!

  it('轮次/步数在前，token、缓存、费用依次跟随，段间由渲染层加 |', () => {
    expect(statsSegments({ turns: 3, steps: 7 }, u())).toEqual([
      '3 轮 · 7 步',
      '输入 450 tok · 输出 50 tok',
      '缓存命中 67%',
      '费用 $0.02',
    ])
  })

  it('无 usage 时只剩轮次/步数（缺数据的段不渲染）', () => {
    expect(statsSegments({ turns: 2, steps: 0 }, null)).toEqual(['2 轮 · 0 步'])
  })

  it('会话还没开始（0 轮 0 步、无 usage）→ 整行不出现', () => {
    expect(statsSegments({ turns: 0, steps: 0 }, null)).toEqual([])
  })

  it('费用为 0 时不显示费用段', () => {
    expect(statsSegments({ turns: 1, steps: 0 }, u({ cost: { total: 0 } }))).not.toContain('费用 $0')
  })

  it('cacheHitPercent：分母为 0 → null（「没数据」不等于「命中 0%」）', () => {
    expect(cacheHitPercent(u({ input: 0, cacheRead: 0, cacheWrite: 0 }))).toBeNull()
    expect(cacheHitPercent(u())).toBe(67)
  })
})
