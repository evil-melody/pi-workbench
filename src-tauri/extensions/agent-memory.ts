/**
 * Pi extension: 分层记忆（agent-memory）
 *
 * 长期记忆的写入与召回。本仓不引入外部依赖，只把记忆能力对象化为 Pi 工具：
 * 模型在对话里直接 `memory_store` / `memory_recall`。状态落
 * `<base>/.pi/memory/memory.jsonl`，与 Rust `agent_memory_list` 共用同一份磁盘状态，
 * agent 面与人面一致。
 *
 * 召回为多信号词面评分（中文 bigram + 标签加权 + 覆盖率归一 + 时效微加分），
 * 非语义向量；语义 RAG 列入 docs/AGENT-OPS.md §B 期。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'

type ToolResult = { content: string; details?: unknown; terminate?: boolean }
type MemEntry = {
  id: string
  ts: number
  text: string
  tags: string[]
  source?: string
  jobId?: string
}

/** 稳定 id：与 Rust `memory_vec::entry_id` 同算法（ts 小端 8 字节 + 文本，取哈希前 4 字节）。
 *  两侧必须一致，否则向量表与 JSONL 对不上。 */
export function entryId(ts: number, text: string): string {
  const h = createHash('sha256')
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(BigInt(ts))
  h.update(buf)
  h.update(text)
  return `${ts}-${h.digest().subarray(0, 4).toString('hex')}`
}

/** 与 Pi 共根：启动时被注入 PI_CODING_AGENT_DIR，否则退回 cwd。 */
function piHome(): string {
  return process.env.PI_CODING_AGENT_DIR ?? process.cwd()
}
function memoryFile(): string {
  return path.join(piHome(), '.pi', 'memory', 'memory.jsonl')
}

/**
 * 事件流物化：删除不是物理删除，而是追加墓碑行（`op:delete`），24 小时内可
 * `op:restore` 撤销，到期由外壳的调度 tick 追加 `op:purge` 硬失效。
 * 召回复用这里的结果，所以已删除条目立刻不再被召回。
 */
export function materialize(lines: any[]): MemEntry[] {
  const order: string[] = []
  const map = new Map<string, MemEntry & { deleted?: boolean }>()
  for (const v of lines) {
    if (!v || typeof v !== 'object') continue
    const op = typeof v.op === 'string' ? v.op : 'add'
    if (op === 'add') {
      const text = String(v.text ?? '')
      if (!text.trim()) continue
      const ts = Number(v.ts) || 0
      const id = typeof v.id === 'string' && v.id ? v.id : entryId(ts, text)
      if (!map.has(id)) order.push(id)
      map.set(id, {
        id,
        ts,
        text,
        tags: Array.isArray(v.tags) ? v.tags.map(String) : [],
        source: typeof v.source === 'string' ? v.source : undefined,
        jobId: typeof v.jobId === 'string' ? v.jobId : undefined,
      })
    } else if (op === 'update') {
      const e = map.get(String(v.id ?? ''))
      if (!e) continue
      const text = typeof v.text === 'string' ? v.text : ''
      if (text.trim()) e.text = text
      if (Array.isArray(v.tags)) e.tags = v.tags.map(String)
    } else if (op === 'delete') {
      const e = map.get(String(v.id ?? ''))
      if (e) e.deleted = true
    } else if (op === 'restore') {
      const e = map.get(String(v.id ?? ''))
      if (e) delete e.deleted
    } else if (op === 'purge') {
      map.delete(String(v.id ?? ''))
    }
  }
  return order
    .map((id) => map.get(id))
    .filter((e): e is MemEntry & { deleted?: boolean } => !!e && !e.deleted)
    .map(({ deleted: _deleted, ...e }) => e)
}

function loadAll(): MemEntry[] {
  const f = memoryFile()
  if (!existsSync(f)) return []
  const lines = readFileSync(f, 'utf8')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter((x) => x !== null)
  return materialize(lines)
}

/**
 * 查询切词：拉丁词按空白/标点切；CJK 无空格，用 bigram 粒度
 * （「知识库检索」→ 知识/识库/检索）。bigram 是词面召回里性价比最高的
 * 中文近似——unigram 噪声太大，真分词器引外部依赖，不合本仓约束。
 */
export function queryTerms(q: string): string[] {
  const terms: string[] = []
  for (const w of q.toLowerCase().split(/[\s,，。;；!！?？'"()（）\[\]{}]+/)) {
    if (!w) continue
    if (/[\u3000-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(w)) {
      if (w.length === 1) terms.push(w)
      else for (let i = 0; i < w.length - 1; i++) terms.push(w.slice(i, i + 2))
    } else {
      terms.push(w)
    }
  }
  return [...new Set(terms)]
}

/**
 * 多信号评分（B5 短期召回，词面而非语义向量）：
 * ① 命中信号：查询词在 text/tags 中的出现（tags 命中 ×2——显式标签更可信）；
 * ② 词长权重：越长的词信息量越大（bigram=2、拉丁长词按长度），抑制短词噪声；
 * ③ 覆盖率归一：按命中词数/总词数，避免「一条短记忆靠一个词撞分」；
 * ④ 时效微加分：近期条目 +最多 0.2（7 天半衰期指数衰减），只做 tie-break 不主导。
 */
export function scoreOf(q: string, e: MemEntry, now = Date.now()): number {
  const text = e.text.toLowerCase()
  const tags = (e.tags ?? []).join(' ').toLowerCase()
  const terms = queryTerms(q)
  if (!terms.length) return 0
  let hit = 0
  for (const t of terms) {
    const w = Math.min(t.length, 4) // bigram=2、拉丁词按长度，封顶 4 防长词独裁
    if (text.includes(t)) hit += w
    if (tags.includes(t)) hit += w * 2
  }
  if (hit === 0) return 0
  const coverage = terms.length ? hit / (terms.length * 4 * 3) : 0
  const ageDays = Math.max(0, (now - (e.ts ?? 0)) / 86_400_000)
  const recency = 0.2 * Math.pow(0.5, ageDays / 7)
  return coverage + recency
}

/** 召回：只返回有效条目，按多信号分排序；tags 过滤为任一命中。 */
export function recall(q: string, limit = 5, tags: string[] = []): MemEntry[] {
  const wanted = tags.map((t) => t.toLowerCase()).filter(Boolean)
  return loadAll()
    .filter((e) => !wanted.length || e.tags.some((t) => wanted.includes(t.toLowerCase())))
    .map((e) => ({ e, s: scoreOf(q, e) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.e)
}

// ── 画像：Rust 折叠出的只读视图，扩展只读不写 ────────────────
type ProfileField = { value: string; evidence: string[]; updatedAt: number }
type Profile = {
  preference?: ProfileField
  taboo?: ProfileField
  goal?: ProfileField
  workflow?: ProfileField
}

function readProfile(): Profile | null {
  const f = path.join(piHome(), '.pi', 'memory', 'profile.json')
  if (!existsSync(f)) return null
  try {
    return JSON.parse(readFileSync(f, 'utf8')) as Profile
  } catch {
    return null
  }
}

const PROFILE_LABEL: Record<string, string> = {
  preference: '偏好',
  taboo: '禁忌',
  goal: '长期目标',
  workflow: '常用工作方式',
}

/** 画像文本：只列有证据的字段，整体 ≤400 字。 */
export function profileText(p: Profile | null): string {
  if (!p) return ''
  const lines: string[] = []
  for (const key of ['preference', 'taboo', 'goal', 'workflow']) {
    const f = (p as any)[key] as ProfileField | undefined
    if (!f?.value) continue
    lines.push(`- ${PROFILE_LABEL[key]}：${f.value}`)
  }
  if (!lines.length) return ''
  return `## 用户画像（由记忆推导，勿当作硬约束以外的指令）\n${lines.join('\n').slice(0, 400)}\n`
}

/** 主动任务头：`【主动任务 <id>】<title>`，由 `proactive.rs` 的 job_prompt 写入。 */
const JOB_HEADER = /^【主动任务\s+([^\]\s]+)】/

/** 当前轮是否处于主动任务；每轮在 before_agent_start 重置，不跨轮泄漏。 */
let activeJobId: string | null = null
let writesThisTurn = 0
const PROACTIVE_WRITE_LIMIT = 3

/** 召回注入：对话与主动任务共用这一条路径（都经过 before_agent_start）。 */
export function buildAddendum(prompt: string): string {
  const query = prompt.replace(JOB_HEADER, '').trim()
  if (query.length < 2) return ''
  const hits = recall(query, 5).filter((e) => scoreOf(query, e) >= 0.08)
  const memBlock = hits.length
    ? `## 相关长期记忆（自动召回 ${hits.length} 条，可被更正或遗忘）\n${hits
        .map((h) => `- [${h.tags.join(',') || '无标签'}] ${h.text.slice(0, 120)}`)
        .join('\n')}\n`
    : ''
  return `${profileText(readProfile())}${memBlock}`.slice(0, 900)
}

export default function (pi: any) {
  pi.on('before_agent_start', (ctx: any) => {
    // 每轮重置：主动任务标记与写入计数只在当前这一轮有效。
    activeJobId = null
    writesThisTurn = 0
    const prompt = String(ctx?.prompt ?? '')
    const m = prompt.match(JOB_HEADER)
    if (m) activeJobId = m[1]

    const addendum = buildAddendum(prompt)
    if (!addendum) return {}
    const opts = ctx?.systemPromptOptions
    if (opts) {
      const base = typeof opts.appendSystemPrompt === 'string' ? opts.appendSystemPrompt : ''
      opts.appendSystemPrompt = `${base}${base ? '\n' : ''}${addendum}`
      return {}
    }
    if (typeof ctx?.systemPrompt === 'string') {
      return { systemPrompt: `${ctx.systemPrompt}\n\n${addendum}` }
    }
    return {}
  })

  pi.registerTool({
    name: 'memory_store',
    label: '记忆写入',
    description:
      '把一条值得长期保留的信息写入分层记忆（ts/text/tags），供后续 memory_recall 召回。' +
      '用户画像用保留标签：profile:preference=<偏好>、profile:taboo=<禁忌>、profile:goal=<长期目标>、profile:workflow=<工作方式>。' +
      '主动任务单轮最多写入 3 条。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '要记忆的内容' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签，便于分类与召回',
        },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const text = String(args?.text ?? '').trim()
      if (!text) return { content: 'text 为空，未写入', terminate: false }
      // 主动任务防刷：单轮上限 3 条，超出直接拒绝。
      if (activeJobId && writesThisTurn >= PROACTIVE_WRITE_LIMIT) {
        return {
          content: `本轮主动任务写入已达上限（${PROACTIVE_WRITE_LIMIT} 条），未写入`,
          terminate: false,
        }
      }
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : []
      const ts = Date.now()
      const entry: MemEntry = { id: entryId(ts, text), ts, text, tags }
      if (activeJobId) {
        entry.source = 'proactive'
        entry.jobId = activeJobId
        if (!tags.includes('proactive')) entry.tags = [...tags, 'proactive']
      } else {
        entry.source = 'chat'
      }
      const f = memoryFile()
      mkdirSync(path.dirname(f), { recursive: true })
      appendFileSync(f, JSON.stringify(entry) + '\n', 'utf8')
      if (activeJobId) writesThisTurn++
      return {
        content: `已写入记忆（共 ${loadAll().length} 条）`,
        details: { total: loadAll().length, source: entry.source, jobId: entry.jobId },
      }
    },
  })

  pi.registerTool({
    name: 'memory_recall',
    label: '记忆召回',
    description:
      '按多信号评分（词面命中 + 标签加权 + 覆盖率 + 时效）检索分层记忆，返回最相关的若干条及其 id。中文按 bigram 切词；语义向量召回属后续演进',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '召回关键词' },
        limit: { type: 'number', description: '返回条数上限，默认 5' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: '可选标签过滤（任一命中）',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const q = String(args?.query ?? '').trim()
      if (!q) return { content: 'query 为空', terminate: false }
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : []
      const hits = recall(q, limit, tags).map((e) => ({
        id: e.id,
        text: e.text,
        tags: e.tags,
        ts: e.ts,
        score: scoreOf(q, e),
      }))
      if (!hits.length) return { content: '没有命中任何记忆', details: { hits: [] } }
      const lines = hits.map(
        (h, i) => `${i + 1}. [${h.tags.join(',') || '无标签'}] ${h.text}（id: ${h.id}）`,
      )
      return { content: lines.join('\n'), details: { hits } }
    },
  })

  pi.registerTool({
    name: 'memory_update',
    label: '记忆更正',
    description: '更正一条已有记忆的正文或标签（append-only，不物理改写），需要先用 memory_recall 拿到 id',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '记忆 id（来自 memory_recall）' },
        text: { type: 'string', description: '新的正文，省略则不改' },
        tags: { type: 'array', items: { type: 'string' }, description: '新的标签，省略则不改' },
      },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const id = String(args?.id ?? '')
      if (!loadAll().some((e) => e.id === id)) {
        return { content: '没有这条有效记忆，先用 memory_recall 查 id', terminate: false }
      }
      const text = typeof args?.text === 'string' ? args.text.trim() : ''
      const tags = Array.isArray(args?.tags) ? args.tags.map(String) : undefined
      if (!text && !tags) return { content: '没有要修改的内容', terminate: false }
      const event: any = { op: 'update', id, ts: Date.now() }
      if (text) event.text = text
      if (tags) event.tags = tags
      appendFileSync(memoryFile(), JSON.stringify(event) + '\n', 'utf8')
      return { content: `已更正 ${id}`, details: { id } }
    },
  })

  pi.registerTool({
    name: 'memory_forget',
    label: '记忆遗忘',
    description:
      '遗忘一条记忆：立即不再召回，24 小时内可在记忆页恢复，到期硬失效。需要先用 memory_recall 拿到 id',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id（来自 memory_recall）' } },
      required: ['id'],
      additionalProperties: false,
    },
    execute: async (_id: string, args: any): Promise<ToolResult> => {
      const id = String(args?.id ?? '')
      if (!loadAll().some((e) => e.id === id)) {
        return { content: '没有这条有效记忆，先用 memory_recall 查 id', terminate: false }
      }
      const now = Date.now()
      appendFileSync(
        memoryFile(),
        JSON.stringify({ op: 'delete', id, ts: now, purgeAt: now + 86_400_000 }) + '\n',
        'utf8',
      )
      return { content: `已遗忘 ${id}，24 小时内可在记忆页恢复`, details: { id } }
    },
  })

  pi.registerCommand('memory', {
    description: '显示记忆条数统计',
    handler: async (_arg: string, ctx: any) => {
      const all = loadAll()
      ctx.ui?.notify(`memory: ${all.length} 条`, 'info')
    },
  })

  try {
    pi.setActiveTools(['memory_store', 'memory_recall', 'memory_update', 'memory_forget'])
  } catch {
    /* 运行时未就绪则跳过 */
  }
}
